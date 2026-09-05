/**
 * Tests for the governance proxy — the path that governs an agent whose source
 * you don't control. The thing that must never happen is content reaching the
 * upstream, or a reply reaching the caller, without being evaluated.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGovernanceProxy } from "../src/server.mjs";
import { dialects, resolveDialect, collect } from "../src/dialects.mjs";

// ---------------- fakes ----------------
let upstream, upstreamUrl, upstreamHits, upstreamReply, upstreamCt;

/** Guard stub: blocks anything containing a trigger word. */
function fakeGuard(triggers = [], state = "ready") {
  const seen = [];
  return {
    state, missing: [], ready: state === "ready", seen,
    async evaluate(text, activity, opts) {
      seen.push({ text, activity, ...opts });
      const hit = triggers.find((t) => text.toLowerCase().includes(t));
      return hit
        ? { blocked: true, evaluated: true, reason: "Blocked by a Microsoft Purview data-loss-prevention policy." }
        : { blocked: false, evaluated: true };
    },
  };
}

async function startProxy(guard, extra = {}) {
  const { server, listen } = createGovernanceProxy({
    upstream: upstreamUrl, guard, log: { warn() {}, error() {} }, ...extra,
  });
  await listen(0, "127.0.0.1");
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

before(async () => {
  upstream = createServer((req, res) => {
    upstreamHits++;
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": upstreamCt });
      res.end(typeof upstreamReply === "string" ? upstreamReply : JSON.stringify(upstreamReply));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
});
after(() => upstream?.close());

beforeEach(() => {
  upstreamHits = 0;
  upstreamCt = "application/json";
  upstreamReply = { reply: "all good" };
});

// ---------------- dialects ----------------
describe("dialects", () => {
  test("dot-paths walk arrays with [*]", () => {
    assert.deepEqual(collect({ a: { b: [{ t: "x" }, { t: "y" }] } }, "a.b.[*].t"), ["x", "y"]);
  });

  test("a2a request and response text is found", () => {
    const req = { jsonrpc: "2.0", method: "message/send", params: { message: { parts: [{ kind: "text", text: "hi" }] } } };
    assert.deepEqual(dialects.a2a.extractRequest(req), ["hi"]);
    assert.deepEqual(dialects.a2a.extractResponse({ result: { parts: [{ text: "yo" }] } }), ["yo"]);
  });

  test("openai request and response text is found", () => {
    assert.deepEqual(dialects.openai.extractRequest({ messages: [{ role: "user", content: "hi" }] }), ["hi"]);
    assert.deepEqual(dialects.openai.extractResponse({ choices: [{ message: { content: "yo" } }] }), ["yo"]);
  });

  test("auto-detection picks the right dialect", () => {
    assert.equal(resolveDialect("auto", { jsonrpc: "2.0" }).name, "a2a");
    assert.equal(resolveDialect("auto", { messages: [] }).name, "openai");
    assert.equal(resolveDialect("auto", { message: "hi" }).name, "generic");
  });

  test("an unknown dialect name is rejected rather than silently ignored", () => {
    assert.throws(() => resolveDialect("soap", {}), /unknown dialect/);
  });
});

// ---------------- enforcement ----------------
describe("enforcement", () => {
  test("benign traffic reaches the upstream and comes back", async () => {
    const p = await startProxy(fakeGuard());
    const r = await post(`${p.url}/chat`, { message: "hello" });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { reply: "all good" });
    assert.equal(upstreamHits, 1);
    await p.close();
  });

  test("a blocked prompt NEVER reaches the upstream", async () => {
    const p = await startProxy(fakeGuard(["salary"]));
    const r = await post(`${p.url}/chat`, { message: "what is the salary of Anna?" });
    assert.equal(r.status, 403);
    assert.equal(upstreamHits, 0, "the vendor agent must never see blocked content");
    await p.close();
  });

  test("a blocked reply is withheld from the caller", async () => {
    upstreamReply = { reply: "Anna Davis earns 88000" };
    const p = await startProxy(fakeGuard(["88000"]));
    const r = await post(`${p.url}/chat`, { message: "who earns most?" });
    assert.equal(r.status, 403);
    assert.equal(upstreamHits, 1);
    assert.equal(JSON.stringify(await r.json()).includes("88000"), false, "leaked blocked content");
    await p.close();
  });

  test("a fail-closed guard blocks even though the proxy itself is fine", async () => {
    const guard = {
      state: "misconfigured", missing: ["PURVIEW_TENANT_ID"], ready: false,
      async evaluate() { return { blocked: true, evaluated: false, degraded: "misconfigured", reason: "Governance unavailable." }; },
    };
    const p = await startProxy(guard);
    const r = await post(`${p.url}/chat`, { message: "hello" });
    assert.equal(r.status, 403);
    assert.equal(upstreamHits, 0);
    await p.close();
  });

  test("every prompt part is evaluated, not just the first", async () => {
    const guard = fakeGuard();
    const p = await startProxy(guard, { dialect: "a2a" });
    await post(`${p.url}/`, {
      jsonrpc: "2.0", id: 1, method: "message/send",
      params: { message: { parts: [{ text: "one" }, { text: "two" }, { text: "three" }] } },
    });
    const inbound = guard.seen.filter((s) => s.activity === "uploadText").map((s) => s.text);
    assert.deepEqual(inbound, ["one", "two", "three"]);
    await p.close();
  });
});

// ---------------- refusal shapes ----------------
describe("refusals match the caller's protocol", () => {
  test("a2a refuses inside a JSON-RPC error envelope", async () => {
    const p = await startProxy(fakeGuard(["secret"]), { dialect: "a2a" });
    const r = await post(`${p.url}/`, {
      jsonrpc: "2.0", id: 42, method: "message/send",
      params: { message: { parts: [{ text: "the secret is x" }] } },
    });
    assert.equal(r.status, 200, "JSON-RPC carries errors in the envelope, not the HTTP status");
    const j = await r.json();
    assert.equal(j.id, 42);
    assert.equal(j.error.code, -32001);
    assert.match(j.error.message, /Purview/);
    await p.close();
  });

  test("openai refuses with a policy_violation error", async () => {
    const p = await startProxy(fakeGuard(["secret"]), { dialect: "openai" });
    const r = await post(`${p.url}/v1/chat/completions`, { model: "x", messages: [{ role: "user", content: "the secret" }] });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error.type, "policy_violation");
    await p.close();
  });
});

// ---------------- attribution + plumbing ----------------
describe("attribution and plumbing", () => {
  test("caller identity and correlation id reach Purview", async () => {
    const guard = fakeGuard();
    const p = await startProxy(guard);
    await post(`${p.url}/chat`, { message: "hi" }, {
      "x-agent-user-id": "user-object-id", "x-correlation-id": "thread-7", "x-forwarded-for": "203.0.113.9, 10.0.0.1",
    });
    const first = guard.seen[0];
    assert.equal(first.userId, "user-object-id");
    assert.equal(first.correlationId, "thread-7");
    assert.equal(first.ipAddress, "203.0.113.9");
    await p.close();
  });

  test("prompt and reply share a correlation id so the thread groups", async () => {
    const guard = fakeGuard();
    const p = await startProxy(guard);
    await post(`${p.url}/chat`, { message: "hi" });
    const ids = new Set(guard.seen.map((s) => s.correlationId));
    assert.equal(ids.size, 1);
    assert.equal(guard.seen.map((s) => s.activity).join(","), "uploadText,downloadText");
    await p.close();
  });

  test("upstream status and headers are preserved", async () => {
    upstreamCt = "application/json; charset=utf-8";
    const p = await startProxy(fakeGuard());
    const r = await post(`${p.url}/chat`, { message: "hi" });
    assert.match(r.headers.get("content-type"), /application\/json/);
    await p.close();
  });

  test("an unreachable upstream is a 502, not a silent pass", async () => {
    const { server, listen } = createGovernanceProxy({
      upstream: "http://127.0.0.1:1", guard: fakeGuard(), log: { warn() {}, error() {} },
    });
    await listen(0, "127.0.0.1");
    const url = `http://127.0.0.1:${server.address().port}`;
    const r = await post(`${url}/chat`, { message: "hi" });
    assert.equal(r.status, 502);
    await new Promise((res) => server.close(res));
  });

  test("an oversized body is refused rather than buffered", async () => {
    const p = await startProxy(fakeGuard(), { maxBodyBytes: 200 });
    const r = await post(`${p.url}/chat`, { message: "x".repeat(5000) });
    assert.equal(r.status, 413);
    assert.equal(upstreamHits, 0);
    await p.close();
  });
});

// ---------------- operability ----------------
describe("health endpoint", () => {
  test("reports 200 and governing:true when the guard is ready", async () => {
    const p = await startProxy(fakeGuard());
    const j = await (await fetch(`${p.url}/_governance/health`)).json();
    assert.equal(j.governing, true);
    assert.equal(j.guard, "ready");
    await p.close();
  });

  test("reports 503 when the guard is not governing", async () => {
    const p = await startProxy(fakeGuard([], "disabled"));
    const r = await fetch(`${p.url}/_governance/health`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).governing, false);
    await p.close();
  });

  test("counts what it blocked", async () => {
    const p = await startProxy(fakeGuard(["nope"]));
    await post(`${p.url}/chat`, { message: "nope" });
    await post(`${p.url}/chat`, { message: "fine" });
    const j = await (await fetch(`${p.url}/_governance/health`)).json();
    assert.equal(j.stats.blockedIn, 1);
    await p.close();
  });
});
