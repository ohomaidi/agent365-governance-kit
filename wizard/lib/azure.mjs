/**
 * Agents hosted in Azure — what the wizard does instead of writing a .env:
 *
 *   App Service      settings → App Settings (merged, never wiped), restart,
 *                    endpoint = https://<defaultHostName>
 *   Container Apps   settings → template env (+ secrets by secretRef),
 *                    which rolls a new revision; endpoint = https://<ingress fqdn>
 *   Key Vault        optional: secrets stored in a vault and referenced from
 *                    App Settings (@Microsoft.KeyVault(SecretUri=…)), with the
 *                    app's managed identity granted "Key Vault Secrets User".
 *   Proxy            "third-party agent" on Azure = an App Service running the
 *                    published proxy container image with these settings.
 *
 * Everything is plain ARM REST through the delegated client in auth.mjs —
 * no Azure CLI. Every write reads first and merges; nothing is overwritten
 * except the keys the kit owns.
 */
import { randomUUID, createHash } from "node:crypto";

export const API = {
  subs: "2022-12-01", web: "2023-12-01", app: "2024-03-01", kv: "2023-07-01", auth: "2022-04-01", rg: "2021-04-01",
};
export const PROXY_IMAGE = "ghcr.io/ohomaidi/agent365-governance-proxy:latest";
export const KV_SECRETS_USER_ROLE = "4633458b-17de-408a-b874-0445c86b69e6"; // Key Vault Secrets User

/** Keys whose values are secrets and belong in Key Vault when one is used. */
export const SECRET_KEYS = new Set(["PURVIEW_CLIENT_SECRET", "agent365Observability__clientSecret", "connections__service_connection__settings__clientSecret"]);

/** ".env block" lines → { KEY: value } (comments and blanks dropped). */
export function linesToSettings(lines) {
  const out = {};
  for (const l of lines) {
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("="); if (i < 1) continue;
    out[l.slice(0, i).trim()] = l.slice(i + 1);
  }
  return out;
}

/* ------------------------------------------------------------ discovery --- */

export async function listSubscriptions(arm) {
  const r = await arm("GET", `/subscriptions?api-version=${API.subs}`);
  return (r?.value ?? []).filter((s) => s.state === "Enabled").map((s) => ({ id: s.subscriptionId, name: s.displayName }));
}

/** Linux/Windows web apps (App Service), with what the wizard needs to target one. */
export async function listWebApps(arm, subscriptionId) {
  const r = await arm("GET", `/subscriptions/${subscriptionId}/providers/Microsoft.Web/sites?api-version=${API.web}`);
  return (r?.value ?? []).filter((s) => !/functionapp/i.test(s.kind ?? "")).map((s) => ({
    kind: "webapp", id: s.id, name: s.name, resourceGroup: s.id.split("/resourceGroups/")[1]?.split("/")[0] ?? "",
    location: s.location, host: s.properties?.defaultHostName ?? "", state: s.properties?.state ?? "", image: s.properties?.siteConfig?.linuxFxVersion ?? "",
  }));
}

export async function listContainerApps(arm, subscriptionId) {
  const r = await arm("GET", `/subscriptions/${subscriptionId}/providers/Microsoft.App/containerApps?api-version=${API.app}`);
  return (r?.value ?? []).map((a) => ({
    kind: "containerapp", id: a.id, name: a.name, resourceGroup: a.id.split("/resourceGroups/")[1]?.split("/")[0] ?? "",
    location: a.location, host: a.properties?.configuration?.ingress?.fqdn ?? "", external: Boolean(a.properties?.configuration?.ingress?.external),
    environmentId: a.properties?.managedEnvironmentId ?? "",
  }));
}

/* ---------------------------------------------------------- App Service --- */

export async function getAppSettings(arm, app) {
  const r = await arm("POST", `${app.id}/config/appsettings/list?api-version=${API.web}`, {});
  return r?.properties ?? {};
}

