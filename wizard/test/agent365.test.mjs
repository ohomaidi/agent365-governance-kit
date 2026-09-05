/**
 * Tests for Agent 365 registration — the exact flow proven live against a
 * licensed tenant: blueprint → secret → principal → identity → registration → verify.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentCard, buildRegistrationPayload, buildBlueprintPayload, slugify,
  registerAgent, deleteRegistration,
} from "../lib/agent365.mjs";

/** Graph stub: longest matching "METHOD path-prefix" wins; values may be fns or Errors. */
function stubGraph(responses = {}) {
  const calls = [];
  const graph = async (method, path, body, headers) => {
    calls.push({ method, path, body, headers });
    const hit = Object.entries(responses)
      .map(([k, v]) => { const [m, p] = k.split(" "); return m === method && path.startsWith(p) ? { len: p.length, v } : null; })
      .filter(Boolean).sort((a, b) => b.len - a.len)[0];
    if (!hit) { const e = new Error("404"); e.status = 404; e.body = {}; throw e; }
    const v = typeof hit.v === "function" ? hit.v(body, calls) : hit.v;
    if (v instanceof Error) throw v;
    return v;
  };
  graph.calls = calls;
  return graph;
}
const err = (status, message) => { const e = new Error(message); e.status = status; e.body = { error: { message } }; return e; };

const OK = {
  "GET /v1.0/applications/microsoft.graph.agentIdentityBlueprint?$filter": { value: [] },
  "POST /v1.0/applications/microsoft.graph.agentIdentityBlueprint": { id: "bp-obj", appId: "bp-app" },
  "POST /v1.0/applications/bp-obj/microsoft.graph.agentIdentityBlueprint/addPassword": { secretText: "s3cret" },
  "GET /v1.0/servicePrincipals?$filter=appId": { value: [] },
  "POST /v1.0/serviceprincipals/microsoft.graph.agentIdentityBlueprintPrincipal": { id: "prin-1" },
  "GET /beta/servicePrincipals/microsoft.graph.agentIdentity?$filter": { value: [] },
  "POST /beta/servicePrincipals/microsoft.graph.agentIdentity": { id: "ident-1" },
  "POST /beta/copilot/agentRegistrations": { id: "abbas-test-1" },
  "GET /beta/copilot/agentRegistrations/abbas-test-1": (b, calls) =>
    calls.filter((c) => c.method === "POST" && c.path === "/beta/copilot/agentRegistrations").length ? { id: "abbas-test-1" } : err(404, "Not Found"),
};
const BASE = { agentName: "Abbas Test 1", agentDescription: "demo", agentUrl: "https://abbas1.zaatarlabs.com",
               sponsorIds: ["user-1"], managedByAppId: "connector-app" };

describe("payload builders", () => {
  test("slugify makes a stable registry key", () => {
    assert.equal(slugify("Abbas Test 1"), "abbas-test-1");
    assert.equal(slugify("  HR / Finance Bot!! "), "hr-finance-bot");
  });
  test("blueprint requires a sponsor and binds users with full URLs", () => {
    assert.throws(() => buildBlueprintPayload({ displayName: "B" }), /sponsor/);
    const p = buildBlueprintPayload({ displayName: "B", sponsorIds: ["u1"], ownerIds: ["u1"] });
    assert.equal(p["@odata.type"], "Microsoft.Graph.AgentIdentityBlueprint");
    assert.deepEqual(p["sponsors@odata.bind"], ["https://graph.microsoft.com/v1.0/users/u1"]);
  });
  test("registration requires an owner or managing app, and a creator", () => {
    const card = buildAgentCard({ displayName: "A" });
    assert.throws(() => buildRegistrationPayload({ displayName: "A", createdBy: "u", card }), /ownerIds or managedByAppId/);
    assert.throws(() => buildRegistrationPayload({ displayName: "A", ownerIds: ["u"], card }), /createdBy/);
    const p = buildRegistrationPayload({ displayName: "Abbas Test 1", ownerIds: ["u"], createdBy: "u", card });
    assert.equal(p.sourceAgentId, "abbas-test-1");
    assert.match(p.sourceCreatedDateTime, /Z$/);
  });
  test("the card carries the agent's url — a proxy url governs an unmodifiable agent", () => {
    const c = buildAgentCard({ displayName: "Vendor", url: "https://govproxy.contoso.com/vendor" });
    assert.equal(c.url, "https://govproxy.contoso.com/vendor");
    assert.equal(c.skills.length, 1);
  });
});

