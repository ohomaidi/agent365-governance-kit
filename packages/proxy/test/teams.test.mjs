/**
 * Tests for the Teams bridge — the piece that puts a vendor agent in Teams.
 *
 * Runs the real Microsoft 365 Agents SDK adapter in its anonymous mode (no
 * agent_id in the environment), with a fake vendor upstream and a fake Bot
 * Framework connector capturing what the agent sends back. What must hold:
 * a Teams message becomes ONE governed upstream call, and the reply — or the
 * refusal — lands in the conversation.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGovernanceProxy } from "../src/server.mjs";
import { createTeamsBridge, callUpstream, BLOCK_PREFIX } from "../src/teams.mjs";
import { dialects } from "../src/dialects.mjs";

let upstream, upstreamUrl, upstreamBodies, upstreamReply;
let connector, connectorUrl, sent;

function fakeGuard(triggers = []) {
  const seen = [];
  return {
    state: "ready", missing: [], seen,
    async evaluate(text, activity, opts) {
      seen.push({ text, activity, ...opts });
      const hit = triggers.find((t) => text.toLowerCase().includes(t));
      return hit ? { blocked: true, evaluated: true, reason: "Blocked by a Microsoft Purview DLP policy." } : { blocked: false, evaluated: true };
    },
  };
}

const silent = { log() {}, warn() {}, error() {} };

before(async () => {
  // Anonymous mode: the SDK must not find an app id in the environment.
  for (const k of Object.keys(process.env)) if (/^(agent_id|connections__|agent365Observability__|clientId)/i.test(k)) delete process.env[k];

  upstream = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => { upstreamBodies.push({ url: req.url, body: JSON.parse(raw) }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(upstreamReply(JSON.parse(raw)))); });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  // What Teams would be: the connector the bot posts its replies to.
  connector = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => { sent.push({ url: req.url, body: raw ? JSON.parse(raw) : null }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: `act-${sent.length}` })); });
  });
  await new Promise((r) => connector.listen(0, "127.0.0.1", r));
  connectorUrl = `http://127.0.0.1:${connector.address().port}/`;
});
after(() => { upstream?.close(); connector?.close(); });
beforeEach(() => {
  upstreamBodies = []; sent = [];
  upstreamReply = (b) => ({ choices: [{ message: { role: "assistant", content: `echo: ${b.messages[0].content}` } }] });
});

async function startBridge(guard, opts = {}) {
  const bridge = await createTeamsBridge({ upstream: upstreamUrl, guard, dialect: "openai", log: silent, agentName: "Vendor Bot", ...opts });
  const { server, listen } = createGovernanceProxy({ upstream: upstreamUrl, guard, teams: bridge.handler, log: silent });
  await listen(0, "127.0.0.1");
  return { url: `http://127.0.0.1:${server.address().port}`, bridge, close: () => new Promise((r) => server.close(r)) };
}

const activity = (text, extra = {}) => ({
  type: "message", id: "in-1", text, channelId: "emulator", serviceUrl: connectorUrl,
  conversation: { id: "conv-1" }, from: { id: "user-1", aadObjectId: "oid-user-1" }, recipient: { id: "bot-1", name: "Vendor Bot" },
  ...extra,
});
const postActivity = (url, a) => fetch(`${url}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) });
const replies = () => sent.filter((s) => /\/v3\/conversations\/conv-1\/activities/.test(s.url)).map((s) => s.body.text);

describe("dialects compose a turn and read the answer", () => {
  test("openai", () => {
    const { path, body } = dialects.openai.compose("hi", { conversationId: "c", model: "m" });
    assert.equal(path, "/v1/chat/completions"); assert.equal(body.messages[0].content, "hi"); assert.equal(body.model, "m");
    assert.equal(dialects.openai.replyText({ choices: [{ message: { content: "yo" } }] }), "yo");
  });
  test("a2a", () => {
    const { body } = dialects.a2a.compose("hi", { conversationId: "ctx" });
    assert.equal(body.method, "message/send"); assert.equal(body.params.message.parts[0].text, "hi"); assert.equal(body.params.message.contextId, "ctx");
    assert.equal(dialects.a2a.replyText({ result: { parts: [{ text: "a" }, { text: "b" }] } }), "a\nb");
  });
  test("generic", () => {
    assert.deepEqual(dialects.generic.compose("hi", { conversationId: "c" }).body, { message: "hi", conversationId: "c" });
    assert.equal(dialects.generic.replyText({ reply: "r" }), "r");
  });
  test("callUpstream surfaces upstream errors instead of replying with them", async () => {
    const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ error: { message: "quota" } }) });
    await assert.rejects(callUpstream({ upstreamBase: "http://x", d: dialects.openai, text: "hi", fetchImpl }), /quota/);
  });
});

describe("a Teams message through the bridge", () => {
  test("is governed both ways, reaches the vendor once, and the reply lands in the conversation", async () => {
    const guard = fakeGuard();
    const { url, bridge, close } = await startBridge(guard);
    try {
      assert.equal(bridge.anonymous, true, "test runs in the SDK's anonymous mode");
      const r = await postActivity(url, activity("hello vendor"));
      assert.ok(r.status < 300, `bridge answered ${r.status}`);
      assert.equal(upstreamBodies.length, 1, "exactly one upstream call");
      assert.equal(upstreamBodies[0].url, "/v1/chat/completions");
      assert.equal(upstreamBodies[0].body.messages[0].content, "hello vendor");
      assert.deepEqual(replies(), ["echo: hello vendor"]);
      assert.deepEqual(guard.seen.map((s) => s.activity), ["uploadText", "downloadText"]);
      assert.equal(guard.seen[0].userId, "oid-user-1", "attributed to the human who typed it");
      assert.equal(guard.seen[0].correlationId, "conv-1");
    } finally { await close(); }
  });

  test("a blocked prompt never reaches the vendor and the user sees the refusal in Teams", async () => {
    const guard = fakeGuard(["secret"]);
    const { url, close } = await startBridge(guard);
    try {
      await postActivity(url, activity("here is a SECRET"));
      assert.equal(upstreamBodies.length, 0, "vendor never called");
      assert.equal(replies().length, 1);
      assert.ok(replies()[0].startsWith(BLOCK_PREFIX));
    } finally { await close(); }
  });

  test("a blocked reply is withheld", async () => {
    const guard = fakeGuard(["salary"]);
    upstreamReply = () => ({ choices: [{ message: { content: "the salary is 100k" } }] });
    const { url, close } = await startBridge(guard);
    try {
      await postActivity(url, activity("tell me"));
      assert.equal(upstreamBodies.length, 1);
      assert.equal(replies().length, 1);
      assert.ok(replies()[0].startsWith(BLOCK_PREFIX));
      assert.equal(replies()[0].includes("100k"), false);
    } finally { await close(); }
  });

  test("a vendor failure is reported in the chat, not swallowed", async () => {
    const guard = fakeGuard();
    upstreamReply = () => ({ error: { message: "vendor down" } });
    const { url, close } = await startBridge(guard);
    try {
      await postActivity(url, activity("hi"));
      assert.equal(replies().length, 1);
      assert.match(replies()[0], /vendor down/);
    } finally { await close(); }
  });

  test("the proxy still passes ordinary API traffic beside the bridge", async () => {
    const guard = fakeGuard();
    const { url, close } = await startBridge(guard);
    try {
      upstreamReply = (b) => ({ choices: [{ message: { content: "api ok" } }] });
      const r = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) });
      assert.equal(r.status, 200);
      const h = await (await fetch(`${url}/_governance/health`)).json();
      assert.equal(h.teams, true);
    } finally { await close(); }
  });
});