/** Merge: existing settings kept, the kit's keys set. Returns the keys written. */
export async function setAppSettings(arm, app, settings) {
  const current = await getAppSettings(arm, app);
  const merged = { ...current, ...settings };
  await arm("PUT", `${app.id}/config/appsettings?api-version=${API.web}`, { properties: merged });
  return Object.keys(settings);
}

export async function restartWebApp(arm, app) {
  await arm("POST", `${app.id}/restart?api-version=${API.web}`);
  return `restarted App Service ${app.name}`;
}

/** Turn on the system-assigned managed identity; returns its principalId. */
export async function ensureWebAppIdentity(arm, app) {
  const site = await arm("GET", `${app.id}?api-version=${API.web}`);
  if (site?.identity?.principalId && /SystemAssigned/i.test(site.identity.type ?? "")) return site.identity.principalId;
  const type = /UserAssigned/i.test(site?.identity?.type ?? "") ? "SystemAssigned, UserAssigned" : "SystemAssigned";
  const r = await arm("PATCH", `${app.id}?api-version=${API.web}`, { identity: { type, ...(site?.identity?.userAssignedIdentities ? { userAssignedIdentities: site.identity.userAssignedIdentities } : {}) } });
  return r?.identity?.principalId ?? "";
}

/* ------------------------------------------------------- Container Apps --- */

/**
 * Merge env into the first container's env. Secret keys go to
 * configuration.secrets (lower-case names) and are referenced by secretRef.
 * PATCHing the template rolls a new revision, so no separate restart.
 */
export async function setContainerAppEnv(arm, app, settings) {
  const cur = await arm("GET", `${app.id}?api-version=${API.app}`);
  const containers = cur?.properties?.template?.containers ?? [];
  if (!containers.length) throw new Error(`container app ${app.name} has no containers`);
  const secrets = [...(cur.properties.configuration?.secrets ?? [])];
  const env = [...(containers[0].env ?? [])];
  const upsertEnv = (e) => { const i = env.findIndex((x) => x.name === e.name); if (i > -1) env[i] = e; else env.push(e); };
  for (const [k, v] of Object.entries(settings)) {
    if (SECRET_KEYS.has(k)) {
      const sname = k.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 60);
      const si = secrets.findIndex((s) => s.name === sname);
      if (si > -1) secrets[si] = { name: sname, value: v }; else secrets.push({ name: sname, value: v });
      upsertEnv({ name: k, secretRef: sname });
    } else upsertEnv({ name: k, value: v });
  }
  const template = { ...cur.properties.template, containers: [{ ...containers[0], env }, ...containers.slice(1)] };
  await arm("PATCH", `${app.id}?api-version=${API.app}`, { properties: { configuration: { ...cur.properties.configuration, secrets }, template } });
  return Object.keys(settings);
}

/* ------------------------------------------------------------ Key Vault --- */

/** Store each secret key in the vault; returns { KEY: "@Microsoft.KeyVault(SecretUri=…)" } for App Settings. */
export async function storeSecretsInKeyVault(kv, settings, prefix) {
  const refs = {};
  for (const [k, v] of Object.entries(settings)) {
    if (!SECRET_KEYS.has(k)) continue;
    const name = `${prefix}-${k}`.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 120);
    const r = await kv("PUT", `/secrets/${name}`, { value: v });
    const uri = r?.id ?? "";
    refs[k] = `@Microsoft.KeyVault(SecretUri=${uri.replace(/\/[0-9a-f]{32}$/, "")})`;
  }
  return refs;
}

