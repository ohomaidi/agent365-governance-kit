/**
 * Tests for the tenant capability probe — the check that turns a mid-demo
 * failure into a red line on the first screen.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { probeTenant, EXCHANGE_ONLINE_APP, GRAPH_APP } from "../lib/capabilities.mjs";

/** Stub `az`, matching on a distinctive fragment of the argv. */
function stubAz(map) {
  return (args) => {
    const key = args.join(" ");
    for (const [frag, value] of Object.entries(map)) {
      if (key.includes(frag)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`unstubbed az call: ${key}`);
  };
}

const HEALTHY = {
  "account show": { user: { name: "admin@contoso.com" }, tenantId: "t-1" },
  "organization?$select": { value: [{ displayName: "Contoso", verifiedDomains: [{ name: "contoso.onmicrosoft.com" }] }] },
  "subscribedSkus": { value: [{ skuPartNumber: "SPE_E5" }, { skuPartNumber: "EXCHANGE_S_ENTERPRISE" }] },
  [`sp show --id ${EXCHANGE_ONLINE_APP}`]: "exo-sp-id",
  [`sp show --id ${GRAPH_APP}`]: { appRoles: [
    { value: "Content.Process.All" }, { value: "ProtectionScopes.Compute.All" },
    { value: "AgentInstance.ReadWrite.All" }, { value: "AgentIdentityBlueprint.Create" },
    { value: "AgentIdentityBlueprint.ReadWrite.All" },
  ] },
  "signed-in-user show": "me-1",
  "memberOf": { value: [{ displayName: "Global Administrator" }] },
};

const status = (r, name) => r.checks.find((c) => c.name === name)?.status;

describe("a healthy tenant", () => {
  test("passes everything and permits both stages", async () => {
    const r = await probeTenant(stubAz(HEALTHY));
    assert.equal(r.summary.fail, 0);
    assert.equal(r.canProvisionPurview, true);
    assert.equal(r.canRegisterAgent365, true);
  });
});

describe("catches the failures that would otherwise surface mid-demo", () => {
  test("an unlicensed tenant fails before anything is created", async () => {
    const r = await probeTenant(stubAz({ ...HEALTHY, subscribedSkus: { value: [] } }));
    assert.equal(status(r, "Licences"), "fail");
    assert.equal(r.canProvisionPurview, false);
  });

  test("no Exchange Online means no DLP policy — the Connect-IPPSSession trap", async () => {
    const r = await probeTenant(stubAz({
      ...HEALTHY, [`sp show --id ${EXCHANGE_ONLINE_APP}`]: new Error("ResourceNotFound"),
    }));
    assert.equal(status(r, "Exchange Online"), "fail");
    assert.match(r.checks.find((c) => c.name === "Exchange Online").fix, /Connect-IPPSSession/);
    assert.equal(r.canProvisionPurview, false);
  });

  test("a tenant with no .onmicrosoft.com domain is flagged", async () => {
    const r = await probeTenant(stubAz({
      ...HEALTHY,
      "organization?$select": { value: [{ displayName: "Contoso", verifiedDomains: [{ name: "contoso.com" }] }] },
    }));
    assert.equal(status(r, "Organisation"), "fail");
  });

  test("a tenant without the agent app roles disables Agent 365 but leaves Purview usable", async () => {
    const r = await probeTenant(stubAz({
      ...HEALTHY,
      [`sp show --id ${GRAPH_APP}`]: { appRoles: [
        { value: "Content.Process.All" }, { value: "ProtectionScopes.Compute.All" },
      ] },
    }));
    assert.equal(status(r, "Agent 365 registry"), "fail");
    assert.equal(r.canRegisterAgent365, false);
    assert.equal(r.canProvisionPurview, true, "Purview must not be blocked by an absent registry");
  });

  test("the registry endpoint is never probed with the CLI token", async () => {
    // The Azure CLI's token has no agent scopes, so probing it would report a
    // false 404 in a tenant where the feature is fully available.
    const seen = [];
    const az = (args) => {
      seen.push(args.join(" "));
      const stub = stubAz(HEALTHY);
      return stub(args);
    };
    await probeTenant(az);
    assert.equal(seen.some((c) => c.includes("agentRegistry")), false,
      "must infer availability from app roles, not from an unauthorised call");
  });

  test("missing Purview app roles are caught", async () => {
    const r = await probeTenant(stubAz({
      ...HEALTHY, [`sp show --id ${GRAPH_APP}`]: { appRoles: [{ value: "User.Read.All" }] },
    }));
    assert.equal(status(r, "Purview Graph API"), "fail");
    assert.match(r.checks.find((c) => c.name === "Purview Graph API").detail, /Content\.Process\.All/);
  });
});

describe("roles", () => {
  test("Global Administrator passes", async () => {
    const r = await probeTenant(stubAz(HEALTHY));
    assert.equal(status(r, "Directory roles"), "ok");
  });

  test("no privileged role at all is a failure", async () => {
    const r = await probeTenant(stubAz({ ...HEALTHY, memberOf: { value: [{ displayName: "Report Reader" }] } }));
    assert.equal(status(r, "Directory roles"), "fail");
  });

  test("not signed in short-circuits with a usable instruction", async () => {
    const r = await probeTenant(stubAz({ "account show": new Error("Please run az login") }));
    assert.equal(status(r, "Signed in"), "fail");
    assert.match(r.checks[0].fix, /az login/);
    assert.equal(r.checks.length, 1, "should not keep probing once we know we're anonymous");
  });
});
