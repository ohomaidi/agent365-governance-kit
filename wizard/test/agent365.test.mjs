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
  "GET /v1.0/applications/bp-obj?$select=identifierUris,api": { identifierUris: [], api: { oauth2PermissionScopes: [] } },
  "PATCH /v1.0/applications/bp-obj": null,
  // stateful: reports whatever has been POSTed so far, like Graph does
  "GET /beta/applications/bp-obj/microsoft.graph.agentIdentityBlueprint/inheritablePermissions": (b, calls) => ({
    value: calls.filter((c) => c.method === "POST" && c.path.endsWith("/inheritablePermissions") && !c.body?.inheritableRoles?.reject)
                .map((c) => ({ resourceAppId: c.body.resourceAppId })) }),
  "POST /beta/applications/bp-obj/microsoft.graph.agentIdentityBlueprint/inheritablePermissions": { "@odata.type": "#microsoft.graph.inheritablePermission" },
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
      "/beta/applications/bp-obj/microsoft.graph.agentIdentityBlueprint/inheritablePermissions",
      "/beta/applications/bp-obj/microsoft.graph.agentIdentityBlueprint/inheritablePermissions",
      "/beta/applications/bp-obj/microsoft.graph.agentIdentityBlueprint/inheritablePermissions",
      "/beta/servicePrincipals/microsoft.graph.agentIdentity",
      "/beta/copilot/agentRegistrations",
    ]);
  });

  test("the identity is created after the inheritable permissions, and the consent hook runs in between", async () => {
    const g = stubGraph(OK);
    const seen = [];
    await registerAgent(g, { ...BASE, beforeIdentity: async (r) => { seen.push({ principal: r.blueprintPrincipalId, identity: r.agentIdentityId, posts: g.calls.filter((c) => c.method === "POST").map((c) => c.path) }); } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].principal, "prin-1", "blueprint principal exists when the hook runs");
    assert.equal(seen[0].identity, "", "identity does not exist yet when the hook runs");
    assert.ok(seen[0].posts.some((p) => p.endsWith("/inheritablePermissions")), "inheritable permissions were set before the hook");
    assert.equal(seen[0].posts.some((p) => p.endsWith("microsoft.graph.agentIdentity")), false);
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
      "GET /beta/applications/bp-obj/microsoft.graph.agentIdentityBlueprint/inheritablePermissions": { value: [
        { resourceAppId: "5a807f24-c9de-44ee-a3a7-329e88a00ffc" }, { resourceAppId: "9b975845-388f-4429-889e-eab1ef63949c" }, { resourceAppId: "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1" } ] },
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

describe("inheritable permissions", () => {
  test("every Agent 365 resource is made inheritable — allAllowed on scopes and roles, like Microsoft's CLI", async () => {
    const g = stubGraph(OK);
    const r = await registerAgent(g, BASE);
    const posts = g.calls.filter((c) => c.method === "POST" && c.path.endsWith("/inheritablePermissions"));
    assert.equal(posts.length, 3);
    for (const p of posts) {
      assert.equal(p.body.inheritableScopes["@odata.type"], "microsoft.graph.allAllowedScopes");
      assert.equal(p.body.inheritableRoles["@odata.type"], "microsoft.graph.allAllowedRoles");
    }
    assert.ok(posts.some((p) => p.body.resourceAppId === "9b975845-388f-4429-889e-eab1ef63949c"), "Observability API is inheritable");
    assert.equal(r.steps.filter((s) => s.startsWith("inheritable permission:")).length, 3);
  });
  test("falls back to enumerated scopes when the tenant rejects inheritableRoles", async () => {
    let n = 0;
    const g = stubGraph({ ...OK, "POST /beta/applications/bp-obj/microsoft.graph.agentIdentityBlueprint/inheritablePermissions": (body) =>
      body.inheritableRoles ? err(400, "Property 'inheritableRoles' does not exist") : { ok: true } });
    const r = await registerAgent(g, BASE);
    const posts = g.calls.filter((c) => c.method === "POST" && c.path.endsWith("/inheritablePermissions"));
    assert.equal(posts.length, 6, "each resource: one rejected attempt, one fallback");
    assert.equal(r.steps.filter((s) => s.startsWith("WARNING")).length, 0);
  });
  test("an already-present inheritable permission is not an error", async () => {
    const all = { value: [{ resourceAppId: "5a807f24-c9de-44ee-a3a7-329e88a00ffc" }, { resourceAppId: "9b975845-388f-4429-889e-eab1ef63949c" }, { resourceAppId: "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1" }] };
    const g = stubGraph({ ...OK, "GET /beta/applications/bp-obj/microsoft.graph.agentIdentityBlueprint/inheritablePermissions": all });
    const r = await registerAgent(g, BASE);
    assert.equal(r.verified, true);
    assert.equal(r.steps.some((s) => s.startsWith("WARNING")), false);
    assert.equal(g.calls.some((c) => c.method === "POST" && c.path.endsWith("/inheritablePermissions")), false);
  });
  test("a permission not yet listed is reported after polling, not hidden behind the 201", async () => {
    // POST succeeds for all three, but the read-back only ever shows one.
    const g = stubGraph({ ...OK, "GET /beta/applications/bp-obj/microsoft.graph.agentIdentityBlueprint/inheritablePermissions": (b, calls) => ({
      value: calls.some((c) => c.method === "POST" && c.path.endsWith("/inheritablePermissions")) ? [{ resourceAppId: "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1" }] : [] }) });
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => origSetTimeout(fn, 0); // don't really wait
    let r; try { r = await registerAgent(g, BASE); } finally { globalThis.setTimeout = origSetTimeout; }
    const w = r.steps.find((s) => s.includes("not yet visible on read-back"));
    assert.ok(w, "shortfall is reported"); assert.match(w, /Messaging Bot API/); assert.match(w, /Observability API/);
    const reads = g.calls.filter((c) => c.method === "GET" && c.path.endsWith("/inheritablePermissions")).length;
    assert.ok(reads >= 5, `polls before concluding (got ${reads} reads)`);
  });
});


describe("identifier URI for Teams SSO", () => {
  test("sets api://botid-<appId> and an access_as_user scope on a new blueprint", async () => {
    const g = stubGraph(OK);
    const r = await registerAgent(g, BASE);
    const patch = g.calls.find((c) => c.method === "PATCH" && c.path === "/v1.0/applications/bp-obj");
    assert.ok(patch, "blueprint is patched");
    assert.deepEqual(patch.body.identifierUris, ["api://botid-bp-app"]);
    assert.equal(patch.body.api.oauth2PermissionScopes[0].value, "access_as_user");
    assert.equal(patch.headers?.["OData-Version"], "4.0");
    assert.equal(r.identifierUri, "api://botid-bp-app");
  });
  test("is skipped when the identifier URI is already present", async () => {
    const g = stubGraph({ ...OK, "GET /v1.0/applications/bp-obj?$select=identifierUris,api": { identifierUris: ["api://botid-bp-app"], api: { oauth2PermissionScopes: [] } } });
    await registerAgent(g, BASE);
    assert.equal(g.calls.some((c) => c.method === "PATCH"), false);
  });
});