/** Grant "Key Vault Secrets User" on the vault to a principal (idempotent by deterministic name). */
export async function grantKeyVaultSecretsUser(arm, vaultResourceId, principalId) {
  const name = createHash("sha1").update(`${vaultResourceId}|${principalId}|${KV_SECRETS_USER_ROLE}`).digest("hex").slice(0, 32);
  const guid = `${name.slice(0, 8)}-${name.slice(8, 12)}-${name.slice(12, 16)}-${name.slice(16, 20)}-${name.slice(20, 32)}`;
  const roleDefId = `${vaultResourceId.split("/providers/")[0].replace(/\/resourceGroups\/.*$/, "")}/providers/Microsoft.Authorization/roleDefinitions/${KV_SECRETS_USER_ROLE}`;
  try {
    await arm("PUT", `${vaultResourceId}/providers/Microsoft.Authorization/roleAssignments/${guid}?api-version=${API.auth}`,
      { properties: { roleDefinitionId: roleDefId, principalId, principalType: "ServicePrincipal" } });
    return "granted";
  } catch (e) { if (e.status === 409) return "present"; throw e; }
}

export async function findKeyVault(arm, subscriptionId, vaultName) {
  const r = await arm("GET", `/subscriptions/${subscriptionId}/providers/Microsoft.KeyVault/vaults?api-version=${API.kv}`);
  return (r?.value ?? []).find((v) => v.name.toLowerCase() === vaultName.toLowerCase()) ?? null;
}

/* ---------------------------------------------------------------- proxy --- */

/**
 * Create (or update) an App Service running the published proxy image, with
 * the kit's settings. Needs an existing Linux plan or creates a B1 one.
 * @returns {{id:string, host:string, created:boolean}}
 */
export async function ensureProxyWebApp(arm, { subscriptionId, resourceGroup, location, name, planName, settings, image = PROXY_IMAGE }) {
  const rgId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
  try { await arm("GET", `${rgId}?api-version=${API.rg}`); }
  catch (e) { if (e.status === 404) await arm("PUT", `${rgId}?api-version=${API.rg}`, { location }); else throw e; }
  const planId = `${rgId}/providers/Microsoft.Web/serverfarms/${planName}`;
  try { await arm("GET", `${planId}?api-version=${API.web}`); }
  catch (e) {
    if (e.status !== 404) throw e;
    await arm("PUT", `${planId}?api-version=${API.web}`, { location, kind: "linux", sku: { name: "B1", tier: "Basic" }, properties: { reserved: true } });
  }
  const siteId = `${rgId}/providers/Microsoft.Web/sites/${name}`;
  let created = false, site = null;
  try { site = await arm("GET", `${siteId}?api-version=${API.web}`); }
  catch (e) { if (e.status !== 404) throw e; }
  const body = {
    location, kind: "app,linux,container",
    properties: { serverFarmId: planId, httpsOnly: true, siteConfig: {
      linuxFxVersion: `DOCKER|${image}`, alwaysOn: true,
      appSettings: Object.entries({ ...settings, WEBSITES_PORT: String(settings.GOVERNANCE_PROXY_PORT ?? "8787"), PORT: String(settings.GOVERNANCE_PROXY_PORT ?? "8787") }).map(([name, value]) => ({ name, value })),
    } },
  };
  if (!site) { site = await arm("PUT", `${siteId}?api-version=${API.web}`, body); created = true; }
  else { await setAppSettings(arm, { id: siteId, name }, { ...settings, WEBSITES_PORT: String(settings.GOVERNANCE_PROXY_PORT ?? "8787"), PORT: String(settings.GOVERNANCE_PROXY_PORT ?? "8787") }); await arm("POST", `${siteId}/restart?api-version=${API.web}`); }
  return { id: siteId, name, resourceGroup, host: site?.properties?.defaultHostName ?? `${name}.azurewebsites.net`, created };
}

/* --------------------------------------------------------------- checks --- */

/** The messaging endpoint of a deployed agent must exist and demand a token: 401 (or 400/403), never 404/5xx. */
export async function waitForEndpoint(url, { tries = 12, delayMs = 10_000, fetchImpl = fetch } = {}) {
  let last = 0;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "message", text: "kit endpoint check" }) });
      last = res.status;
      if ([400, 401, 403].includes(res.status)) return { ok: true, status: res.status, attempts: i + 1 };
    } catch { last = 0; }
  }
  return { ok: false, status: last, attempts: tries };
}

export const newId = () => randomUUID();