describe("registration flow", () => {
  test("runs the six documented calls in order and verifies", async () => {
    const g = stubGraph(OK);
    const r = await registerAgent(g, BASE);
    assert.equal(r.blueprintId, "bp-obj"); assert.equal(r.blueprintAppId, "bp-app");
    assert.equal(r.blueprintSecret, "s3cret"); assert.equal(r.blueprintPrincipalId, "prin-1");
    assert.equal(r.agentIdentityId, "ident-1"); assert.equal(r.registrationId, "abbas-test-1");
    assert.equal(r.verified, true);
    const posts = g.calls.filter((c) => c.method === "POST").map((c) => c.path);
    assert.deepEqual(posts, [
      "/v1.0/applications/microsoft.graph.agentIdentityBlueprint",
      "/v1.0/applications/bp-obj/microsoft.graph.agentIdentityBlueprint/addPassword",
      "/v1.0/serviceprincipals/microsoft.graph.agentIdentityBlueprintPrincipal",
      "/beta/servicePrincipals/microsoft.graph.agentIdentity",
      "/beta/copilot/agentRegistrations",
    ]);
  });

  test("sends OData-Version: 4.0 on the calls Microsoft requires it for", async () => {
    const g = stubGraph(OK);
    await registerAgent(g, BASE);
    const bp = g.calls.find((c) => c.method === "POST" && c.path.endsWith("agentIdentityBlueprint"));
    const pr = g.calls.find((c) => c.method === "POST" && c.path.endsWith("agentIdentityBlueprintPrincipal"));
    assert.equal(bp.headers?.["OData-Version"], "4.0");
    assert.equal(pr.headers?.["OData-Version"], "4.0");
  });

  test("links the registration to the identity, blueprint and managing app", async () => {
    const g = stubGraph(OK);
    await registerAgent(g, BASE);
    const reg = g.calls.find((c) => c.method === "POST" && c.path === "/beta/copilot/agentRegistrations").body;
    assert.equal(reg.agentIdentityId, "ident-1");
    assert.equal(reg.agentIdentityBlueprintId, "bp-app");
    assert.equal(reg.managedByAppId, "connector-app");
    assert.deepEqual(reg.ownerIds, ["user-1"]);
    assert.equal(reg.agentCard.url, "https://abbas1.zaatarlabs.com");
  });

  test("re-running reuses the blueprint, principal, identity and registration — no duplicates", async () => {
    const g = stubGraph({
      ...OK,
      "GET /v1.0/applications/microsoft.graph.agentIdentityBlueprint?$filter": { value: [{ id: "bp-obj", appId: "bp-app" }] },
      "GET /v1.0/servicePrincipals?$filter=appId": { value: [{ id: "prin-1" }] },
      "GET /beta/servicePrincipals/microsoft.graph.agentIdentity?$filter": { value: [{ id: "ident-1", displayName: "Abbas Test 1" }] },
      "GET /beta/copilot/agentRegistrations/abbas-test-1": { id: "abbas-test-1" },
    });
    const r = await registerAgent(g, BASE);
    const posts = g.calls.filter((c) => c.method === "POST").map((c) => c.path);
    assert.deepEqual(posts, ["/v1.0/applications/bp-obj/microsoft.graph.agentIdentityBlueprint/addPassword"],
      "only the secret is re-minted; nothing else is created twice");
    assert.equal(r.registrationId, "abbas-test-1");
    assert.equal(r.verified, true);
  });

  test("waits out Entra replication (404 / 400 'does not exist') instead of failing", async () => {
    let attempts = 0;
    const g = stubGraph({
      ...OK,
      "POST /beta/servicePrincipals/microsoft.graph.agentIdentity": () =>
        ++attempts < 3 ? err(400, "The Agent Blueprint Principal for the Agent Blueprint does not exist") : { id: "ident-1" },
    });
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => origSetTimeout(fn, 0); // don't really wait in tests
    try {
      const r = await registerAgent(g, BASE, () => {});
      assert.equal(r.agentIdentityId, "ident-1");
      assert.equal(attempts, 3);
    } finally { globalThis.setTimeout = origSetTimeout; }
  });

  test("a non-replication error surfaces immediately", async () => {
    const g = stubGraph({ ...OK, "POST /beta/copilot/agentRegistrations": err(403, "Forbidden") });
    await assert.rejects(() => registerAgent(g, BASE), /Forbidden/);
  });

  test("flags an unverifiable registration rather than reporting success", async () => {
    const g = stubGraph({ ...OK, "GET /beta/copilot/agentRegistrations/abbas-test-1": err(404, "Not Found") });
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => origSetTimeout(fn, 0);
    try {
      const r = await registerAgent(g, BASE);
      assert.equal(r.verified, false);
      assert.match(r.steps.at(-1), /WARNING/);
    } finally { globalThis.setTimeout = origSetTimeout; }
  });

  test("requires a sponsor and a name", async () => {
    await assert.rejects(() => registerAgent(stubGraph(OK), { ...BASE, sponsorIds: [] }), /sponsor/);
    await assert.rejects(() => registerAgent(stubGraph(OK), { ...BASE, agentName: "" }), /agentName/);
  });

  test("deleteRegistration targets the Agent 365 endpoint", async () => {
    const g = stubGraph({ "DELETE /beta/copilot/agentRegistrations/abbas-test-1": null });
    await deleteRegistration(g, "abbas-test-1");
    assert.equal(g.calls[0].path, "/beta/copilot/agentRegistrations/abbas-test-1");
  });
});
