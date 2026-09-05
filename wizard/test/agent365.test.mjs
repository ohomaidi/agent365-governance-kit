/**
 * Tests for Agent 365 registration — the payloads that get POSTed into a
 * customer's tenant, and the order the calls happen in.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentCard, buildInstancePayload, buildBlueprintPayload,
  registerAgent, listAgentInstances, TRANSPORTS,
} from "../lib/agent365.mjs";

/** Recording stub for the injected graph caller. */
function stubGraph(responses = {}) {
  const calls = [];
  const graph = async (method, path, body) => {
    calls.push({ method, path, body });
    // Longest matching prefix wins, so "/x/{id}/addPassword" beats "/x".
    const hit = Object.entries(responses)
      .map(([pattern, value]) => {
        const [m, p] = pattern.split(" ");
        return m === method && path.startsWith(p) ? { len: p.length, value } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.len - a.len)[0];
    if (!hit) return null;
    return typeof hit.value === "function" ? hit.value(body) : hit.value;
  };
  graph.calls = calls;
  return graph;
}

describe("agent card manifest", () => {
  test("builds a valid A2A card from a name alone", () => {
    const c = buildAgentCard({ displayName: "Abbas" });
    assert.equal(c.displayName, "Abbas");
    assert.equal(c.description, "Abbas");
    assert.equal(c.protocolVersion, "1.0");
    assert.deepEqual(c.defaultInputModes, ["text/plain"]);
  });

  test("requires a display name", () => {
    assert.throws(() => buildAgentCard({}), /displayName/);
  });

  test("normalises skills and fills missing ids", () => {
    const c = buildAgentCard({ displayName: "A", skills: [{ name: "Chat" }, { id: "hr", name: "HR" }] });
    assert.equal(c.skills[0].id, "skill-1");
    assert.equal(c.skills[1].id, "hr");
  });

  test("provider is only set when an organization is given", () => {
    assert.equal("provider" in buildAgentCard({ displayName: "A" }), false);
    assert.equal(buildAgentCard({ displayName: "A", organization: "Zaatar" }).provider.organization, "Zaatar");
  });
});

describe("agent instance payload", () => {
  const card = buildAgentCard({ displayName: "Abbas" });

  test("carries the manifest inline (there is no standalone manifest create)", () => {
    const p = buildInstancePayload({ displayName: "Abbas", url: "https://a.example.com/a2a", card });
    assert.equal(p.agentCardManifest.displayName, "Abbas");
  });

  test("accepts an ARBITRARY external url — this is what makes third-party registration possible", () => {
    const p = buildInstancePayload({ displayName: "Vendor Bot", url: "https://vendor.example.com/a2a/v1", card });
    assert.equal(p.url, "https://vendor.example.com/a2a/v1");
  });

  test("rejects a non-https endpoint", () => {
    assert.throws(
      () => buildInstancePayload({ displayName: "X", url: "http://insecure.example.com", card }),
      /must be https/,
    );
  });

  test("rejects an unknown transport", () => {
    assert.throws(
      () => buildInstancePayload({ displayName: "X", url: "https://a.example.com", card, preferredTransport: "SOAP" }),
      /preferredTransport/,
    );
    for (const t of TRANSPORTS) {
      assert.doesNotThrow(() =>
        buildInstancePayload({ displayName: "X", url: "https://a.example.com", card, preferredTransport: t }));
    }
  });

  test("omits optional ids rather than sending empty strings", () => {
    const p = buildInstancePayload({ displayName: "X", url: "https://a.example.com", card });
    for (const k of ["agentIdentityBlueprintId", "managedBy", "ownerIds", "sourceAgentId", "additionalInterfaces"]) {
      assert.equal(k in p, false, `${k} should be omitted when not supplied`);
    }
  });
});

describe("blueprint payload", () => {
  test("requires a sponsor — the API rejects blueprints without one", () => {
    assert.throws(() => buildBlueprintPayload({ displayName: "B" }), /sponsor/);
  });

  test("binds sponsors as directoryObject references", () => {
    const p = buildBlueprintPayload({ displayName: "B", sponsorIds: ["abc-123"] });
    assert.deepEqual(p["sponsors@odata.bind"], [
      "https://graph.microsoft.com/beta/directoryObjects/abc-123",
    ]);
  });

  test("truncates an over-long description to the API's 1024 limit", () => {
    const p = buildBlueprintPayload({ displayName: "B", sponsorIds: ["x"], description: "d".repeat(2000) });
    assert.equal(p.description.length, 1024);
  });
});

describe("registration flow", () => {
  const base = {
    agentName: "Abbas", agentDescription: "Demo agent",
    agentUrl: "https://abbas.zaatarlabs.com/a2a", sponsorIds: ["user-1"],
  };

  test("creates blueprint → secret → instance, then verifies", async () => {
    const graph = stubGraph({
      "POST /agentIdentityBlueprints": { id: "bp-1", appId: "app-1" },
      "POST /agentIdentityBlueprints/bp-1/addPassword": { secretText: "s3cret" },
      "POST /agentRegistry/agentInstances": { id: "inst-1", agentUserId: "au-1" },
      "GET /agentRegistry/agentInstances": { id: "inst-1" },
    });

    const r = await registerAgent(graph, base);
    assert.equal(r.blueprintId, "bp-1");
    assert.equal(r.blueprintSecret, "s3cret");
    assert.equal(r.instanceId, "inst-1");
    assert.equal(r.verified, true);

    const paths = graph.calls.map((c) => `${c.method} ${c.path}`);
    assert.deepEqual(paths, [
      "POST /agentIdentityBlueprints",
      "POST /agentIdentityBlueprints/bp-1/addPassword",
      "POST /agentRegistry/agentInstances",
      "GET /agentRegistry/agentInstances/inst-1",
    ]);
  });

  test("reuses an existing blueprint instead of creating a second one", async () => {
    const graph = stubGraph({
      "GET /agentIdentityBlueprints": { id: "bp-existing", appId: "app-9" },
      "POST /agentRegistry/agentInstances": { id: "inst-2" },
      "GET /agentRegistry/agentInstances": { id: "inst-2" },
    });
    const r = await registerAgent(graph, { ...base, existingBlueprintId: "bp-existing" });
    assert.equal(r.blueprintId, "bp-existing");
    assert.equal(graph.calls.some((c) => c.method === "POST" && c.path === "/agentIdentityBlueprints"), false);
  });

  test("fails loudly when the instance POST returns no id", async () => {
    const graph = stubGraph({
      "POST /agentIdentityBlueprints": { id: "bp-1", appId: "a" },
      "POST /agentRegistry/agentInstances": {},
    });
    await assert.rejects(() => registerAgent(graph, base), /no id/);
  });

  test("flags an unverifiable registration rather than reporting success", async () => {
    const graph = stubGraph({
      "POST /agentIdentityBlueprints": { id: "bp-1", appId: "a" },
      "POST /agentRegistry/agentInstances": { id: "inst-3" },
      "GET /agentRegistry/agentInstances": null,
    });
    const r = await registerAgent(graph, base);
    assert.equal(r.verified, false);
    assert.match(r.steps.at(-1), /WARNING/);
  });

  test("registering a proxy url is what governs an unmodifiable third-party agent", async () => {
    const graph = stubGraph({
      "POST /agentIdentityBlueprints": { id: "bp-1", appId: "a" },
      "POST /agentRegistry/agentInstances": { id: "inst-4" },
      "GET /agentRegistry/agentInstances": { id: "inst-4" },
    });
    await registerAgent(graph, { ...base, agentUrl: "https://govproxy.contoso.com/vendor-bot/a2a" });
    const post = graph.calls.find((c) => c.path === "/agentRegistry/agentInstances");
    assert.equal(post.body.url, "https://govproxy.contoso.com/vendor-bot/a2a");
  });
});

describe("inventory", () => {
  test("returns an empty list rather than throwing when the registry is empty", async () => {
    assert.deepEqual(await listAgentInstances(stubGraph({})), []);
  });

  test("unwraps the OData value collection", async () => {
    const graph = stubGraph({ "GET /agentRegistry/agentInstances": { value: [{ id: "a" }, { id: "b" }] } });
    assert.equal((await listAgentInstances(graph)).length, 2);
  });
});
