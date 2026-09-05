/**
 * Behavioural tests for the Purview guard, run against a local mock Graph.
 * These cover the failure modes that matter in a customer tenant: silent
 * no-ops, fail-open on error, throttling, hangs, and audit-payload shape.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { loadConfig, createPurviewGuard, purviewState } from "../dist/index.js";

// ---------------- mock Graph ----------------
let server, base, calls, script;

function reset() {
  calls = { token: 0, scopes: 0, process: 0, bodies: [] };
  script = { processStatus: 200, processBody: {}, scopeEtag: 'W/"etag-1"', hang: false, failTimes: 0 };
}

before(async () => {
  reset();
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code, body, headers = {}) => {
        res.writeHead(code, { "content-type": "application/json", ...headers });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      if (script.hang) return; // never respond — exercises the timeout path
      if (req.url.includes("/oauth2/v2.0/token")) {
        calls.token++;
        return send(200, { access_token: "mock-token", expires_in: 3600 });
      }
      if (req.url.includes("/protectionScopes/compute")) {
        calls.scopes++;
        return send(200, {}, script.scopeEtag ? { etag: script.scopeEtag } : {});
      }
      if (req.url.includes("/processContent")) {
        calls.process++;
        calls.bodies.push(JSON.parse(raw || "{}"));
        if (script.failTimes > 0) {
          script.failTimes--;
          return send(429, { error: "throttled" }, { "retry-after": "0" });
        }
        return send(script.processStatus, script.processBody);
      }
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

function cfg(over = {}) {
  const { purview } = loadConfig({
    PURVIEW_TENANT_ID: "tenant", PURVIEW_CLIENT_ID: "client",
    PURVIEW_CLIENT_SECRET: "super-secret-value", PURVIEW_USER_ID: "user-1",
    PURVIEW_GRAPH_BASE_URL: `${base}/v1.0`, PURVIEW_LOGIN_BASE_URL: base,
    ...over,
  });
  return purview;
}

// ---------------- config defaults ----------------
describe("safe defaults", () => {
  test("guard is ENABLED unless explicitly turned off", () => {
    assert.equal(loadConfig({}).purview.enabled, true);
    assert.equal(loadConfig({ PURVIEW_ENABLED: "false" }).purview.enabled, false);
  });

  test("guard FAILS CLOSED unless explicitly opened", () => {
    assert.equal(loadConfig({}).purview.failClosed, true);
    assert.equal(loadConfig({ PURVIEW_FAIL_CLOSED: "false" }).purview.failClosed, false);
  });

  test("an empty environment is MISCONFIGURED, not 'disabled'", () => {
    assert.equal(purviewState(loadConfig({}).purview), "misconfigured");
  });
});

// ---------------- the silent no-op regression ----------------
describe("misconfiguration is never a silent allow", () => {
  test("missing config BLOCKS and names the missing vars", async () => {
    const guard = createPurviewGuard(loadConfig({}).purview);
    const v = await guard.evaluate("credit card 4111111111111111", "uploadText");
    assert.equal(v.blocked, true);
    assert.equal(v.evaluated, false);
    assert.equal(v.degraded, "misconfigured");
    assert.match(v.reason, /PURVIEW_TENANT_ID/);
    assert.deepEqual(guard.missing.includes("PURVIEW_CLIENT_SECRET"), true);
  });

  test("explicitly disabled allows, but reports why", async () => {
    const guard = createPurviewGuard(loadConfig({ PURVIEW_ENABLED: "false" }).purview);
    const v = await guard.evaluate("anything", "uploadText");
    assert.equal(v.blocked, false);
    assert.equal(v.degraded, "disabled");
    assert.equal(guard.state, "disabled");
  });
});

// ---------------- live verdicts ----------------
describe("verdicts", () => {
  test("benign content is allowed and marked evaluated", async () => {
    reset();
    const v = await createPurviewGuard(cfg()).evaluate("hello", "uploadText");
    assert.deepEqual({ blocked: v.blocked, evaluated: v.evaluated }, { blocked: false, evaluated: true });
  });

  test("a restrictAccess/block policy action blocks", async () => {
    reset();
    script.processBody = { policyActions: [{ action: "restrictAccess", restrictionAction: "block" }] };
    const v = await createPurviewGuard(cfg()).evaluate("4111111111111111", "uploadText");
    assert.equal(v.blocked, true);
    assert.equal(v.evaluated, true);
  });

  test("block detection is case-insensitive", async () => {
    reset();
    script.processBody = { policyActions: [{ action: "RestrictAccess", restrictionAction: "Block" }] };
    assert.equal((await createPurviewGuard(cfg()).evaluate("x", "uploadText")).blocked, true);
  });
});

// ---------------- resilience ----------------
describe("resilience", () => {
  test("429 is retried and then succeeds", async () => {
    reset();
    script.failTimes = 2;
    const v = await createPurviewGuard(cfg({ PURVIEW_MAX_RETRIES: "3" })).evaluate("hi", "uploadText");
    assert.equal(v.evaluated, true);
    assert.equal(calls.process, 3, "should have retried twice before succeeding");
  });

  test("a hung Graph times out and fails CLOSED", async () => {
    reset();
    script.hang = true;
    const v = await createPurviewGuard(cfg({ PURVIEW_TIMEOUT_MS: "1000", PURVIEW_MAX_RETRIES: "0" }))
      .evaluate("hi", "uploadText");
    script.hang = false;
    assert.equal(v.blocked, true, "an unreachable governance plane must not allow");
    assert.equal(v.degraded, "error");
  });

  test("fail-open is still available when explicitly chosen", async () => {
    reset();
    script.hang = true;
    const v = await createPurviewGuard(cfg({
      PURVIEW_TIMEOUT_MS: "1000", PURVIEW_MAX_RETRIES: "0", PURVIEW_FAIL_CLOSED: "false",
    })).evaluate("hi", "uploadText");
    script.hang = false;
    assert.equal(v.blocked, false);
    assert.equal(v.degraded, "error");
  });

  test("a 5xx exhausts retries and fails closed", async () => {
    reset();
    script.processStatus = 500;
    const v = await createPurviewGuard(cfg({ PURVIEW_MAX_RETRIES: "1" })).evaluate("hi", "uploadText");
    assert.equal(v.blocked, true);
    assert.equal(calls.process, 2);
  });
});

// ---------------- caching ----------------
describe("caching", () => {
  test("scopes and token are computed once across calls", async () => {
    reset();
    const guard = createPurviewGuard(cfg());
    await guard.evaluate("one", "uploadText");
    await guard.evaluate("two", "downloadText");
    await guard.evaluate("three", "uploadText");
    assert.equal(calls.scopes, 1, "protection scopes should be cached");
    assert.equal(calls.token, 1, "token should be cached");
  });

  test("a missing ETag does not force a recompute every call", async () => {
    reset();
    script.scopeEtag = null; // server returns no etag
    const guard = createPurviewGuard(cfg());
    await guard.evaluate("one", "uploadText");
    await guard.evaluate("two", "uploadText");
    assert.equal(calls.scopes, 1, "absence of an ETag must be cached too");
  });

  test("protectionScopeState=modified invalidates the cache", async () => {
    reset();
    script.processBody = { protectionScopeState: "modified" };
    const guard = createPurviewGuard(cfg());
    await guard.evaluate("one", "uploadText");
    await guard.evaluate("two", "uploadText");
    assert.equal(calls.scopes, 2);
  });
});

// ---------------- audit payload ----------------
describe("audit payload", () => {
  test("no fabricated IP address is sent", async () => {
    reset();
    await createPurviewGuard(cfg()).evaluate("hi", "uploadText");
    const dm = calls.bodies[0].contentToProcess.deviceMetadata;
    assert.equal("ipAddress" in dm, false, "must not invent 127.0.0.1");
  });

  test("a real caller IP is forwarded when supplied", async () => {
    reset();
    await createPurviewGuard(cfg()).evaluate("hi", "uploadText", { ipAddress: "203.0.113.7" });
    assert.equal(calls.bodies[0].contentToProcess.deviceMetadata.ipAddress, "203.0.113.7");
  });

  test("timestamps carry a UTC designator", async () => {
    reset();
    await createPurviewGuard(cfg()).evaluate("hi", "uploadText");
    const e = calls.bodies[0].contentToProcess.contentEntries[0];
    assert.match(e.createdDateTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("per-call user override is honoured", async () => {
    reset();
    const guard = createPurviewGuard(cfg());
    await guard.evaluate("hi", "uploadText", { userId: "other-user" });
    assert.equal(calls.scopes, 1);
  });
});

// ---------------- secret hygiene ----------------
describe("secret hygiene", () => {
  test("the client secret never reaches the error log", async () => {
    reset();
    script.processStatus = 400;
    script.processBody = { error: "bad request", client_secret: "super-secret-value" };
    const seen = [];
    const orig = console.error;
    console.error = (...a) => seen.push(a.join(" "));
    try {
      await createPurviewGuard(cfg({ PURVIEW_MAX_RETRIES: "0" })).evaluate("hi", "uploadText");
    } finally { console.error = orig; }
    const joined = seen.join("\n");
    assert.ok(joined.length > 0, "an error should have been logged");
    assert.equal(joined.includes("super-secret-value"), false, "secret leaked into logs");
    assert.match(joined, /REDACTED/);
  });
});
