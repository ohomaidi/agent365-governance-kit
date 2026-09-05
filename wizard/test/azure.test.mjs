/**
 * Tests for the Azure target — ARM is stubbed with the same contract the real
 * client honours. What must hold: settings are MERGED (a customer's existing
 * App Settings survive), secrets go to Key Vault or Container App secrets when
 * asked, and the endpoint check only passes on an authenticated 4xx.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { linesToSettings, listSubscriptions, listWebApps, listContainerApps, setAppSettings, restartWebApp,
         setContainerAppEnv, storeSecretsInKeyVault, grantKeyVaultSecretsUser, ensureProxyWebApp, waitForEndpoint, SECRET_KEYS } from "../lib/azure.mjs";

function stubArm(routes) {
  const calls = [];
  const arm = async (method, path, body) => {
    calls.push({ method, path: path.split("?")[0], body });
    for (const [m, frag, val] of routes) {
      if (m === method && path.includes(frag)) {
        if (val instanceof Error) throw val;
        return typeof val === "function" ? val({ method, path, body }) : val;
      }
    }
    throw Object.assign(new Error(`unstubbed ${method} ${path}`), { status: 500 });
  };
  arm.calls = calls;
  return arm;
}
const err = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const APP = { kind: "webapp", id: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/hr", name: "hr" };

describe("settings", () => {
  test(".env lines become a flat settings map, comments dropped", () => {
    assert.deepEqual(linesToSettings(["# c", "A=1", "", "B=x=y"]), { A: "1", B: "x=y" });
  });
  test("the secret keys are exactly the three credentials", () => {
    assert.deepEqual([...SECRET_KEYS].sort(), ["PURVIEW_CLIENT_SECRET", "agent365Observability__clientSecret", "connections__service_connection__settings__clientSecret"]);
  });
});

describe("discovery", () => {
  test("lists enabled subscriptions, web apps (not function apps) and container apps with hosts", async () => {
    const arm = stubArm([
      ["GET", "/subscriptions?", { value: [{ subscriptionId: "s1", displayName: "Prod", state: "Enabled" }, { subscriptionId: "s2", displayName: "Old", state: "Disabled" }] }],
      ["GET", "Microsoft.Web/sites", { value: [
        { id: "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Web/sites/hr", name: "hr", kind: "app,linux", location: "westeurope", properties: { defaultHostName: "hr.azurewebsites.net", state: "Running" } },
        { id: "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Web/sites/fn", name: "fn", kind: "functionapp,linux", location: "westeurope", properties: {} } ] }],
      ["GET", "Microsoft.App/containerApps", { value: [{ id: "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.App/containerApps/ca", name: "ca", location: "westeurope", properties: { configuration: { ingress: { fqdn: "ca.region.azurecontainerapps.io", external: true } }, managedEnvironmentId: "/env" } }] }],
    ]);
    assert.deepEqual(await listSubscriptions(arm), [{ id: "s1", name: "Prod" }]);
    const apps = await listWebApps(arm, "s1");
    assert.equal(apps.length, 1); assert.equal(apps[0].resourceGroup, "rg"); assert.equal(apps[0].host, "hr.azurewebsites.net");
    const cas = await listContainerApps(arm, "s1");
    assert.equal(cas[0].host, "ca.region.azurecontainerapps.io"); assert.equal(cas[0].external, true);
  });
});

describe("App Service", () => {
  test("merges the kit's keys into existing App Settings and restarts", async () => {
    const arm = stubArm([
      ["POST", "/config/appsettings/list", { properties: { EXISTING: "keep", PURVIEW_ENABLED: "false" } }],
      ["PUT", "/config/appsettings", ({ body }) => body],
      ["POST", "/restart", null],
    ]);
    const written = await setAppSettings(arm, APP, { PURVIEW_ENABLED: "true", PURVIEW_TENANT_ID: "t" });
    const put = arm.calls.find((c) => c.method === "PUT");
    assert.deepEqual(put.body.properties, { EXISTING: "keep", PURVIEW_ENABLED: "true", PURVIEW_TENANT_ID: "t" });
    assert.deepEqual(written, ["PURVIEW_ENABLED", "PURVIEW_TENANT_ID"]);
    assert.match(await restartWebApp(arm, APP), /restarted/);
  });
});

describe("Container Apps", () => {
  test("upserts env on the first container, secrets by secretRef, keeps other env", async () => {
    const cur = { properties: { configuration: { secrets: [{ name: "old", value: "o" }] }, template: { containers: [{ name: "agent", image: "img", env: [{ name: "KEEP", value: "1" }, { name: "PURVIEW_ENABLED", value: "false" }] }] } } };
    const arm = stubArm([["GET", "/containerApps/ca", cur], ["PATCH", "/containerApps/ca", ({ body }) => body]]);
    await setContainerAppEnv(arm, { id: "/x/containerApps/ca", name: "ca" }, { PURVIEW_ENABLED: "true", PURVIEW_CLIENT_SECRET: "s3cret" });
    const patch = arm.calls.find((c) => c.method === "PATCH").body.properties;
    const env = patch.template.containers[0].env;
    assert.deepEqual(env.find((e) => e.name === "KEEP"), { name: "KEEP", value: "1" });
    assert.deepEqual(env.find((e) => e.name === "PURVIEW_ENABLED"), { name: "PURVIEW_ENABLED", value: "true" });
    assert.equal(env.find((e) => e.name === "PURVIEW_CLIENT_SECRET").secretRef, "purview-client-secret");
    assert.ok(patch.configuration.secrets.some((s) => s.name === "purview-client-secret" && s.value === "s3cret"));
    assert.ok(patch.configuration.secrets.some((s) => s.name === "old"), "existing secrets kept");
  });
});

describe("Key Vault", () => {
  test("stores only secret keys and returns App Settings references without the version", async () => {
    const kv = async (method, path, body) => ({ id: `https://v.vault.azure.net${path}/0123456789abcdef0123456789abcdef`, value: body.value });
    const refs = await storeSecretsInKeyVault(kv, { PURVIEW_CLIENT_SECRET: "s", PURVIEW_TENANT_ID: "t" }, "hr");
    assert.deepEqual(Object.keys(refs), ["PURVIEW_CLIENT_SECRET"]);
    assert.equal(refs.PURVIEW_CLIENT_SECRET, "@Microsoft.KeyVault(SecretUri=https://v.vault.azure.net/secrets/hr-PURVIEW-CLIENT-SECRET)");
  });
  test("role assignment is deterministic and a 409 counts as present", async () => {
    const arm = stubArm([["PUT", "/roleAssignments/", err(409)]]);
    assert.equal(await grantKeyVaultSecretsUser(arm, "/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/v", "p"), "present");
    const arm2 = stubArm([["PUT", "/roleAssignments/", {}]]);
    assert.equal(await grantKeyVaultSecretsUser(arm2, "/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/v", "p"), "granted");
    assert.equal(arm.calls[0].path, arm2.calls[0].path, "same principal + vault → same assignment name");
    assert.match(arm2.calls[0].body.properties.roleDefinitionId, /4633458b-17de-408a-b874-0445c86b69e6$/);
  });
});

describe("proxy on App Service", () => {
  test("creates RG, B1 Linux plan and a container site with the settings when absent", async () => {
    const arm = stubArm([
      ["GET", "/resourceGroups/rg?", err(404)], ["PUT", "/resourceGroups/rg?", {}],
      ["GET", "/serverfarms/plan", err(404)], ["PUT", "/serverfarms/plan", {}],
      ["GET", "/sites/px?", err(404)], ["PUT", "/sites/px?", ({ body }) => ({ ...body, properties: { ...body.properties, defaultHostName: "px.azurewebsites.net" } })],
    ]);
    const r = await ensureProxyWebApp(arm, { subscriptionId: "s", resourceGroup: "rg", location: "westeurope", name: "px", planName: "plan", settings: { GOVERNANCE_UPSTREAM: "https://vendor", GOVERNANCE_PROXY_PORT: "8787" } });
    assert.equal(r.created, true); assert.equal(r.host, "px.azurewebsites.net");
    const site = arm.calls.find((c) => c.method === "PUT" && c.path.endsWith("/sites/px")).body;
    assert.match(site.properties.siteConfig.linuxFxVersion, /^DOCKER\|ghcr\.io\/ohomaidi\/agent365-governance-proxy/);
    assert.ok(site.properties.siteConfig.appSettings.some((s) => s.name === "WEBSITES_PORT" && s.value === "8787"));
    assert.equal(site.properties.httpsOnly, true);
  });
});

describe("endpoint check", () => {
  test("passes on 401 (the SDK demanding a token), keeps trying on 404/5xx, and fails honestly", async () => {
    let n = 0;
    const fetchImpl = async () => ({ status: ++n < 3 ? 404 : 401 });
    const r = await waitForEndpoint("https://x/api/messages", { tries: 5, delayMs: 1, fetchImpl });
    assert.equal(r.ok, true); assert.equal(r.attempts, 3);
    const bad = await waitForEndpoint("https://x/api/messages", { tries: 2, delayMs: 1, fetchImpl: async () => ({ status: 500 }) });
    assert.equal(bad.ok, false); assert.equal(bad.status, 500);
  });
});
