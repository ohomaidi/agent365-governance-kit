#!/usr/bin/env node
/**
 * agent365-govern init — interactive setup wizard.
 *
 * Auto-provisions everything the Governance Kit needs in the customer's tenant,
 * after a tenant admin signs in (device code — no Azure CLI). It:
 *   1. creates a dedicated app registration (the Purview connector) + secret,
 *   2. grants Content.Process.All + ProtectionScopes.Compute.All + Exchange.ManageAsApp,
 *   3. creates a cert, assigns the Compliance Administrator role,
 *   4. creates the DLP policy + rules + DSPM collection policy (Security & Compliance PS),
 *   5. writes the host app's .env,
 *   6. validates with a live processContent call,
 *   7. optionally revokes the provisioning-only privileges it needed.
 *
 * SAFETY DEFAULTS (v0.2):
 *   - The DLP policy is created in TEST mode, scoped to a PILOT GROUP.
 *     Tenant-wide enforcement requires two explicit confirmations.
 *   - Every generated credential lives in a temp dir that is shredded on exit.
 *   - `--dry-run` prints the full plan and mutates nothing.
 *
 *   8. publishes the agent to Teams (org app catalog, pilot installs, messaging endpoint)
 *      and proves it by sending a hello from the agent into the admin's Teams.
 *
 * Requires: pwsh 7 (the installer downloads it when missing), openssl on macOS/Linux.
 * Sign-in is built in (OAuth device code): no Azure CLI, no PowerShell modules to pre-install.
 * Pure Node built-ins — no install needed to run the wizard.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, env as procEnv } from "node:process";
import { writeFileSync, appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerAgent, slugify, A365_RESOURCES, MESSAGING_BOT_API_APP } from "./lib/agent365.mjs";
import { probeTenant } from "./lib/capabilities.mjs";
import { TokenCache, startDeviceCode, pollDeviceCode, makeDelegatedGraph, makeDevPortal, makeAgent365Service, ensureAgent365ServiceConsent, fetchRetry, CLIENTS, GRAPH_SCOPE_STRING } from "./lib/auth.mjs";
import { buildTeamsPackage, publishToOrgCatalog, installForUsers, registerMessagingEndpoint, proactiveHello,
         registerAgent365Endpoint, ensureAgentUser, assignAgentLicence } from "./lib/teams.mjs";
import { detectGuard, findKitTarball, wireNodeGuard } from "./lib/wire.mjs";
import { detectRunner } from "./lib/restart.mjs";
import { findProxyTarballs, scaffoldProxy, startProxy } from "./lib/proxy.mjs";
import { makeArm, makeKeyVault, ARM_SCOPE } from "./lib/auth.mjs";
import { linesToSettings, listSubscriptions, listWebApps, listContainerApps, getAppSettings, setAppSettings, restartWebApp,
         ensureWebAppIdentity, setContainerAppEnv, storeSecretsInKeyVault, grantKeyVaultSecretsUser, findKeyVault,
         ensureProxyWebApp, waitForEndpoint } from "./lib/azure.mjs";

// --- Microsoft constants (stable GUIDs) ---
const GRAPH_APP = "00000003-0000-0000-c000-000000000000";
const EXO_APP = "00000002-0000-0ff1-ce00-000000000000";
const ROLE_CONTENT_PROCESS = "5ad511bf-571c-4ef6-8c3c-85b94b85df98"; // Content.Process.All
const ROLE_PROTECTION_SCOPES = "e5a76501-dbb0-492c-ab55-5d09e8837263"; // ProtectionScopes.Compute.All
const ROLE_EXCHANGE_MANAGE = "dc50a0fb-09a3-484d-be87-e023b12c6440"; // Exchange.ManageAsApp
const ROLE_COMPLIANCE_ADMIN = "17315797-102d-40b4-93e0-432062caca18"; // Compliance Administrator
// Agent 365 / Entra Agent ID application permissions. Registration needs these
// on the connector app: the Azure CLI is a first-party app whose token carries
// no agent scopes at all, so `az rest` can never perform these calls.
const ROLE_AGENT_INSTANCE_RW = "07abdd95-78dc-4353-bd32-09f880ea43d0";      // AgentInstance.ReadWrite.All
const ROLE_AGENT_BLUEPRINT_RW = "7fddd33b-d884-4ec0-8696-72cff90ff825";     // AgentIdentityBlueprint.ReadWrite.All
const ROLE_AGENT_BLUEPRINT_CREATE = "ea4b2453-ad2d-4d94-9155-10d5d9493ce9"; // AgentIdentityBlueprint.Create
const ROLE_AGENT_BLUEPRINT_CREDS = "0510736e-bdfb-4b37-9a1f-89b4a074763a";  // AgentIdentityBlueprint.AddRemoveCreds.All
const ROLE_AGENT_CARD_RW = "228b1a03-f7ca-4348-b50d-e8a547ab61af";          // AgentCardManifest.ReadWrite.All
const ROLE_AGENT_BLUEPRINT_AUTH = "19202363-278e-49c2-bf00-391e2ba00881";   // AgentIdentityBlueprint.UpdateAuthProperties.All
const ROLE_AGENT_PRINCIPAL_CREATE = "8959696d-d07e-4916-9b1e-3ba9ce459161"; // AgentIdentityBlueprintPrincipal.Create
const ROLE_AGENT_IDENTITY_CREATE = "ad25cc1d-84d8-47df-a08e-b34c2e800819";  // AgentIdentity.Create.All
const ROLE_AGENT_IDENTITY_READ = "b2b8f011-2898-4234-9092-5059f6c1ebfa";    // AgentIdentity.Read.All
const ROLE_AGENT_REGISTRATION_RW = "39fb8c64-7bd3-4107-8515-14d6e55ddda4";  // AgentRegistration.ReadWrite.All (POST /copilot/agentRegistrations)
const ROLE_COPILOT_PACKAGES_RW = "ed31732f-9495-47ed-ba3b-4ed0948c1c64";    // CopilotPackages.ReadWrite.All (Agent 365 inventory)
const EXO_MODULE_VERSION = "3.5.1"; // 3.10.x throws NullRef on PowerShell 7.6

const IS_WINDOWS = process.platform === "win32";
const DRY_RUN = argv.includes("--dry-run") || argv.includes("-n");

/**
 * Non-interactive mode: `--answers file.json` supplies every response by key.
 * The browser installer drives the wizard this way, and it makes repeat test
 * runs reproducible instead of depending on prompt ordering.
 */
const ANSWERS_PATH = (() => {
  const i = argv.indexOf("--answers");
  return i > -1 && argv[i + 1] ? argv[i + 1] : "";
})();
const ANSWERS = ANSWERS_PATH ? JSON.parse(readFileSync(ANSWERS_PATH, "utf8")) : null;

// Colour only when a human is watching a terminal. Piped output (the browser
// installer, CI logs, a file) gets clean text instead of escape codes.
const USE_COLOR = Boolean(stdout.isTTY) && !procEnv.NO_COLOR && procEnv.FORCE_COLOR !== "0";
const C = USE_COLOR
  ? { reset: "\x1b[0m", b: "\x1b[1m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m", c: "\x1b[36m" }
  : { reset: "", b: "", g: "", y: "", r: "", d: "", c: "" };
const ok = (m) => console.log(`${C.g}✓${C.reset} ${m}`);
const info = (m) => console.log(`${C.d}·${C.reset} ${m}`);
const warn = (m) => console.log(`${C.y}!${C.reset} ${m}`);
const plan = (m) => console.log(`${C.c}▸ would${C.reset} ${m}`);
const die = (m) => { console.error(`${C.r}✗ ${m}${C.reset}`); process.exit(1); };

/** Everything we mutated, so a failure can tell the operator exactly what to undo. */
const journal = [];
const record = (what) => { journal.push(what); };

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}
const PWSH = procEnv.A365_PWSH || "pwsh";

/**
 * Delegated Graph as the signed-in administrator — set in main() after the
 * device-code sign-in. Same contract as the app-only client below.
 */
let dg = async () => { throw new Error("not signed in"); };
let account = null; // { id, upn, name, tenantId }
const SIGNIN_CLIENT = CLIENTS.graphCli;
const DEVPORTAL_CLIENT = CLIENTS.teamsToolkit;

const isGuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));
/** Service principal by appId, or null. */
async function spByAppId(appId, graph = dg) {
  const r = await graph("GET", `/v1.0/servicePrincipals?$filter=appId eq '${odata(appId)}'&$select=id,appId,displayName`);
  return r?.value?.[0] ?? null;
}
/** Service principal by appId, created when absent (first-party resources need this). */
async function ensureSp(appId, graph = dg) {
  return (await spByAppId(appId, graph)) ?? await graph("POST", "/v1.0/servicePrincipals", { appId });
}
/** Object id of a user given a UPN or object id; throws when not found. */
async function userIdOf(upnOrId, graph = dg) {
  let u;
  try { u = await graph("GET", `/v1.0/users/${encodeURIComponent(upnOrId)}?$select=id`); }
  catch (e) {
    // Only a 404 means "no such user"; anything else (token, throttling, outage) is its own message.
    if (e?.status === 404) throw Object.assign(new Error(`user "${upnOrId}" not found`), { status: 404 });
    throw new Error(`looking up "${upnOrId}": ${e.message}`);
  }
  if (!u?.id) throw new Error(`user "${upnOrId}" not found`);
  return u.id;
}
/** A group by object id or mail address. */
async function groupLookup(idOrMail, graph = dg) {
  if (isGuid(idOrMail)) return graph("GET", `/v1.0/groups/${idOrMail}?$select=id,mail,displayName`);
  const r = await graph("GET", `/v1.0/groups?$filter=mail eq '${odata(idOrMail)}'&$select=id,mail,displayName`);
  if (!r?.value?.[0]) throw new Error(`group "${idOrMail}" not found`);
  return r.value[0];
}

/**
 * Graph caller for Agent 365 registration, authenticated as the CONNECTOR APP.
 *
 * Not `az rest`: the Azure CLI is a first-party app whose token carries no
 * agent scopes at all, so every agent endpoint 403s/404s through it. The app
 * registration this wizard creates holds the app roles and mints its own token.
 *
 * Contract (shared with wizard/lib/agent365.mjs): graph(method, path, body?,
 * headers?) resolves to the parsed body on 2xx; otherwise throws an Error with
 * `.status` and `.body`. Paths are full ("/v1.0/…" or "/beta/…").
 */
function makeGraphClient({ tenantId, clientId, clientSecret }) {
  let token = "", expires = 0;
  async function getToken() {
    if (token && Date.now() < expires - 60_000) return token;
    // A secret minted seconds ago is accepted by one Entra token replica and
    // refused by another (AADSTS7000215, seen live). Retry that one for a while.
    let j = {};
    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 15_000));
      const res = await fetchRetry(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
          scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
      });
      j = await res.json();
      if (j.access_token) break;
      if (!/AADSTS7000215|AADSTS700016|invalid_client/i.test(String(j.error_description || j.error))) break;
    }
    if (!j.access_token) throw new Error(`token: ${j.error_description || JSON.stringify(j)}`);
    token = j.access_token; expires = Date.now() + (j.expires_in ?? 3600) * 1000;
    return token;
  }
  return async function graph(method, path, body, headers = {}) {
    // Freshly granted app roles take a little while to reach a minted token:
    // 401/403 are retried with a re-minted token. Object replication (404 /
    // 400 "does not exist") is the library's job.
    const delays = [0, 5000, 10000, 20000, 30000, 45000, 60000, 60000];
    let last;
    for (const d of delays) {
      if (d) await new Promise((r) => setTimeout(r, d));
      const t = await getToken();
      const res = await fetchRetry(`https://graph.microsoft.com${path}`, {
        method,
        headers: { authorization: `Bearer ${t}`, ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
      if (res.ok) return parsed;
      last = Object.assign(new Error(`${method} ${path} -> HTTP ${res.status}: ${(parsed?.error?.message ?? text).slice(0, 300)}`),
        { status: res.status, body: parsed });
      if (![401, 403].includes(res.status)) break;
      token = "";
    }
    throw last;
  };
}

/**
 * Entra puts freshly granted app roles into a client-credentials token only
 * after a propagation delay (observed live: >2 minutes). Poll the connector's
 * own token until the roles it needs are actually in the `roles` claim, so the
 * registration calls that follow cannot 403 on a stale token.
 */
export async function waitForConnectorRoles({ tenantId, clientId, clientSecret, required, log = () => {}, maxMs = 8 * 60_000, fetchImpl = fetch }) {
  const started = Date.now();
  let attempt = 0, missing = required;
  while (Date.now() - started < maxMs) {
    attempt++;
    const j = await fetchImpl(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }),
    }).then((r) => r.json()).catch(() => ({}));
    if (j.access_token) {
      let roles = [];
      try { roles = JSON.parse(Buffer.from(j.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")).roles ?? []; } catch { /* unreadable token */ }
      missing = required.filter((r) => !roles.includes(r));
      if (!missing.length) return { ok: true, attempts: attempt, waitedMs: Date.now() - started };
    }
    log(j.access_token
      ? `connector token does not carry ${missing.length} role(s) yet (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}) — waiting 20s (attempt ${attempt})`
      : `connector credential not accepted yet (${String(j.error_description || j.error || "no token").slice(0, 60)}) — waiting 20s (attempt ${attempt})`);
    await new Promise((r) => setTimeout(r, 20_000));
  }
  return { ok: false, attempts: attempt, waitedMs: Date.now() - started, missing };
}

/** Retry a call that references an Entra object created seconds ago (404 / "does not exist"). */
async function withReplicationLocal(fn) {
  const delays = [0, 3000, 6000, 10000, 15000, 20000, 30000, 30000];
  let last;
  for (const d of delays) {
    if (d) await new Promise((r) => setTimeout(r, d));
    try { return await fn(); }
    catch (e) { last = e; if (!(e?.status === 404 || (e?.status === 400 && /does not exist|not found|does not reference a valid|not present|could not be found/i.test(String(e.message))))) throw e; }
  }
  throw last;
}

/** Quote a value for safe embedding in a PowerShell single-quoted literal. */
export const psLit = (v) => `'${String(v ?? "").replace(/'/g, "''")}'`;
/** Escape a value for an OData string literal (az --filter). */
export const odata = (v) => String(v ?? "").replace(/'/g, "''");
/** Reject values that would corrupt a KEY=value .env line. */
function assertEnvSafe(name, v) {
  if (/[\r\n]/.test(String(v))) die(`${name} must not contain newlines.`);
  return v;
}

/**
 * Purview's Applications-workload DLP binds a policy to exactly two things:
 * the whole tenant, or a mail-enabled group. There is no per-user binding
 * (probed live: "User", "Individual", "Recipient" are all rejected). So
 * "just me" / "specific people" becomes: create (or reuse) a Microsoft 365
 * group holding those people, and bind to its mail address.
 *
 * Idempotent on mailNickname; adds any missing members on re-run.
 * `deps` is injectable for tests.
 */
export async function ensurePilotGroup({ displayName, mailNickname, ownerId, memberIds }, graph = dg) {
  const G = "https://graph.microsoft.com/v1.0";
  const found = await graph("GET", `/v1.0/groups?$filter=mailNickname eq '${odata(mailNickname)}'&$select=id,mail,displayName`);
  let g = found?.value?.[0] ?? null;
  let created = false;
  if (!g) {
    g = await graph("POST", "/v1.0/groups", {
      displayName, mailNickname, description: "Pilot scope for an Agent 365 Governance Kit DLP policy.",
      groupTypes: ["Unified"], mailEnabled: true, securityEnabled: false,
      "owners@odata.bind": [`${G}/users/${ownerId}`],
      "members@odata.bind": [...new Set(memberIds)].map((id) => `${G}/users/${id}`),
    });
    created = true;
  } else {
    const have = ((await graph("GET", `/v1.0/groups/${g.id}/members?$select=id`))?.value ?? []).map((m) => m.id);
    for (const id of memberIds) {
      if (have.includes(id)) continue;
      await graph("POST", `/v1.0/groups/${g.id}/members/$ref`, { "@odata.id": `${G}/directoryObjects/${id}` });
    }
  }
  if (!g?.mail) throw new Error(`pilot group "${displayName}" has no mail address; Purview cannot bind to it`);
  return { id: g.id, mail: g.mail, displayName: g.displayName, created };
}

/**
 * Tenant-wide delegated consent from the blueprint principal to each Agent 365
 * resource — what the Entra "Grant admin consent" button does, and what
 * `a365 setup permissions bot` performs. Runs under the signed-in Global
 * Administrator (the CLI token carries DelegatedPermissionGrant.ReadWrite.All).
 * Idempotent: merges scopes into an existing grant.
 */
export async function grantBlueprintConsent({ blueprintPrincipalId, resources = A365_RESOURCES }, graph = dg) {
  const out = [];
  for (const res of resources) {
    // The resource's service principal must exist in the tenant before it can be consented to.
    let rsp = null;
    try { rsp = (await ensureSp(res.appId, graph))?.id ?? null; }
    catch (e) { out.push(`WARNING: ${res.name} service principal could not be created: ${String(e.message || e).slice(0, 100)}`); continue; }
    const found = await graph("GET",
      `/v1.0/oauth2PermissionGrants?$filter=clientId eq '${blueprintPrincipalId}' and resourceId eq '${rsp}' and consentType eq 'AllPrincipals'`);
    const existing = found?.value?.[0] ?? null;
    if (existing) {
      const have = new Set(String(existing.scope || "").split(" ").filter(Boolean));
      const merged = [...new Set([...have, ...res.scopes])].join(" ");
      if (merged !== String(existing.scope || "").trim()) {
        await graph("PATCH", `/v1.0/oauth2PermissionGrants/${existing.id}`, { scope: merged });
        out.push(`consent updated: ${res.name} (${merged})`);
      } else {
        out.push(`consent already present: ${res.name}`);
      }
    } else {
      await graph("POST", "/v1.0/oauth2PermissionGrants",
        { clientId: blueprintPrincipalId, consentType: "AllPrincipals", resourceId: rsp, scope: res.scopes.join(" ") });
      out.push(`consent granted: ${res.name} (${res.scopes.join(", ")})`);
    }
  }
  return out;
}

/** Best-effort shred: overwrite file bytes before unlinking. */
function shred(dir) {
  if (!existsSync(dir)) return;
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        const st = statSync(p);
        if (st.isFile() && st.size > 0) writeFileSync(p, randomBytes(st.size));
      } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Replace (not append) the kit's managed block in a .env, so re-running the
 * wizard doesn't leave duplicate PURVIEW_* keys with divergent secrets.
 */
export const BEGIN = "# >>> agent365-governance-kit >>>";
export const END = "# <<< agent365-governance-kit <<<";
export function writeEnvBlock(envPath, lines) {
  const block = [BEGIN, ...lines, END].join("\n");
  if (!existsSync(envPath)) { writeFileSync(envPath, block + "\n", { mode: 0o600 }); return "created"; }

  const prev = readFileSync(envPath, "utf8");
  copyFileSync(envPath, `${envPath}.bak`);
  const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g");
  if (re.test(prev)) {
    writeFileSync(envPath, prev.replace(re, block + "\n"));
    return "replaced";
  }
  // Older wizards wrote loose PURVIEW_* lines with no markers — comment them out
  // rather than leaving two competing definitions.
  const stale = /^(PURVIEW_|agent365Observability__|ENABLE_A365_OBSERVABILITY_EXPORTER|A365_OBSERVABILITY_LOG_LEVEL)/;
  const kept = prev.split("\n").map((l) => (stale.test(l) ? `# superseded by agent365-governance-kit: ${l}` : l));
  writeFileSync(envPath, kept.join("\n").replace(/\n*$/, "\n") + "\n" + block + "\n");
  return prev.split("\n").some((l) => stale.test(l)) ? "replaced (old loose keys commented out)" : "appended";
}

/** Print the tenant capability report. Returns true if provisioning can proceed. */
async function runTenantCheck() {
  console.log(`${C.b}\n  Tenant capability check${C.reset}\n`);
  const r = await probeTenant(dg, account);
  const mark = { ok: `${C.g}✓${C.reset}`, warn: `${C.y}!${C.reset}`, fail: `${C.r}✗${C.reset}` };
  for (const c of r.checks) {
    console.log(`  ${mark[c.status]} ${c.name.padEnd(28)} ${c.detail}`);
    if (c.fix) console.log(`      ${C.d}${c.fix}${C.reset}`);
  }
  console.log("");
  console.log(`  Purview provisioning: ${r.canProvisionPurview ? `${C.g}available${C.reset}` : `${C.r}NOT available${C.reset}`}`);
  console.log(`  Agent 365 registration: ${r.canRegisterAgent365 ? `${C.g}available${C.reset}` : `${C.r}NOT available${C.reset}`}`);
  console.log("");
  return r.canProvisionPurview;
}

async function main(work) {
  console.log(`${C.b}\n  Agent 365 Governance Kit — setup wizard${C.reset}\n  ${C.d}Purview guard + Agent 365 identity, auto-provisioned.${C.reset}`);
  if (DRY_RUN) console.log(`  ${C.c}${C.b}DRY RUN — nothing will be created or modified.${C.reset}`);
  console.log("");

  // ---- preflight ----
  try { sh(PWSH, ["-NoProfile", "-Command", "$null"]); }
  catch { die("PowerShell 7 (pwsh) not found. The installer downloads it for you; from a terminal: brew install powershell / winget install Microsoft.PowerShell"); }
  if (!IS_WINDOWS) {
    try { sh("openssl", ["version"]); } catch { die("openssl not found."); }
  }

  // The provisioning script installs a module from the PowerShell Gallery.
  // Locked-down customer machines often block it — find out now, not 10 minutes in.
  let galleryOk = true;
  try {
    sh(PWSH, ["-NoProfile", "-Command",
      "if (-not (Get-Module -ListAvailable ExchangeOnlineManagement | Where-Object { $_.Version -eq '" + EXO_MODULE_VERSION + "' })) { " +
      "$r = Invoke-WebRequest -Uri 'https://www.powershellgallery.com/api/v2' -UseBasicParsing -TimeoutSec 15; " +
      "if ($r.StatusCode -ge 400) { exit 1 } }"]);
  } catch { galleryOk = false; }
  if (!galleryOk) {
    warn(`PowerShell Gallery is unreachable and ExchangeOnlineManagement ${EXO_MODULE_VERSION} isn't installed locally.`);
    warn(`  Policy provisioning will fail. Pre-install it on this machine, or run the wizard somewhere with PSGallery access:`);
    warn(`  ${C.d}Install-Module ExchangeOnlineManagement -RequiredVersion ${EXO_MODULE_VERSION} -Scope CurrentUser${C.reset}`);
  }

  // ---- sign in (device code; the installer usually did this already) ----
  const cache = new TokenCache(procEnv.A365_TOKEN_CACHE || join(work, "tokens.json"));
  if (!cache.signedIn(SIGNIN_CLIENT)) {
    if (ANSWERS) die("Not signed in. Run the installer (it signs you in), or run the wizard from a terminal.");
    const tenantHint = procEnv.A365_TENANT || "organizations";
    const dc = await startDeviceCode({ tenant: tenantHint, clientId: SIGNIN_CLIENT, scope: GRAPH_SCOPE_STRING });
    console.log(`\n  ${C.b}Sign in as a Global Administrator:${C.reset} open ${dc.verificationUri} and enter ${C.c}${C.b}${dc.userCode}${C.reset}`);
    console.log(`  ${C.d}Tick "Consent on behalf of your organization" when asked — it is a one-time consent for Microsoft Graph Command Line Tools.${C.reset}\n`);
    const tok = await pollDeviceCode({ tenant: tenantHint, clientId: SIGNIN_CLIENT, deviceCode: dc.deviceCode, interval: dc.interval, expiresIn: dc.expiresIn });
    cache.addSignIn(SIGNIN_CLIENT, tok, GRAPH_SCOPE_STRING);
  }
  account = cache.account(SIGNIN_CLIENT);
  dg = makeDelegatedGraph(cache, { clientId: SIGNIN_CLIENT });
  const devPortal = makeDevPortal(cache, { clientId: DEVPORTAL_CLIENT });
  const devPortalSignIn = async () => {
    if (cache.signedIn(DEVPORTAL_CLIENT)) return true;
    if (ANSWERS) return false; // the installer handles this sign-in itself
    const dc = await startDeviceCode({ tenant: account.tenantId, clientId: DEVPORTAL_CLIENT, scope: "https://dev.teams.microsoft.com/AppDefinitions.ReadWrite" });
    console.log(`\n  ${C.b}One more sign-in for the Teams Developer Portal:${C.reset} open ${dc.verificationUri} and enter ${C.c}${C.b}${dc.userCode}${C.reset}\n`);
    const tok = await pollDeviceCode({ tenant: account.tenantId, clientId: DEVPORTAL_CLIENT, deviceCode: dc.deviceCode, interval: dc.interval, expiresIn: dc.expiresIn });
    cache.addSignIn(DEVPORTAL_CLIENT, tok, "https://dev.teams.microsoft.com/AppDefinitions.ReadWrite");
    return true;
  };
  const tenantId = account.tenantId;
  const acct = { tenantId, user: { name: account.upn } };
  ok(`Signed in: ${account.upn}  (tenant ${tenantId})`);
  const orgInfo = await dg("GET", "/v1.0/organization?$select=displayName,verifiedDomains");
  const orgName = orgInfo?.value?.[0]?.displayName ?? "";
  const org = (orgInfo?.value?.[0]?.verifiedDomains ?? []).map((d) => d.name).find((d) => /onmicrosoft\.com$/i.test(d)) ?? "";

  if (argv.includes("--check")) {
    const okToGo = await runTenantCheck();
    process.exit(okToGo ? 0 : 1);
  }

  // Interactive on a TTY; otherwise answers are read from stdin up front so a
  // scripted --dry-run works and a short input aborts instead of hanging forever.
  const interactive = Boolean(stdin.isTTY) || Boolean(ANSWERS);
  const rl = (interactive && !ANSWERS) ? createInterface({ input: stdin, output: stdout }) : null;
  const scripted = (interactive || ANSWERS) ? null : readFileSync(0, "utf8").split("\n");
  let scriptIdx = 0;

  const outOfInput = () => {
    console.error(`\n${C.r}✗ Input ended before the interview finished — aborting without changes.${C.reset}`);
    console.error(`${C.d}  The wizard is interactive; run it from a terminal, or pipe every answer.${C.reset}`);
    printJournal();
    process.exit(1);
  };

  const ask = async (q, dflt, key) => {
    const promptText = `${C.b}?${C.reset} ${q}${dflt ? ` ${C.d}[${dflt}]${C.reset}` : ""} `;
    // Answers file wins when it names this question.
    if (ANSWERS && key && Object.prototype.hasOwnProperty.call(ANSWERS, key)) {
      const v = String(ANSWERS[key] ?? "");
      stdout.write(promptText + v + "\n");
      return v.trim() || dflt || "";
    }
    if (ANSWERS) {
      // Non-interactive: a question the answers file doesn't cover takes its
      // default; one with no default is a clear stop — never a crash on a
      // readline that doesn't exist, and never a hang.
      if (dflt) { stdout.write(promptText + dflt + "\n"); return dflt; }
      closeInput();
      die(`The answers file has no "${key ?? q}" and that question has no default.`);
    }
    let a;
    if (scripted) {
      if (scriptIdx >= scripted.length) outOfInput();
      a = scripted[scriptIdx++];
      stdout.write(promptText + a + "\n"); // echo so the transcript is readable
    } else {
      const EOF = Symbol("eof");
      // A TTY close here is a real Ctrl-D, so aborting is correct.
      a = await Promise.race([
        rl.question(promptText),
        new Promise((resolve) => rl.once("close", () => resolve(EOF))),
      ]);
      if (a === EOF) outOfInput();
    }
    return a.trim() || dflt || "";
  };
  const closeInput = () => rl?.close();
  const yes = async (q, dflt = true, key) => {
    if (ANSWERS && key && Object.prototype.hasOwnProperty.call(ANSWERS, key)) {
      return Boolean(ANSWERS[key]);
    }
    return /^y/i.test(await ask(`${q} (${dflt ? "Y/n" : "y/N"})`, dflt ? "y" : "n"));
  };

  // ---- collect variables ----
  const appRegName = await ask("App registration name for the Purview connector:", "Agent Purview Connector", "appRegName");
  const purviewAppName = await ask("App name to show in Purview audit/DSPM:", "Custom AI App", "purviewAppName");
  const attribUpn = await ask("User to attribute interactions to (UPN):", acct.user.name, "attribUpn");
  console.log(`\n${C.b}Where does the agent run?${C.reset}`);
  console.log(`  ${C.d}1) On this machine — settings are written to its .env`);
  console.log(`  2) Azure App Service — settings become App Settings, then the app is restarted`);
  console.log(`  3) Azure Container Apps — settings become the container's env (secrets as secrets); a new revision rolls${C.reset}`);
  const hosting = { "1": "local", "2": "webapp", "3": "containerapp" }[await ask("Choose 1/2/3:", "1", "hosting")] ?? "local";
  const envPath = hosting === "local" ? await ask("Path to your agent's .env to write:", join(process.cwd(), ".env"), "envPath") : join(process.cwd(), ".env");
  const lang = (await ask("Your agent's language (typescript / python / dotnet / proxy = a third-party agent fronted by the governance proxy):", "typescript", "lang")).toLowerCase();
  // A third-party agent you cannot modify: the proxy IS the agent as far as
  // Purview, Agent 365 and Teams are concerned. Its .env gets the same block
  // plus where the vendor lives and how it speaks.
  let upstreamUrl = "", upstreamDialect = "auto", proxyPort = "8787", upstreamPath = "", wantProxyStart = false;
  if (lang === "proxy") {
    upstreamUrl = await ask("  Vendor agent's API base URL (what the proxy forwards to):", "", "upstreamUrl");
    while (!/^https?:\/\//i.test(upstreamUrl)) {
      if (ANSWERS) die("upstreamUrl in the answers file must be an http(s) URL.");
      warn("  An http(s) URL is required.");
      upstreamUrl = await ask("  Vendor agent's API base URL:", "", "upstreamUrl");
    }
    upstreamDialect = (await ask("  Its wire format (a2a / openai / generic / auto):", "auto", "upstreamDialect")).toLowerCase();
    upstreamPath = await ask("  Path of its chat endpoint (what a Teams turn is posted to):", upstreamDialect === "openai" ? "/v1/chat/completions" : "/", "upstreamPath");
    proxyPort = await ask("  Port the proxy listens on:", "8787", "proxyPort");
    wantProxyStart = hosting === "local" ? await yes("  Install and start the proxy on this machine when done?", true, "wantProxyStart") : false;
  }

  // --- Azure details (App Service / Container Apps) ---
  let arm = null, azureApp = null, azureSubscription = "", azureKeyVault = "", azureProxy = null;
  if (hosting !== "local") {
    if (!cache.signedIn(CLIENTS.azurePowerShell)) {
      if (ANSWERS) die("Azure hosting needs the Azure sign-in (the installer's optional third sign-in).");
      const dc = await startDeviceCode({ tenant: account.tenantId, clientId: CLIENTS.azurePowerShell, scope: ARM_SCOPE });
      console.log(`\n  ${C.b}Azure sign-in:${C.reset} open ${dc.verificationUri} and enter ${C.c}${C.b}${dc.userCode}${C.reset}\n`);
      cache.addSignIn(CLIENTS.azurePowerShell, await pollDeviceCode({ tenant: account.tenantId, clientId: CLIENTS.azurePowerShell, deviceCode: dc.deviceCode, interval: dc.interval, expiresIn: dc.expiresIn }), ARM_SCOPE);
    }
    arm = makeArm(cache);
    const subs = await listSubscriptions(arm);
    if (!subs.length) die("The Azure sign-in sees no enabled subscriptions.");
    azureSubscription = await ask(`  Subscription id (${subs.map((x) => `${x.name}=${x.id}`).join("; ")}):`, subs[0].id, "azureSubscription");
    if (lang === "proxy") {
      azureProxy = {
        resourceGroup: await ask("  Resource group for the proxy (created if missing):", "rg-agent365-governance", "azureResourceGroup"),
        location: await ask("  Azure region:", "westeurope", "azureLocation"),
        name: await ask("  App Service name for the proxy (globally unique):", slugify(`${purviewAppName}-proxy`), "azureAppName"),
      };
      azureProxy.planName = await ask("  App Service plan name:", `${azureProxy.name}-plan`, "azurePlanName");
    } else {
      const apps = hosting === "webapp" ? await listWebApps(arm, azureSubscription) : await listContainerApps(arm, azureSubscription);
      if (!apps.length) die(`No ${hosting === "webapp" ? "App Service apps" : "Container Apps"} in subscription ${azureSubscription}.`);
      const pick = await ask(`  The agent's app (${apps.map((x) => x.name).join(", ")}) — name or resource id:`, apps[0].name, "azureApp");
      azureApp = apps.find((x) => x.id === pick || x.name.toLowerCase() === pick.toLowerCase()) ?? null;
      if (!azureApp) die(`App "${pick}" not found in subscription ${azureSubscription}.`);
      ok(`Target: ${hosting === "webapp" ? "App Service" : "Container App"} ${azureApp.name} (${azureApp.resourceGroup}, ${azureApp.location}) — https://${azureApp.host}`);
    }
    if (hosting === "webapp") azureKeyVault = await ask("  Key Vault name for the secrets (blank = App Settings):", "", "azureKeyVault");
  }

  // --- guard wiring: never hand the customer code to paste ---
  const agentDir = envPath.replace(/[^/\\]*$/, "") || process.cwd();
  const guardState = hosting === "local" ? detectGuard(agentDir, lang)
    : (lang === "proxy" ? { wired: true, how: "proxy" } : { wired: true, how: "assumed for an Azure-hosted agent (the kit cannot inspect deployed code); if it does not call the guard, front it with the proxy" });
  let wantAutoWire = false;
  if (lang === "typescript" && !guardState.wired) {
    console.log(`\n${C.b}Purview guard in the agent${C.reset}`);
    console.log(`  ${C.d}This Node agent does not call the guard yet. The wizard can wire it in itself: install the kit package,`);
    console.log(`  add a preload that checks every Teams message and reply, and update the start script. No source edits.${C.reset}`);
    wantAutoWire = await yes("  Wire the Purview guard into this agent automatically?", true, "wantAutoWire");
  } else if (guardState.wired && lang !== "proxy") {
    ok(`Purview guard already wired into this agent (${guardState.how}) — nothing to add.`);
  }

  // --- Microsoft Purview: the DLP / DSPM half. Off = the connector app is still
  // created (Agent 365 registers through it) but no policy, no cert, no
  // Compliance Administrator, and the guard is written disabled. ---
  console.log(`\n${C.b}Microsoft Purview${C.reset}`);
  const wantPurview = await yes("Provision Microsoft Purview (DLP policy, DSPM, live validation)?", true, "wantPurview");
  let scopeInclusions = [{ Type: "Tenant", Identity: "All" }], scopeLabel = "n/a (Purview not provisioned)", pilotPlan = null, scopeChoice = "1";
  let dlpMode = "TestWithNotifications", wantCreditCard = false, customSitTerms = [], failClosed = true, wantDspm = false, dspmIngest = false;
  if (wantPurview) {
    // --- policy scope: pilot group by default, tenant-wide only on purpose ---
    console.log(`\n${C.b}Who should this DLP policy apply to?${C.reset}`);
    console.log(`  ${C.d}1) A pilot group  (recommended — start small, expand later)`);
    console.log(`  2) Specific users`);
    console.log(`  3) Everyone in the tenant  (production-wide)${C.reset}`);
    scopeChoice = await ask("Choose 1/2/3:", "1", "scopeChoice");

    if (scopeChoice === "3") {
      warn("Tenant-wide means EVERY user in this tenant is subject to the policy.");
      if (!(await yes("Are you sure you want tenant-wide scope?", false, "confirmTenantWide"))) { closeInput(); die("Aborted — re-run and pick a pilot group."); }
      if ((await ask(`Type ${C.b}TENANT-WIDE${C.reset} to confirm:`, "", "typeTenantWide")) !== "TENANT-WIDE") { closeInput(); die("Not confirmed. Aborted."); }
      scopeInclusions = [{ Type: "Tenant", Identity: "All" }];
      scopeLabel = "ALL USERS IN TENANT";
    } else if (scopeChoice === "2") {
      const upns = (await ask("Pilot user UPNs (comma-separated):", attribUpn, "pilotUsers")).split(",").map((s) => s.trim()).filter(Boolean);
      if (!upns.length) { closeInput(); die("No users given."); }
      const ids = [];
      for (const u of upns) {
        try { ids.push(await userIdOf(u)); }
        catch { closeInput(); die(`User "${u}" not found in this tenant.`); }
      }
      // Purview can't bind to users, so these people go into a pilot group
      // that is created after "Proceed" (never during a rehearsal).
      pilotPlan = {
        displayName: `${purviewAppName} Pilot`,
        mailNickname: slugify(`${purviewAppName}-pilot`),
        memberIds: ids, upns,
      };
      scopeLabel = `pilot group "${pilotPlan.displayName}" (${upns.length}: ${upns.join(", ")})`;
    } else {
      const grp = await ask("Pilot group email / object id:", "", "pilotGroup");
      if (!grp) { closeInput(); die("A pilot group is required for scope 1. Create one in Entra, or pick option 2 or 3."); }
      // Checked even in a dry run: it's a read-only lookup, and a rehearsal that
      // can't catch what provisioning would fail on is worthless.
      let g;
      try { g = await groupLookup(grp); }
      catch { closeInput(); die(`Group "${grp}" not found in this tenant. Pick "Just me", or create the group in Entra first.`); }
      if (!g?.mail) {
        closeInput();
        die(`Group "${g?.displayName ?? grp}" has no mail address. Purview DLP can only bind to a Microsoft 365 group or a mail-enabled group — pick one of those, or choose "Just me".`);
      }
      scopeInclusions = [{ Type: "Group", Identity: g.mail }];
      scopeLabel = `group ${g.displayName} <${g.mail}>`;
    }

    // --- enforcement mode: test by default ---
    console.log(`\n${C.b}Enforcement mode?${C.reset}`);
    console.log(`  ${C.d}1) Test with notifications  (recommended — audits and alerts, blocks nothing)`);
    console.log(`  2) Test without notifications  (silent audit only)`);
    console.log(`  3) Enable  (actively BLOCKS matching prompts)${C.reset}`);
    const modeChoice = await ask("Choose 1/2/3:", "1", "modeChoice");
    if (modeChoice === "3") {
      warn("Enable means matching prompts are BLOCKED for everyone in scope, in production.");
      if (!(await yes("Turn on active blocking now?", false, "confirmEnforce"))) { closeInput(); die("Aborted — re-run and choose a test mode."); }
      if ((await ask(`Type ${C.b}ENFORCE${C.reset} to confirm:`, "", "typeEnforce")) !== "ENFORCE") { closeInput(); die("Not confirmed. Aborted."); }
      dlpMode = "Enable";
    } else if (modeChoice === "2") dlpMode = "TestWithoutNotifications";

    wantCreditCard = await yes("Create a DLP rule for Credit Card Numbers?", true, "wantCreditCard");
    customSitTerms = (await ask("Extra block keywords (comma-separated, e.g. salary,compensation) or blank:", "", "customSitTerms")).split(",").map((s) => s.trim()).filter(Boolean);
    failClosed = await yes("Fail CLOSED (block when Purview is unreachable)?", true, "failClosed");

    // --- DSPM ingestion is a data-residency decision, not a checkbox ---
    console.log(`\n${C.b}DSPM for AI collection policy${C.reset}`);
    console.log(`  ${C.d}Captures prompts and replies so they appear in DSPM for AI and Activity Explorer.`);
    console.log(`  This STORES the full text of user prompts and model responses in Microsoft Purview.`);
    console.log(`  Confirm with the customer's privacy/data-residency owner before enabling.${C.reset}`);
    wantDspm = await yes("Create the DSPM collection policy?", true, "wantDspm");
    dspmIngest = wantDspm ? await yes("  Store full prompt/response content (ingestion)?", false, "dspmIngest") : false;

  }

  // --- Agent 365 registration (identity + registry + Activity tab) ---
  console.log(`\n${C.b}Agent 365 registration${C.reset}`);
  console.log(`  ${C.d}Creates the agent identity blueprint and registers the agent in the`);
  console.log(`  Agent 365 registry so admins can see, govern and secure it.`);
  console.log(`  The agent's endpoint may be ANY https URL — including a governance`);
  console.log(`  proxy in front of a third-party agent you cannot modify.${C.reset}`);
  const wantAgent365 = await yes("Register this agent in Agent 365?", true, "wantAgent365");

  let agentName = "", agentUrl = "", sponsorUpn = "", existingBlueprintId = "", transport = "JSONRPC", messagingEndpoint = "";
  let wantTeams = false, agentDescription = "";
  let wantConsent = false, wantObservability = false, teamsPublish = false, teamsInstall = false, teamsEndpoint = false, teamsHello = false, teamsMode = "teammate", wantLicence = true;
  if (wantAgent365) {
    agentName = await ask("  Agent display name:", purviewAppName, "agentName");
    const urlDefault = azureApp?.host ? `https://${azureApp.host}` : (azureProxy ? `https://${azureProxy.name}.azurewebsites.net` : "");
    agentUrl = await ask("  Agent endpoint URL (https):", urlDefault, "agentUrl");
    while (wantAgent365 && !/^https:\/\//i.test(agentUrl)) {
      warn("  An https endpoint is required to register an agent instance.");
      agentUrl = await ask("  Agent endpoint URL (https):", "", "agentUrl");
      if (ANSWERS) die("agentUrl in the answers file is not a valid https URL.");
    }
    transport = (await ask("  Transport (JSONRPC / HTTP+JSON / GRPC):", "JSONRPC", "transport")).toUpperCase()
      .replace("HTTP+JSON", "HTTP+JSON");
    sponsorUpn = await ask("  Blueprint sponsor (UPN — required by the API):", acct.user.name, "sponsorUpn");
    existingBlueprintId = await ask("  Reuse an existing blueprint object id [blank = create new]:", "", "existingBlueprintId");
    messagingEndpoint = await ask("  Messaging endpoint (where Teams delivers messages):", `${agentUrl.replace(/\/+$/, "")}/api/messages`, "messagingEndpoint");
    agentDescription = await ask("  One-line description (shown in Teams):", `${agentName} — governed by Microsoft Agent 365`, "agentDescription");
    wantConsent = await yes("  Grant tenant-wide admin consent (Messaging Bot API, Observability API, Agent 365 Tools)?", true, "wantConsent");
    wantObservability = await yes("  Turn on observability (Agent 365 Activity tab)?", true, "wantObservability");
    wantTeams = await yes("  Publish to Teams?", true, "wantTeams");
    if (wantTeams) {
      console.log(`    ${C.d}1) As an AI teammate — a person in Teams you chat with (Microsoft's supported path for agent identities)`);
      console.log(`    2) As a Teams app / bot — classic channel; Microsoft's own CLI calls this "not yet implemented" for blueprint agents${C.reset}`);
      teamsMode = (await ask("    How should it appear in Teams? (1/2):", "1", "teamsMode")) === "2" ? "bot" : "teammate";
      if (teamsMode === "bot") warn("    Classic bots cannot mint a reply token as an agentic blueprint (AADSTS82001) — this mode is for non-agentic bot identities.");
      teamsPublish = await yes("    Publish the app to the org app catalog?", true, "teamsPublish");
      teamsInstall = await yes("    Install it for the pilot users?", true, "teamsInstall");
      teamsEndpoint = await yes("    Register the messaging endpoint (Teams Developer Portal)?", true, "teamsEndpoint");
      teamsHello = await yes("    Send a hello from the agent into your Teams?", true, "teamsHello");
      if (teamsMode === "teammate") wantLicence = await yes("    Assign the tenant's Agent 365 licence to the agent user?", true, "wantLicence");
    }
  }
  if (!wantPurview && !wantAgent365) { closeInput(); die("Nothing selected: turn on Purview, Agent 365, or both."); }

  [["App registration name", appRegName], ["Purview app name", purviewAppName], ["Agent name", agentName]]
    .forEach(([n, v]) => assertEnvSafe(n, v));

  const runner = (lang === "proxy" || hosting !== "local") ? { kind: "", detail: "" } : detectRunner(agentDir);
  const wantRestart = (lang === "proxy" || hosting !== "local") ? false : await yes(
    runner.kind
      ? `\nRestart the agent when done? (found ${runner.detail})`
      : "\nRestart the agent when done? (no running process, pm2, launchd or systemd unit found for that folder — it will be reported instead)", true, "wantRestart");
  const revokeAfter = !wantPurview ? false : await yes(
    "\nAfter provisioning, revoke the connector's Compliance Administrator + Exchange.ManageAsApp?\n" +
    `  ${C.d}(Only needed to CREATE policies. Runtime needs neither. Re-grant to change policies later.)${C.reset}`, true, "revokeAfter");

  console.log(`\n${C.b}About to provision in tenant ${tenantId}:${C.reset}`);
  console.log(`  • App registration "${appRegName}" + secret${wantPurview ? " + cert" : ""}`);
  if (wantPurview) {
  console.log(`  • Graph: Content.Process.All, ProtectionScopes.Compute.All; Exchange.ManageAsApp; Compliance Administrator role`);
  console.log(`  • DLP policy "${purviewAppName} DLP"${wantCreditCard ? " + Credit Card rule" : ""}${customSitTerms.length ? ` + custom SIT (${customSitTerms.join(", ")})` : ""}`);
  console.log(`      mode:  ${dlpMode === "Enable" ? `${C.r}${C.b}Enable (ACTIVE BLOCKING)${C.reset}` : `${C.g}${dlpMode}${C.reset}`}`);
  console.log(`      scope: ${scopeChoice === "3" ? `${C.r}${C.b}${scopeLabel}${C.reset}` : `${C.g}${scopeLabel}${C.reset}`}`);
  console.log(`  • DSPM collection policy: ${wantDspm ? `yes (ingestion ${dspmIngest ? `${C.y}ON — stores prompt text${C.reset}` : "OFF"})` : "no"}`);
  } else {
  console.log(`  • Purview: ${C.y}not provisioned${C.reset} (guard written disabled)`);
  }
  const settingsTarget = hosting === "local" ? envPath
    : (azureProxy ? `App Settings on a new App Service "${azureProxy.name}" (${azureProxy.resourceGroup}, ${azureProxy.location}) running the proxy image`
      : hosting === "webapp" ? `App Settings on App Service ${azureApp?.name}${azureKeyVault ? ` (secrets in Key Vault ${azureKeyVault})` : ""}, then restart`
      : `env of Container App ${azureApp?.name} (secrets as secrets), new revision`);
  console.log(`  • Write ${settingsTarget}${hosting === "local" && existsSync(envPath) ? `  ${C.d}(backup → ${envPath}.bak)${C.reset}` : ""}`);
  console.log(`  • Post-provision revoke of admin privileges: ${revokeAfter ? "yes" : `${C.y}no — connector keeps Compliance Administrator${C.reset}`}`);
  if (wantAgent365) {
    console.log(`  • Agent 365: ${existingBlueprintId ? `reuse blueprint ${existingBlueprintId}` : "create identity blueprint + secret"}`);
    console.log(`               register instance "${agentName}" at ${agentUrl} (${transport})`);
    console.log(`               consent ${wantConsent ? "yes" : "no"}, observability ${wantObservability ? "on" : "off"}`);
    console.log(`  • Teams: ${wantTeams ? (teamsMode === "teammate"
      ? [`AI teammate: register ${messagingEndpoint} with the Agent 365 service`, "create the agent user", wantLicence && "assign the Agent 365 licence", teamsHello && "send a hello"].filter(Boolean).join(", ")
      : [teamsPublish && "publish to the org app catalog", teamsInstall && "install for the pilot users", teamsEndpoint && `register ${messagingEndpoint} (Developer Portal)`, teamsHello && "send a hello"].filter(Boolean).join(", ")) : `${C.y}not published${C.reset}`}`);
  } else {
    console.log(`  • Agent 365: ${C.y}not registered${C.reset}`);
  }
  console.log("");

  if (DRY_RUN) {
    if (pilotPlan) plan(`create pilot group "${pilotPlan.displayName}" with ${pilotPlan.memberIds.length} member(s) and scope the DLP policy to it`);
    plan(`create the app registration, secret${wantPurview ? ", certificate" : ""} and role assignments`);
    if (wantPurview) plan(`create DLP policy in ${dlpMode} mode scoped to ${scopeLabel}`);
    plan(`write ${settingsTarget}`);
    if (wantAutoWire) plan("install the kit into the agent, write agent365-guard.preload.mjs, and update its start script (automatic guard)");
    if (wantPurview) plan("validate with token → protectionScopes/compute → processContent");
    // Render the closing output now (nothing is written) so a rehearsal
    // exercises the same reporting code a real run finishes with.
    void integrationSnippet(lang, { envPath, upstreamUrl, proxyPort, agentUrl });
    void agent365Checklist({ agentName: agentName || purviewAppName, lang, blueprintId: "", blueprintAppId: "", messagingEndpoint });
    if (wantAgent365) {
      plan(`create the agent identity blueprint and register "${agentName}" at ${agentUrl}`);
      plan("verify the registration by reading it back from the Agent 365 registry");
      if (wantConsent) plan("grant tenant-wide admin consent from the blueprint to the Agent 365 resources");
      if (wantTeams && teamsMode === "teammate") {
        if (teamsEndpoint) plan("register the messaging endpoint with Microsoft's Agent 365 service (consenting the setup sign-in to it once)");
        plan(`create the agent user ${slugify(agentName)}@${org} under the agent identity${wantLicence ? " and assign the Agent 365 licence" : ""}`);
        if (teamsHello) plan("tell you how to open a chat with it in Teams");
      } else if (wantTeams) {
        if (teamsPublish) plan("build the Teams app package (id = blueprint appId) and publish it to the org app catalog");
        if (teamsInstall) plan("install the Teams app for the pilot users");
        if (teamsEndpoint) plan("register the messaging endpoint in the Teams Developer Portal");
        if (teamsHello) plan("send a hello from the agent into your Teams to prove the path");
      }
    }
    console.log(`\n${C.c}Dry run complete — nothing was changed.${C.reset}\n`);
    closeInput();
    return;
  }
  if (!(await yes("Proceed?", true, "proceed"))) { closeInput(); die("Aborted."); }

  // ---- 0. pilot group (scope = specific people) ----
  let pilotGroupId = scopeInclusions?.[0]?.Type === "Group" && scopeChoice === "1" ? (await groupLookup(scopeInclusions[0].Identity)).id : "";
  if (pilotPlan) {
    info(`Creating pilot group "${pilotPlan.displayName}"…`);
    const g = await ensurePilotGroup({ ...pilotPlan, ownerId: account.id });
    scopeInclusions = [{ Type: "Group", Identity: g.mail }];
    pilotGroupId = g.id;
    if (g.created) record(`pilot group "${g.displayName}" (${g.id}) — delete in Entra → Groups`);
    ok(`Pilot group ${g.mail} ${g.created ? "created" : "reused"} — ${pilotPlan.memberIds.length} member(s)`);
  }

  // ---- 1. app registration + SP + secret ----
  info("Creating app registration…");
  let app = (await dg("GET", `/v1.0/applications?$filter=displayName eq '${odata(appRegName)}'&$select=id,appId`))?.value?.[0] ?? null;
  if (app) {
    warn(`An app registration named "${appRegName}" already exists (${app.appId}) — reusing it and appending a new credential.`);
    if (!(await yes("  Continue with the existing app?", true, "reuseExistingApp"))) { closeInput(); die("Aborted."); }
  } else {
    app = await dg("POST", "/v1.0/applications", { displayName: appRegName, signInAudience: "AzureADMyOrg" });
    record(`app registration "${appRegName}" (${app.appId}) — delete in Entra → App registrations`);
  }
  const appId = app.appId;
  const spId = (await withReplicationLocal(() => ensureSp(appId))).id;
  const secretObj = await withReplicationLocal(() => dg("POST", `/v1.0/applications/${app.id}/addPassword`,
    { passwordCredential: { displayName: "purview-daemon", endDateTime: new Date(Date.now() + 730 * 86400e3).toISOString() } }));
  const clientSecret = secretObj.secretText;
  record(`client secret "purview-daemon" on app ${appId}`);
  ok(`App ${appId}`);

  // ---- 2. graph permissions + consent (assign roles directly = reliable) ----
  info("Granting Graph + Exchange permissions…");
  const graphSp = (await ensureSp(GRAPH_APP)).id;
  const exoSp = (await ensureSp(EXO_APP)).id;
  const assignRole = async (resourceId, roleId, label) => {
    try {
      await withReplicationLocal(() => dg("POST", `/v1.0/servicePrincipals/${spId}/appRoleAssignments`, { principalId: spId, resourceId, appRoleId: roleId }));
      record(`app role ${label} on SP ${spId}`);
    } catch (e) { if (!/already exists/i.test(String(e.message || e))) throw e; }
  };
  const roles = wantPurview ? [
    [graphSp, ROLE_CONTENT_PROCESS, "Content.Process.All"],
    [graphSp, ROLE_PROTECTION_SCOPES, "ProtectionScopes.Compute.All"],
    [exoSp, ROLE_EXCHANGE_MANAGE, "Exchange.ManageAsApp"],
  ] : [];
  if (wantAgent365) {
    // Registration is performed by this app: the admin's delegated token has no agent scopes.
    roles.push(
      [graphSp, ROLE_AGENT_INSTANCE_RW, "AgentInstance.ReadWrite.All"],
      [graphSp, ROLE_AGENT_BLUEPRINT_RW, "AgentIdentityBlueprint.ReadWrite.All"],
      [graphSp, ROLE_AGENT_BLUEPRINT_CREATE, "AgentIdentityBlueprint.Create"],
      [graphSp, ROLE_AGENT_BLUEPRINT_CREDS, "AgentIdentityBlueprint.AddRemoveCreds.All"],
      [graphSp, ROLE_AGENT_CARD_RW, "AgentCardManifest.ReadWrite.All"],
      [graphSp, ROLE_AGENT_BLUEPRINT_AUTH, "AgentIdentityBlueprint.UpdateAuthProperties.All"],
      [graphSp, ROLE_AGENT_PRINCIPAL_CREATE, "AgentIdentityBlueprintPrincipal.Create"],
      [graphSp, ROLE_AGENT_IDENTITY_CREATE, "AgentIdentity.Create.All"],
      [graphSp, ROLE_AGENT_IDENTITY_READ, "AgentIdentity.Read.All"],
      [graphSp, ROLE_AGENT_REGISTRATION_RW, "AgentRegistration.ReadWrite.All"],
      [graphSp, ROLE_COPILOT_PACKAGES_RW, "CopilotPackages.ReadWrite.All"]);
  }
  for (const [rid, role, label] of roles) await assignRole(rid, role, label);
  ok("App-role assignments granted");

  let complianceAssignmentId = "", pfxPw = "", pfx = "", policiesOk = true;
  if (wantPurview) {
  // ---- 3. cert + Compliance Administrator role ----
  info("Creating certificate and assigning Compliance Administrator…");
  // Random, high-entropy, and never placed on a command line or in a file.
  pfxPw = randomBytes(24).toString("base64url");
  const { certPem, pfxPath } = makeCertificate({ work, subjectName: appRegName, pfxPw }); pfx = pfxPath;
  const certDer = readFileSync(certPem, "utf8").replace(/-----[A-Z ]+-----|\s+/g, "");
  {
    // keyCredentials is replaced wholesale on PATCH: keep what is there.
    const cur = await dg("GET", `/v1.0/applications/${app.id}?$select=keyCredentials`);
    const keep = (cur?.keyCredentials ?? []).map(({ keyId, type, usage, customKeyIdentifier, displayName, startDateTime, endDateTime }) =>
      ({ keyId, type, usage, customKeyIdentifier, displayName, startDateTime, endDateTime }));
    await dg("PATCH", `/v1.0/applications/${app.id}`, { keyCredentials: [...keep, { type: "AsymmetricX509Cert", usage: "Verify", key: certDer, displayName: "agent365-governance-kit provisioning" }] });
  }
  record(`certificate credential on app ${appId}`);

  complianceAssignmentId = "";
  try {
    const ra = await withReplicationLocal(() => dg("POST", "/v1.0/roleManagement/directory/roleAssignments",
      { principalId: spId, roleDefinitionId: ROLE_COMPLIANCE_ADMIN, directoryScopeId: "/" }));
    complianceAssignmentId = ra?.id ?? "";
    record(`Compliance Administrator directory role on SP ${spId}`);
  } catch (e) {
    const msg = String(e.message || e);
    if (/conflict|exist/i.test(msg)) {
      // Already assigned — look up the existing assignment so we can still revoke it later.
      try {
        complianceAssignmentId = (await dg("GET",
          `/v1.0/roleManagement/directory/roleAssignments?$filter=principalId eq '${spId}' and roleDefinitionId eq '${ROLE_COMPLIANCE_ADMIN}'`))?.value?.[0]?.id ?? "";
      } catch { /* non-fatal */ }
    } else {
      // Don't leave the operator guessing what already exists in their tenant.
      console.error(`\n${C.r}Could not assign the Compliance Administrator role.${C.reset}`);
      console.error(`${C.d}${msg.trim()}${C.reset}`);
      console.error(`\n${C.y}The tenant may need the directory role activated first, or your account may lack Privileged Role Administrator.${C.reset}`);
      printJournal();
      closeInput();
      die("Stopped before creating policies. Nothing else was changed.");
    }
  }
  ok("Certificate uploaded, Compliance Administrator assigned");

  }

  // ---- resolve attributed user + onmicrosoft domain ----
  const userId = await userIdOf(attribUpn);
  if (!org) die("This tenant has no *.onmicrosoft.com verified domain; Connect-IPPSSession needs one.");

  if (wantPurview) {
  // ---- 4. DLP + collection policies via Security & Compliance PowerShell ----
  info("Provisioning Purview policies (this can retry while permissions propagate)…");
  const ps = buildProvisionScript({
    appId, org, pfx, purviewAppName, wantCreditCard, customSitTerms, work,
    dlpMode, scopeInclusions, wantDspm, dspmIngest,
  });
  const psPath = join(work, "provision.ps1");
  writeFileSync(psPath, ps, { mode: 0o600 });
  policiesOk = true;
  try {
    // Password crosses to pwsh via the environment, never via the script text.
    // Output is forwarded line by line minus MSAL's raw token-error dump, which
    // is written to the process console (not a PowerShell stream) on a failed
    // connect attempt and would otherwise fill a customer's log with headers.
    runFiltered(PWSH, ["-NoProfile", "-File", psPath], { ...procEnv, A365_PFX_PW: pfxPw });
    record(`DLP policy "${purviewAppName} DLP" (${dlpMode}, ${scopeLabel})`);
    if (wantDspm) record("DSPM for AI collection policy");
  } catch {
    policiesOk = false;
    warn("Policy provisioning reported an error — review the output above.");
    warn("The connector + permissions are still set. Re-run the wizard to retry policy creation.");
  }

  }

  // ---- 4b. Agent 365: blueprint → secret → principal → identity → registration ----
  // Every call here has been run live against a licensed tenant. Failures are
  // reported, not fatal: Purview provisioning above already succeeded.
  let a365 = null;
  if (wantAgent365) {
    info("Registering in Agent 365 (identity blueprint + agent identity + registry)…");
    try {
      let sponsorId;
      try { sponsorId = await userIdOf(sponsorUpn); }
      catch (e) { throw new Error(e.status === 404 ? `sponsor "${sponsorUpn}" not found in this tenant` : `sponsor lookup failed — ${e.message}`); }
      // The resource service principals must exist BEFORE the blueprint makes
      // their scopes inheritable: Graph accepts the POST for a missing SP and
      // silently drops it (observed live: 3 reported, 1 read back).
      for (const res of A365_RESOURCES) {
        try { if (!(await spByAppId(res.appId))) { info(`  creating service principal for ${res.name}`); await ensureSp(res.appId); } }
        catch (e) { warn(`  could not create ${res.name} service principal: ${String(e.message || e).slice(0, 100)}`); }
      }
      const graph = makeGraphClient({ tenantId, clientId: appId, clientSecret });
      // Never register on a token that does not yet carry the roles granted a
      // few minutes ago; that is exactly how this stage failed once, live.
      const rolesWanted = ["AgentIdentityBlueprint.Create", "AgentIdentityBlueprintPrincipal.Create", "AgentIdentity.Create.All", "AgentRegistration.ReadWrite.All"];
      const ready = await waitForConnectorRoles({ tenantId, clientId: appId, clientSecret, required: rolesWanted, log: (m) => info(`  ${m}`) });
      if (!ready.ok) throw new Error(`the connector's token still lacks ${ready.missing.join(", ")} after ${Math.round(ready.waitedMs / 60000)} minutes — Entra has not propagated the app roles; re-run in a few minutes`);
      if (ready.attempts > 1) ok(`  connector permissions active after ${Math.round(ready.waitedMs / 1000)}s`);
      a365 = await registerAgent(graph, {
        agentName,
        agentDescription: agentDescription || `${agentName} — governed by the Agent 365 Governance Kit`,
        agentUrl,
        sponsorIds: [sponsorId],
        ownerIds: [sponsorId],
        managedByAppId: appId,
        organization: purviewAppName,
        existingBlueprintId,
        // Consent the blueprint principal BEFORE the identity exists, so the
        // identity inherits it; then consent the identity itself as well.
        beforeIdentity: async (r) => {
          if (!wantConsent) return;
          try { for (const line of await grantBlueprintConsent({ blueprintPrincipalId: r.blueprintPrincipalId })) (line.startsWith("WARNING") ? warn : ok)(`  ${line}`); }
          catch (e) { warn(`  consent grants (blueprint) failed: ${String(e.message || e).slice(0, 200)}`); }
        },
      }, (m) => info(`  ${m}`));
      for (const st of a365.steps) ok(`  ${st}`);
      // Admin consent — the step that makes the Activity tab and Teams delivery possible.
      if (wantConsent) {
        try {
          // The identity was created seconds ago: retry while the directory catches up.
          for (const line of await withReplicationLocal(() => grantBlueprintConsent({ blueprintPrincipalId: a365.agentIdentityId }))) {
            (line.startsWith("WARNING") ? warn : ok)(`  ${line.replace(/^consent/, "identity consent")}`);
          }
        } catch (e) { warn(`  consent grants (identity) failed: ${String(e.message || e).slice(0, 200)}`); }
      } else {
        warn("  admin consent skipped by choice — Teams delivery and the Activity tab need it; grant it in Entra later or re-run.");
      }
      record(`Agent 365 blueprint ${a365.blueprintId} (appId ${a365.blueprintAppId}) — delete in Entra → Agent identities`);
      record(`Agent 365 registration ${a365.registrationId} — delete with: DELETE https://graph.microsoft.com/beta/copilot/agentRegistrations/${a365.registrationId}`);
      if (!a365.verified) warn("  Registration could not be read back — check M365 admin center → Agents.");
    } catch (e) {
      a365 = null;
      warn(`Agent 365 registration failed: ${String(e.message).slice(0, 400)}`);
      warn("  The connector was granted the agent app roles; a fresh grant can take a few");
      warn("  minutes to reach a token. Re-run the wizard to retry. Purview is unaffected.");
    }
  }

  // ---- 4c. Teams: org catalog → pilot installs → messaging endpoint ----
  // The app id IS the blueprint appId, so registry, bot and Teams app are one identity.
  let teams = null;
  if (a365 && wantTeams) {
    info("Publishing to Teams…");
    teams = { teamsAppId: "", installed: [], endpoint: null, errors: [], mode: teamsMode, agentUser: null, licence: null };
    if (teamsMode === "teammate") {
      // ---- AI teammate: Agent 365 service endpoint → agent user → licence ----
      try {
        const c = await ensureAgent365ServiceConsent(dg);
        if (c !== "present") ok(`  consented the setup sign-in to the Agent 365 service (${c})`);
        const svc = makeAgent365Service(cache);
        if (teamsEndpoint) {
          teams.endpoint = { action: "registered", ...(await registerAgent365Endpoint(svc, { tenantId, blueprintAppId: a365.blueprintAppId, callbackUri: messagingEndpoint })) };
          ok(`  messaging endpoint registered with the Agent 365 service: ${messagingEndpoint}`);
          record(`Agent 365 messaging endpoint for blueprint ${a365.blueprintAppId} — remove with POST ${"https://agent365.svc.cloud.microsoft"}/agents/botManagement/deleteAgentBlueprint`);
        }
      } catch (e) { teams.errors.push(`endpoint: ${String(e.message || e).slice(0, 300)}`); warn(`  Agent 365 endpoint registration failed: ${String(e.message || e).slice(0, 300)}`); }
      try {
        const me = await dg("GET", "/v1.0/me?$select=usageLocation");
        teams.agentUser = await withReplicationLocal(() => ensureAgentUser(dg, { displayName: agentName, mailNickname: slugify(agentName), domain: org, agentIdentityId: a365.agentIdentityId, usageLocation: me?.usageLocation || "US" }));
        ok(`  agent user ${teams.agentUser.created ? "created" : "reused"}: ${teams.agentUser.userPrincipalName}`);
        record(`agent user ${teams.agentUser.userPrincipalName} (${teams.agentUser.id}) — delete in Entra → Users`);
        if (wantLicence) {
          teams.licence = await withReplicationLocal(() => assignAgentLicence(dg, teams.agentUser.id));
          if (teams.licence.status === "none") warn("  no Agent 365 / Frontier licence with free seats in this tenant — assign one to the agent user by hand");
          else ok(`  licence ${teams.licence.status}: ${teams.licence.sku}`);
        }
      } catch (e) { teams.errors.push(`agent user: ${String(e.message || e).slice(0, 300)}`); warn(`  agent user step failed: ${String(e.message || e).slice(0, 300)}`); }
    }
    if (teamsMode === "bot" && teamsPublish) try {
      const { zip } = buildTeamsPackage({
        blueprintAppId: a365.blueprintAppId, agentName, description: agentDescription, agentUrl,
        developer: { name: orgName || purviewAppName },
      });
      const pub = await publishToOrgCatalog(dg, zip, a365.blueprintAppId);
      teams.teamsAppId = pub.teamsAppId;
      ok(`  Teams app ${pub.action} in the org app catalog (${pub.teamsAppId})`);
      record(`Teams app ${pub.teamsAppId} in the org catalog — remove in Teams admin center → Manage apps`);
    } catch (e) { teams.errors.push(`publish: ${String(e.message || e).slice(0, 300)}`); warn(`  Teams publish failed: ${String(e.message || e).slice(0, 300)}`); }

    if (teamsMode === "bot" && teamsEndpoint) try {
      if (!(await devPortalSignIn())) throw new Error("no Teams Developer Portal sign-in (the installer asks for it)");
      teams.endpoint = await registerMessagingEndpoint(devPortal, {
        botId: a365.blueprintAppId, name: agentName, description: agentDescription, messagingEndpoint,
      });
      ok(`  messaging endpoint ${teams.endpoint.action}: ${messagingEndpoint}`);
      record(`Developer Portal bot ${a365.blueprintAppId} — remove in Teams Developer Portal → Tools → Bot management`);
    } catch (e) {
      teams.errors.push(`endpoint: ${String(e.message || e).slice(0, 300)}`);
      warn(`  messaging endpoint not registered: ${String(e.message || e).slice(0, 300)}`);
      warn(`  Do it by hand: Teams Developer Portal → Tools → Bot management → New bot → Bot ID ${a365.blueprintAppId}, endpoint ${messagingEndpoint}`);
    }

    if (teams.teamsAppId && teamsInstall) {
      // Who gets it in their app bar: the attributed user, the admin, and the pilot group.
      const targets = new Set([userId, account.id]);
      if (pilotGroupId) {
        try {
          const members = await dg("GET", `/v1.0/groups/${pilotGroupId}/members/microsoft.graph.user?$select=id&$top=200`);
          for (const m of members?.value ?? []) targets.add(m.id);
        } catch (e) { warn(`  could not list pilot group members: ${String(e.message || e).slice(0, 120)}`); }
      }
      // Teams creates the chat thread with the bot on install, which needs the
      // bot registration (previous step) to have reached its backend.
      let attempt = 0;
      for (;;) {
        teams.installed = await installForUsers(dg, teams.teamsAppId, [...targets]);
        const transient = teams.installed.filter((x) => x.status === "failed" && /CreateThreadS2SRequest|Skype backend/i.test(x.error));
        if (!transient.length || ++attempt >= 6) break;
        info(`  ${transient.length} install(s) not accepted yet (bot registration propagating) — retrying in 20s`);
        await new Promise((r) => setTimeout(r, 20000));
      }
      const done = teams.installed.filter((x) => x.status !== "failed").length;
      const failed = teams.installed.filter((x) => x.status === "failed");
      ok(`  installed for ${done}/${teams.installed.length} user(s)`);
      for (const f of failed) warn(`    ${f.userId}: ${f.error.slice(0, 160)}`);
    }
  }

  // ---- 5. write .env ----
  info(`Writing ${settingsTarget}…`);
  // Lines a previous run wrote inside the managed block, so a partial re-run
  // (Purview only, or Agent 365 only) never erases the other half.
  const prevBlock = await (async () => {
    if (hosting === "webapp" && azureApp) { try { return Object.entries(await getAppSettings(arm, azureApp)).map(([k, v]) => `${k}=${v}`); } catch { return []; } }
    if (hosting !== "local") return [];
    if (!existsSync(envPath)) return [];
    const prev = readFileSync(envPath, "utf8").split("\n");
    const i = prev.indexOf(BEGIN), j = prev.indexOf(END);
    return i > -1 && j > i ? prev.slice(i + 1, j) : [];
  })();
  const prevPurview = prevBlock.filter((l) => /^PURVIEW_/.test(l));
  const block = !wantPurview && prevPurview.length
    ? ["# --- Agent 365 Governance Kit (Purview — kept from the previous run) ---", ...prevPurview]
    : [
    "# --- Agent 365 Governance Kit (Purview) ---",
    `PURVIEW_ENABLED=${wantPurview}`,
    `PURVIEW_TENANT_ID=${tenantId}`,
    `PURVIEW_CLIENT_ID=${appId}`,
    `PURVIEW_CLIENT_SECRET=${clientSecret}`,
    `PURVIEW_APP_LOCATION=${appId}`,
    `PURVIEW_USER_ID=${userId}`,
    `PURVIEW_USER_UPN=${attribUpn}`,
    `PURVIEW_APP_NAME=${purviewAppName}`,
    `PURVIEW_FAIL_CLOSED=${failClosed}`,
    "PURVIEW_TIMEOUT_MS=10000",
    "PURVIEW_MAX_RETRIES=3",
  ];
  if (a365 && a365.blueprintId) {
    block.push("", "# --- Agent 365 identity + observability ---",
      `ENABLE_A365_OBSERVABILITY_EXPORTER=${wantObservability}`,
      "A365_OBSERVABILITY_LOG_LEVEL=info|warn|error",
      "# Microsoft's OpenTelemetry distro logs export results through a diagnostics logger that",
      "# defaults to a temp FILE; route it to the console at WARN so a failed export is visible.",
      "APPLICATIONINSIGHTS_LOG_DESTINATION=console",
      "OTEL_LOG_LEVEL=WARN",
      `agent365Observability__tenantId=${tenantId}`,
      `agent365Observability__clientId=${a365.blueprintAppId}`,
      `agent365Observability__clientSecret=${a365.blueprintSecret}`,
      `agent365Observability__agentBlueprintId=${a365.blueprintAppId}`,
      `agent365Observability__agentId=${a365.agentIdentityId}`,
      `agent365Observability__agentName=${agentName}`,
      `agent365Observability__agentDescription=${agentName}`,
      "",
      "# Agent 365 registry (written by the wizard)",
      `AGENT365_REGISTRATION_ID=${a365.registrationId}`,
      `AGENT365_AGENT_IDENTITY_ID=${a365.agentIdentityId}`,
      `AGENT365_BLUEPRINT_PRINCIPAL_ID=${a365.blueprintPrincipalId}`,
      `AGENT365_AGENT_URL=${agentUrl}`,
      `AGENT365_MESSAGING_ENDPOINT=${messagingEndpoint}`,
      `AGENT365_IDENTIFIER_URI=${a365.identifierUri ?? ""}`,
      `AGENT365_TEAMS_APP_ID=${teams?.teamsAppId ?? ""}`,
      `AGENT365_TEAMS_MODE=${teams?.mode ?? ""}`,
      `AGENT365_AGENT_USER_ID=${teams?.agentUser?.id ?? ""}`,
      `AGENT365_AGENT_USER_UPN=${teams?.agentUser?.userPrincipalName ?? ""}`,
      "",
      "# --- Agents SDK runtime connection (Teams / Bot Framework path) ---",
      `agent_id=${a365.blueprintAppId}`,
      `connections__service_connection__settings__clientId=${a365.blueprintAppId}`,
      `connections__service_connection__settings__clientSecret=${a365.blueprintSecret}`,
      `connections__service_connection__settings__tenantId=${tenantId}`,
      `connections__service_connection__settings__scopes=${MESSAGING_BOT_API_APP}/.default`,
      "connectionsMap__0__serviceUrl=*",
      "connectionsMap__0__connection=service_connection",
      "agentic_altBlueprintConnectionName=service_connection",
      "agentic_scopes=https://graph.microsoft.com/.default",
      "agentic_connectionName=AgenticAuthConnection");
  }
  if (!(a365 && a365.blueprintId)) {
    // A Purview-only re-run must not erase the Agent 365 wiring a previous run wrote.
    const keep = prevBlock
      .filter((l) => /^(ENABLE_A365_|A365_OBSERVABILITY|agent365Observability__|AGENT365_|agent_id=|connections__|connectionsMap__|agentic_)/.test(l));
    if (keep.length) { block.push("", "# --- Agent 365 (kept from the previous run) ---", ...keep); info(`  kept ${keep.length} Agent 365 setting(s) from the previous run`); }
  }
  if (lang === "proxy") {
    block.push("", "# --- governance proxy (fronts a third-party agent) ---",
      `GOVERNANCE_UPSTREAM=${upstreamUrl}`,
      `GOVERNANCE_DIALECT=${upstreamDialect}`,
      `GOVERNANCE_UPSTREAM_PATH=${upstreamPath || "/"}`,
      `GOVERNANCE_PROXY_PORT=${proxyPort}`);
  }
  let how = "";
  if (hosting === "local") {
    try { const dir = envPath.replace(/[^/\\]*$/, ""); if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch { /* writeEnvBlock reports */ }
    how = writeEnvBlock(envPath, block);
    record(`.env block ${how} at ${envPath}`);
    ok(`.env ${how} (${envPath})`);
  } else {
    // Azure: the same keys, as App Settings / container env. Existing settings are kept.
    let settings = linesToSettings(block);
    if (lang === "proxy" && azureProxy) {
      info(`Deploying the governance proxy to App Service ${azureProxy.name}…`);
      const px = await ensureProxyWebApp(arm, { subscriptionId: azureSubscription, ...azureProxy, settings });
      azureApp = { kind: "webapp", id: px.id, name: px.name, resourceGroup: px.resourceGroup, host: px.host };
      ok(`  proxy App Service ${px.created ? "created" : "updated"}: https://${px.host} (image ${"ghcr.io/ohomaidi/agent365-governance-proxy"})`);
      record(`App Service ${px.name} in ${px.resourceGroup} (${azureSubscription}) — delete the resource group to undo`);
      how = "written as App Settings on the proxy";
    } else if (hosting === "webapp") {
      if (azureKeyVault) {
        const vault = await findKeyVault(arm, azureSubscription, azureKeyVault);
        if (!vault) die(`Key Vault "${azureKeyVault}" not found in subscription ${azureSubscription}.`);
        const kv = makeKeyVault(cache, azureKeyVault);
        const refs = await storeSecretsInKeyVault(kv, settings, slugify(purviewAppName));
        const principalId = await ensureWebAppIdentity(arm, azureApp);
        const g = await grantKeyVaultSecretsUser(arm, vault.id, principalId);
        ok(`  ${Object.keys(refs).length} secret(s) stored in Key Vault ${azureKeyVault}; app identity ${principalId} ${g} Key Vault Secrets User`);
        settings = { ...settings, ...refs };
      }
      const keys = await setAppSettings(arm, azureApp, settings);
      ok(`  ${keys.length} App Settings written on ${azureApp.name} (existing settings kept)`);
      record(`App Settings on ${azureApp.name}: ${keys.join(", ")}`);
      ok(`  ${await restartWebApp(arm, azureApp)}`);
      how = "written as App Settings";
    } else {
      const keys = await setContainerAppEnv(arm, azureApp, settings);
      ok(`  ${keys.length} env value(s) set on container app ${azureApp.name} (secrets as secrets); a new revision is rolling`);
      record(`Container App env on ${azureApp.name}: ${keys.join(", ")}`);
      how = "written to the container app";
    }
    if (messagingEndpoint) {
      info(`Waiting for ${messagingEndpoint} to come back and demand a token…`);
      const ep = await waitForEndpoint(messagingEndpoint);
      if (ep.ok) ok(`  endpoint answers HTTP ${ep.status} (authentication required) after ${ep.attempts} check(s)`);
      else warn(`  endpoint did not come back as expected (last HTTP ${ep.status}); check the app's logs`);
    }
  }

  // ---- 6. validate: token → computeScopes → processContent ----
  if (wantPurview) {
    info("Validating end to end…");
    try {
      const steps = await validate({ tenantId, appId, clientSecret, userId, purviewAppName });
      for (const s of steps) ok(`  ${s}`);
    } catch (e) {
      warn("Validation failed (often just permission/policy propagation — retry in ~15 min):");
      warn(`  ${e.message || e}`);
    }
  }

  // ---- 6b. prove the Teams path from the agent's side ----
  let hello = null;
  if (teams?.mode === "teammate" && teamsHello && teams.agentUser) {
    hello = { ok: false, detail: `chat with ${teams.agentUser.userPrincipalName} in Teams — a proactive first message from an agent user is not offered by Microsoft's connector yet` };
    info(`  Teams: open a chat with "${agentName}" (${teams.agentUser.userPrincipalName}) and send the first message.`);
  } else if (teams?.teamsAppId && a365?.blueprintSecret && teamsHello) {
    info("Sending a hello from the agent into your Teams…");
    hello = await proactiveHello({
      tenantId, blueprintAppId: a365.blueprintAppId, blueprintSecret: a365.blueprintSecret, agentIdentityId: a365.agentIdentityId,
      messagingBotApiAppId: MESSAGING_BOT_API_APP, userId: account.id, agentName,
      text: `Hi, I'm ${agentName}. I'm registered in Microsoft Agent 365 and every message here is checked by Purview. Reply to talk to me.`,
    });
    if (hello.ok) ok(`  ${hello.detail}`);
    else {
      warn(`  hello not sent: ${hello.detail}`);
      warn(`  Teams did not accept a proactive message at the generic service URL. Everything else is in place:`);
      warn(`  open Teams → Apps → "${agentName}" (already installed for you) and send it a message.`);
    }
  }

  // ---- 7. drop provisioning-only privileges ----
  if (revokeAfter && policiesOk) {
    info("Revoking provisioning-only privileges…");
    try {
      const assignments = await dg("GET", `/v1.0/servicePrincipals/${spId}/appRoleAssignments`);
      const exo = (assignments?.value ?? []).find((a) => a.appRoleId === ROLE_EXCHANGE_MANAGE);
      if (exo) {
        await dg("DELETE", `/v1.0/servicePrincipals/${spId}/appRoleAssignments/${exo.id}`);
        ok("  Exchange.ManageAsApp removed");
      }
      if (complianceAssignmentId) {
        await dg("DELETE", `/v1.0/roleManagement/directory/roleAssignments/${complianceAssignmentId}`);
        ok("  Compliance Administrator removed");
      }
      console.log(`  ${C.d}Connector retains only Content.Process.All + ProtectionScopes.Compute.All.${C.reset}`);
      console.log(`  ${C.d}To change policies later, re-run this wizard (it re-grants, then revokes again).${C.reset}`);
    } catch (e) {
      warn(`Could not revoke automatically: ${String(e.message || e).trim()}`);
      warn(`  Remove them by hand in Entra → ${appRegName} → Permissions / Assigned roles.`);
    }
  } else if (wantPurview && !revokeAfter) {
    warn(`Connector ${appId} keeps Compliance Administrator at tenant scope. Remove it when provisioning is done.`);
  }

  // ---- certificate note ----
  console.log(`\n${C.d}The certificate on ${appId} was only needed for policy provisioning; the runtime uses the client secret.`);
  console.log(`  Remove it in Entra → App registrations → ${appRegName} → Certificates & secrets, if you don't plan to re-run the wizard.${C.reset}`);

  closeInput();

  // ---- integration snippet (per language) ----
  if (!wantPurview) {
    console.log(prevPurview.length
      ? `\n${C.d}Purview not touched this run; the previous run's settings are kept.${C.reset}`
      : `\n${C.y}Purview was not provisioned (your choice).${C.reset} The guard is written disabled; re-run with Purview on to enable it.`);
  } else if (lang === "proxy") {
    console.log(`\n${C.g}${C.b}Purview governance is set up.${C.reset} Nothing changes in the vendor's agent; the proxy is the governed endpoint.`);
    if (hosting !== "local") {
      console.log(`  ${C.g}Proxy running in Azure at ${agentUrl}${C.reset} — the vendor API stays where it is; Teams and Agent 365 talk to the proxy.`);
    } else if (wantProxyStart) {
      try {
        const kitRoot = fileURLToPath(new URL("..", import.meta.url));
        const already = existsSync(join(agentDir, "node_modules", "@zaatarlabs", "agent365-governance-proxy"));
        if (!already) { for (const st of scaffoldProxy({ dir: agentDir, tarballs: findProxyTarballs(kitRoot) }).steps) ok(`  ${st}`); }
        else ok("  proxy already installed in this folder");
        if (runner.kind && runner.restart) { ok(`  restarted the proxy: ${await runner.restart()}`); }
        else {
          const h = await startProxy({ dir: agentDir, port: Number(proxyPort) || 8787 });
          if (h.status) ok(`  proxy started (pid ${h.pid}) — guard ${h.guard}, Teams bridge ${h.teams ? "on" : "off"}, governing: ${h.governing}`);
          else warn(`  proxy started (pid ${h.pid}) but its health endpoint did not answer within 20s — see ${join(agentDir, "logs", "proxy.log")}`);
        }
        record(`governance proxy installed and running from ${agentDir} (stop it and delete the folder to undo)`);
        console.log(`  ${C.d}Expose http://localhost:${proxyPort} as ${agentUrl} — that address is what Agent 365 and Teams call.${C.reset}`);
      } catch (e) {
        warn(`Could not install or start the proxy: ${String(e.message || e).slice(0, 300)}`);
        console.log(C.d + integrationSnippet(lang, { envPath, upstreamUrl, proxyPort, agentUrl }) + C.reset);
      }
    } else {
      console.log(C.d + integrationSnippet(lang, { envPath, upstreamUrl, proxyPort, agentUrl }) + C.reset);
    }
  } else if (guardState.wired) {
    console.log(`\n${C.g}${C.b}Purview governance is set up.${C.reset} The agent already calls the guard (${guardState.how}); nothing to add.`);
  } else if (wantAutoWire) {
    try {
      const kitRoot = fileURLToPath(new URL("..", import.meta.url));
      const tarball = findKitTarball(kitRoot);
      const w = wireNodeGuard({ agentDir, tarball });
      console.log(`\n${C.g}${C.b}Purview governance is set up and wired into the agent automatically.${C.reset}`);
      for (const st of w.steps) ok(`  ${st}`);
      for (const wn of w.warnings) warn(`  ${wn}`);
      record(`guard preload + start script in ${agentDir} (remove agent365-guard.preload.mjs and the --import flag to undo)`);
    } catch (e) {
      warn(`Automatic wiring failed: ${String(e.message || e).slice(0, 300)}`);
      warn("  Front the agent with the governance proxy instead (choose \"third-party agent\" in the installer), or add the two guard calls:");
      console.log(C.d + integrationSnippet(lang, { envPath, upstreamUrl, proxyPort, agentUrl }) + C.reset);
    }
  } else {
    console.log(`\n${C.g}${C.b}Purview governance is set up.${C.reset} ${lang === "typescript" ? "Automatic wiring was declined." : "Automatic wiring exists for Node agents only."}`);
    console.log(`  Either front this agent with the governance proxy (no code), or add these two calls:\n`);
    console.log(C.d + integrationSnippet(lang, { envPath, upstreamUrl, proxyPort, agentUrl }) + C.reset);
  }
  console.log(`\n  ${C.y}Note:${C.reset} DLP policies take up to ~1h to propagate before they take effect.`);
  if (dlpMode !== "Enable") {
    console.log(`  ${C.y}Note:${C.reset} the policy is in ${C.b}${dlpMode}${C.reset} — it audits but ${C.b}does not block${C.reset}.`);
    console.log(`         Re-run the wizard and choose "Enable" once you've reviewed the audit results.\n`);
  } else {
    console.log(`  ${C.r}${C.b}Active blocking is ON${C.reset} for ${scopeLabel}.\n`);
  }

  // ---- Agent 365 manual completion steps ----
  if (wantAgent365) {
    const checklist = agent365Checklist({
      agentName: agentName || purviewAppName, lang, blueprintId: a365?.blueprintId ?? "",
      blueprintAppId: a365?.blueprintAppId ?? "", messagingEndpoint, teams,
    });
    const setupPath = join(envPath.replace(/[^/\\]*$/, ""), "AGENT365_SETUP.md");
    try { writeFileSync(setupPath, checklist); ok(`Agent 365 completion steps written to ${setupPath}`); }
    catch { /* non-fatal */ }
    if (a365) {
      console.log(`\n${C.g}${C.b}Agent 365 registration complete.${C.reset}`);
      console.log(`  blueprint    : ${a365.blueprintAppId}`);
      console.log(`  identity     : ${a365.agentIdentityId}`);
      console.log(`  registration : ${a365.registrationId}${a365.verified ? "  (verified)" : ""}`);
      console.log(`  endpoint     : ${agentUrl}`);
      if (teams?.mode === "teammate") {
        console.log(`  Teams         : AI teammate ${teams.agentUser ? `${C.g}${teams.agentUser.userPrincipalName}${C.reset}` : `${C.y}agent user NOT created — see above${C.reset}`}`);
        console.log(`  licence       : ${teams.licence ? `${teams.licence.status}${teams.licence.sku ? ` (${teams.licence.sku})` : ""}` : "not assigned"}`);
        console.log(`  endpoint      : ${teams.endpoint ? `${messagingEndpoint} (Agent 365 service)` : `${C.y}NOT registered — see above${C.reset}`}`);
        if (teams.agentUser) console.log(`  ${C.g}In Teams, start a chat with "${agentName}" and say hello — the reply comes back through Purview.${C.reset}`);
        for (const err of teams.errors) console.log(`  ${C.y}!${C.reset} ${err}`);
      } else if (teams) {
        console.log(`  Teams app     : ${teams.teamsAppId || `${C.y}not published${C.reset}`}`);
        console.log(`  installed for : ${teams.installed.filter((x) => x.status !== "failed").length} user(s)`);
        console.log(`  endpoint      : ${teams.endpoint ? `${messagingEndpoint} (${teams.endpoint.action})` : `${C.y}NOT registered — see above${C.reset}`}`);
        if (hello?.ok) console.log(`  ${C.g}A message from "${agentName}" is waiting in your Teams — reply to it.${C.reset}`);
        for (const err of teams.errors) console.log(`  ${C.y}!${C.reset} ${err}`);
      } else {
        console.log(`\n  ${C.y}Not published to Teams.${C.reset} Re-run and answer yes to "Publish to Teams" when you want it there.`);
      }
      console.log(`\n  ${C.d}Licences apply to the agent USER (AI teammate). A bot-only blueprint carries none.${C.reset}`);
      if (lang === "proxy") {
        /* handled in the proxy section above */
      } else if (wantRestart && runner.kind && runner.restart) {
        try { ok(`Restarted the agent: ${await runner.restart()}`); }
        catch (e) { warn(`Could not restart the agent (${String(e.message || e).slice(0, 160)}) — restart it yourself so it loads ${envPath}.`); }
      } else if (wantRestart) {
        console.log(`\n  ${C.y}Restart the agent yourself${C.reset} so it loads the new settings in ${envPath} (${runner.detail}).`);
      } else {
        console.log(`\n  ${C.b}Restart the agent now${C.reset} so it loads the new settings in ${envPath}.`);
      }
      console.log(`  Verify: M365 admin center -> Agents -> All agents -> "${agentName}"${teams?.mode === "teammate" ? `; Teams -> New chat -> "${agentName}"` : "; Teams -> Apps -> Built for your org"}.\n`);
    } else {
      console.log(`\n${C.b}${C.y}Agent 365 was NOT registered.${C.reset} To do it by hand, see AGENT365_SETUP.md\n`);
    }
    console.log(`  ${C.d}Full details: AGENT365_SETUP.md${C.reset}`);
  }
}

/**
 * Create the self-signed certificate the Security & Compliance PowerShell
 * session authenticates with.
 *
 * Windows has no openssl, so it uses New-SelfSignedCertificate and exports the
 * PFX from the user's certificate store (then removes it). POSIX uses openssl.
 * Either way the password travels through the environment, never a command line.
 *
 * @returns {{ certPem: string, pfxPath: string }}
 */
export function makeCertificate({ work, subjectName, pfxPw, run = sh }) {
  const safeSubject = String(subjectName).replace(/[^\w .-]/g, "_");
  const pfx = join(work, "cert.pfx");
  const certPem = join(work, "cert.pem");

  if (IS_WINDOWS) {
    const ps = [
      "$ErrorActionPreference='Stop'",
      `$c = New-SelfSignedCertificate -Subject 'CN=${safeSubject}' -CertStoreLocation Cert:\\CurrentUser\\My ` +
        "-KeyExportPolicy Exportable -KeySpec Signature -KeyLength 2048 -NotAfter (Get-Date).AddDays(730)",
      "$pw = ConvertTo-SecureString $env:A365_PFX_PW -AsPlainText -Force",
      `Export-PfxCertificate -Cert $c -FilePath '${pfx}' -Password $pw | Out-Null`,
      `Export-Certificate -Cert $c -FilePath '${join(work, "cert.cer")}' -Type CERT | Out-Null`,
      // Hand back the base64 body in the same shape az expects from a PEM.
      `$b = [Convert]::ToBase64String($c.RawData, 'InsertLineBreaks')`,
      `Set-Content -Path '${certPem}' -Value ("-----BEGIN CERTIFICATE-----\`n" + $b + "\`n-----END CERTIFICATE-----")`,
      // Don't leave the private key in the user's personal store.
      "Remove-Item -Path (Join-Path Cert:\\CurrentUser\\My $c.Thumbprint) -Force",
    ].join("; ");
    run(PWSH, ["-NoProfile", "-Command", ps], { env: { ...procEnv, A365_PFX_PW: pfxPw } });
  } else {
    const keyPem = join(work, "key.pem");
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPem, "-out", certPem,
      "-days", "730", "-nodes", "-subj", `/CN=${safeSubject}`]);
    // -passout env: keeps the password out of the process list (ps auxww).
    run("openssl", ["pkcs12", "-export", "-out", pfx, "-inkey", keyPem, "-in", certPem,
      "-passout", "env:A365_PFX_PW"], { env: { ...procEnv, A365_PFX_PW: pfxPw } });
  }
  return { certPem, pfxPath: pfx };
}

/** Lines MSAL/EXO print to the console on a failed connect; nothing a customer can act on. */
const PS_NOISE = [
  /^Error Acquiring Token:/, /^System\.Exception: Case when Message contains/, /MsalServiceException/,
  /^\s+at Microsoft\.Identity\.Client/, /^\s+ErrorCode: /, /^\s+ResponseBody: /, /^\s+--- End of inner exception/,
  /^\s+at Microsoft\.Exchange\.Management/, /^(Pragma|Strict-Transport-Security|X-Content-Type-Options|x-ms-[a-z-]+|P3P|client-request-id|Content-Security-Policy[^:]*|X-XSS-Protection|Set-Cookie|Date|Cache-Control|Content-Type|Content-Length|Expires|Vary): /,
];

/** execFileSync with inherited stdio, minus known console noise. Throws on non-zero exit. */
function runFiltered(cmd, args, env) {
  const res = spawnSync(cmd, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  for (const chunk of [res.stdout, res.stderr]) {
    for (const line of String(chunk ?? "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (PS_NOISE.some((re) => re.test(line))) continue;
      console.log(line);
    }
  }
  if (res.status !== 0) { const e = new Error(`${cmd} exited ${res.status}`); e.status = res.status; throw e; }
}

function printJournal() {
  if (!journal.length) return;
  console.error(`\n${C.y}${C.b}Created before stopping — undo these if you want a clean slate:${C.reset}`);
  for (const j of journal) console.error(`  • ${j}`);
}

export function integrationSnippet(lang, ctx = {}) {
  if (lang === "proxy") {
    const dir = (ctx.envPath || "./.env").replace(/[^/\\]*$/, "") || "./";
    return [
      `  cd ${dir}`,
      "  npx --package @zaatarlabs/agent365-governance-proxy agent365-govern-proxy",
      `      # fronts ${ctx.upstreamUrl || "<vendor url>"} on port ${ctx.proxyPort || 8787}; Teams bridge on /api/messages`,
      `  # expose http://localhost:${ctx.proxyPort || 8787} as ${ctx.agentUrl || "https://<your public url>"} (reverse proxy / tunnel)`,
      "  # health: /_governance/health returns 503 until the guard is governing",
    ].join("\n");
  }
  if (lang.startsWith("py")) {
    return [
      "  from agent365_governance import load_config, PurviewGuard",
      "  guard = PurviewGuard(load_config())",
      "  v = guard.evaluate(prompt, 'uploadText', correlation_id=cid)",
      "  if v.blocked:",
      "      return v.reason           # else call your model",
    ].join("\n");
  }
  if (lang.startsWith("dot") || lang.startsWith("c#") || lang.startsWith("cs") || lang.startsWith("net")) {
    return [
      "  var guard = new PurviewGuard(PurviewConfig.FromEnvironment());",
      "  var v = await guard.EvaluateAsync(prompt, \"uploadText\", correlationId: cid);",
      "  if (v.Blocked) return v.Reason;   // else call your model",
    ].join("\n");
  }
  return [
    "  import { loadConfig, createPurviewGuard } from \"@zaatarlabs/agent365-governance-kit\";",
    "  const guard = createPurviewGuard(loadConfig().purview);",
    "  const v = await guard.evaluate(prompt, \"uploadText\", { correlationId: cid });",
    "  if (v.blocked) return v.reason;   // else call your model",
  ].join("\n");
}

export function agent365Checklist({ agentName, lang, blueprintId, blueprintAppId = "", messagingEndpoint = "", teams = null }) {
  const obsNote = lang.startsWith("py")
    ? "Observability (Activity tab) for Python is preview — use the Node or .NET package for it, or skip."
    : "Wire observability with initObservability() + refreshTurnObservability() + withAgentScope() (see the package README).";
  return `# Completing Agent 365 setup for "${agentName}"

The wizard automates registration through Microsoft Graph, as the connector app:

  POST /v1.0/applications/microsoft.graph.agentIdentityBlueprint         identity blueprint
  POST /v1.0/applications/{id}/microsoft.graph.agentIdentityBlueprint/addPassword
  POST /v1.0/serviceprincipals/microsoft.graph.agentIdentityBlueprintPrincipal
  POST /beta/servicePrincipals/microsoft.graph.agentIdentity              agent identity
  POST /beta/copilot/agentRegistrations                                   Agent 365 registry
  GET  /beta/copilot/agentRegistrations/{id}                              verify

The registration endpoint is /beta, which Microsoft labels subject to change.
(The older /beta/agentRegistry/* surface retired on 15 June 2026.)

The wizard also grants tenant-wide admin consent from the blueprint to the
Messaging Bot API, the Observability API and Agent 365 Tools, makes those
permissions inheritable by agent identities, and sets the blueprint's identifier
URI (api://botid-<appId>) with an access_as_user scope — the same configuration
\`a365 setup permissions bot\` produces.

## Teams

${teams ? `The wizard published the app to the organisation's app catalog (Teams app id
${teams.teamsAppId || "n/a"}), installed it for the pilot users, and registered the
messaging endpoint ${teams.endpoint ? `(${messagingEndpoint})` : "— NOT registered, see the run log"}
in the Teams Developer Portal (bot id = blueprint appId ${blueprintAppId}).`
: `Not published to Teams in this run. To do it by hand:
     Teams Developer Portal -> Tools -> Bot management -> New bot
       Bot ID           ${blueprintAppId || "<blueprint appId>"}
       Endpoint address ${messagingEndpoint || "https://<your-agent>/api/messages"}
     then upload the app package (M365 admin center -> Integrated apps -> Upload custom apps).`}

## What still needs a human

1. **Nothing for the Teams path.** If the hello message did not arrive, the agent
   must accept Bot Framework activities at ${messagingEndpoint || "/api/messages"} and
   authenticate with the blueprint credentials the wizard wrote to .env.

2. **Licensing.** Blueprint-based agents (this kind) need no per-agent licence;
   Microsoft's a365 CLI only assigns licences to AI-teammate agent users.
   Viewing the inventory needs the AI Reader role; identity governance or
   Conditional Access on agents needs Microsoft Entra Agent ID licensing.

3. **Wire observability in code.** ${obsNote}
   The OBO token is minted per AUTHENTICATED turn, so only Teams/Copilot turns
   appear in the Activity tab. Off-channel surfaces are governed by Purview but
   won't show there.

## Migration note

The legacy Entra agent registry API retired on 15 June 2026. Agents registered
before that date must be re-registered through the endpoints above or they stop
working. Re-run this wizard to do that.

## Verify

  M365 admin center -> Agents -> All agents -> "${agentName}"
  (needs the AI Reader role at minimum)
`;
}

export function buildProvisionScript({ appId, org, pfx, purviewAppName, wantCreditCard, customSitTerms, work, dlpMode, scopeInclusions, wantDspm, dspmIngest }) {
  const policyName = `${purviewAppName} DLP`;
  const loc = JSON.stringify([{
    Workload: "Applications", Location: appId, LocationDisplayName: purviewAppName,
    LocationSource: "Entra", LocationType: "Individual", Inclusions: scopeInclusions,
  }]);
  const collLoc = JSON.stringify([{
    Workload: "Applications", Location: appId,
    LocationSource: "Entra", LocationType: "Individual", Inclusions: scopeInclusions,
  }]);

  let rules = "";
  if (wantCreditCard) {
    rules += `
if (-not (Get-DlpComplianceRule -Identity ${psLit(purviewAppName + " Block CCN")} -ErrorAction SilentlyContinue)) {
  New-DlpComplianceRule -Name ${psLit(purviewAppName + " Block CCN")} -Policy ${psLit(policyName)} -ContentContainsSensitiveInformation @{Name="Credit Card Number"} -GenerateAlert $true -RestrictAccess @(@{setting="UploadText";value="Block"}) | Out-Null
  Write-Host "  created CCN rule"
}`;
  }

  let sitBlock = "";
  if (customSitTerms.length) {
    const sitXmlPath = join(work, "custom_sit.xml");
    writeCustomSit(sitXmlPath, purviewAppName, customSitTerms);
    sitBlock = `
$sitBytes = [System.IO.File]::ReadAllBytes(${psLit(sitXmlPath)})
try { New-DlpSensitiveInformationTypeRulePackage -FileData $sitBytes | Out-Null; Write-Host "  imported custom SIT" } catch { if ($_.Exception.Message -notmatch 'exist') { Write-Host ("  SIT import: " + $_.Exception.Message) } }
Start-Sleep -Seconds 5
if (-not (Get-DlpComplianceRule -Identity ${psLit(purviewAppName + " Block Terms")} -ErrorAction SilentlyContinue)) {
  New-DlpComplianceRule -Name ${psLit(purviewAppName + " Block Terms")} -Policy ${psLit(policyName)} -ContentContainsSensitiveInformation @{Name=${psLit(purviewAppName + " Terms")}} -GenerateAlert $true -RestrictAccess @(@{setting="UploadText";value="Block"}) | Out-Null
  Write-Host "  created custom-terms rule"
}`;
  }

  let dspmBlock = "";
  if (wantDspm) {
    const scenarioConfig = JSON.stringify({
      Activities: ["UploadText", "DownloadText"],
      EnforcementPlanes: ["Application"],
      SensitiveTypeIds: ["All"],
      IsIngestionEnabled: dspmIngest,
    });
    dspmBlock = `
try {
  $fc = Get-FeatureConfiguration -FeatureScenario KnowYourData -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "DSPM for AI - Collection policy for enterprise AI apps" }
  if (-not $fc) {
    New-FeatureConfiguration -FeatureScenario KnowYourData -Name "DSPM for AI - Collection policy for enterprise AI apps" -Mode Enable -ScenarioConfig ${psLit(scenarioConfig)} -Locations ${psLit(collLoc)} | Out-Null
    Write-Host "  created DSPM collection policy (ingestion ${dspmIngest ? "ON" : "OFF"})"
  } else {
    # The collection policy is one per tenant. A second agent must be APPENDED to
    # its locations, not skipped — otherwise it never shows up in DSPM for AI.
    $existing = @($fc.Locations | ConvertFrom-Json)
    if ($existing | Where-Object { $_.Location -eq ${psLit(appId)} }) {
      Write-Host "  DSPM collection policy already covers this app"
    } else {
      # Verified live: Set-FeatureConfiguration -Locations returns OK and changes
      # NOTHING, whatever the payload shape. The only way to add a second agent is
      # to remove the policy and recreate it with the merged locations. Microsoft
      # takes a few minutes to release the name after a delete, so creation is
      # retried; the policy is absent for that window and the log says so.
      $clean = @($existing | ForEach-Object { [ordered]@{ Workload=$_.Workload; Location=$_.Location; LocationSource=$_.LocationSource; LocationType=$_.LocationType; Inclusions=@($_.Inclusions | ForEach-Object { [ordered]@{ Type=$_.Type; Identity=$_.Identity } }) } })
      $add = @(${psLit(collLoc)} | ConvertFrom-Json)
      $merged = ConvertTo-Json -InputObject @(@($clean) + @($add)) -Depth 8 -Compress
      $cfg = $fc.ScenarioConfig; $mode = $fc.Mode; $fcName = $fc.Name
      Write-Host ("  DSPM collection policy exists (" + $existing.Count + " app(s)); recreating it with this app added (Set cannot append)")
      Remove-FeatureConfiguration -Identity $fc.Identity -Confirm:$false -ErrorAction Stop
      $made = $false
      foreach ($attempt in 1..24) {
        Start-Sleep -Seconds 15
        try { New-FeatureConfiguration -FeatureScenario KnowYourData -Name $fcName -Mode $mode -ScenarioConfig $cfg -Locations $merged -ErrorAction Stop | Out-Null; $made = $true; break }
        catch { if ($_.Exception.Message -notmatch "already exists") { throw } }
      }
      if (-not $made) { throw "the DSPM collection policy was removed but could not be recreated within 6 minutes; recreate it in Purview > DSPM for AI with these locations: $merged" }
      Start-Sleep -Seconds 20
      $n = @((Get-FeatureConfiguration -FeatureScenario KnowYourData | Where-Object { $_.Name -eq $fcName }).Locations | ConvertFrom-Json).Count
      if ($n -gt $existing.Count) { Write-Host ("  DSPM collection policy recreated with " + $n + " location(s)") }
      else { Write-Host "  WARNING: DSPM collection policy recreated but this app is not listed - add it in Purview > DSPM for AI > collection policy > locations" }
    }
  }
} catch { Write-Host ("  collection policy: " + $_.Exception.Message) }`;
  }

  return `$ErrorActionPreference='Stop'
if (-not $env:A365_PFX_PW) { Write-Host "A365_PFX_PW not set — the wizard must launch this script."; exit 1 }
$pw = ConvertTo-SecureString $env:A365_PFX_PW -AsPlainText -Force
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(${psLit(pfx)}, $pw)
Remove-Module ExchangeOnlineManagement -ErrorAction SilentlyContinue
if (-not (Get-Module -ListAvailable ExchangeOnlineManagement | Where-Object { $_.Version -eq '${EXO_MODULE_VERSION}' })) {
  Write-Host "Installing ExchangeOnlineManagement ${EXO_MODULE_VERSION}…"
  Install-Module ExchangeOnlineManagement -RequiredVersion ${EXO_MODULE_VERSION} -Scope CurrentUser -Force -AllowClobber
}
Import-Module ExchangeOnlineManagement -RequiredVersion ${EXO_MODULE_VERSION}
$connected=$false
# The certificate was uploaded seconds ago; give Entra a moment so the first
# attempt usually succeeds instead of failing loudly and retrying.
Start-Sleep -Seconds 25
# Back off gently at first — permissions usually land in well under a minute.
$delays = @(5,10,15,30,30,60,60,60,60,60,60,60)
for ($i=0; $i -lt $delays.Count; $i++) {
  # Keep the module's failure noise (raw HTTP headers) off the host, but do NOT
  # redirect the output stream: with *>$null a RETRIED connect can report
  # success without importing the DLP cmdlets. Verify they are present.
  try {
    Connect-IPPSSession -AppId ${psLit(appId)} -Certificate $cert -Organization ${psLit(org)} -ShowBanner:$false -WarningAction SilentlyContinue -ErrorAction Stop 2>$null 6>$null
    if (-not (Get-Command Get-DlpCompliancePolicy -ErrorAction SilentlyContinue)) {
      Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue *>$null
      Connect-IPPSSession -AppId ${psLit(appId)} -Certificate $cert -Organization ${psLit(org)} -ShowBanner:$false -ErrorAction Stop
      if (-not (Get-Command Get-DlpCompliancePolicy -ErrorAction SilentlyContinue)) { throw "connected, but the Security & Compliance cmdlets did not import" }
    }
    $connected=$true; break
  }
  catch {
    $m = ($_.Exception.Message -split "\`n")[0]
    if ($m -match "AADSTS700027") { $m = "certificate not yet visible to Entra (propagation)" }
    elseif ($m.Length -gt 160) { $m = $m.Substring(0,160) + "…" }
    Write-Host ("  attempt " + ($i+1) + " of " + $delays.Count + ": " + $m + " — retrying in " + $delays[$i] + "s")
    # A failed attempt can leave a half-open session that poisons the next one.
    Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue *>$null
    Start-Sleep -Seconds $delays[$i]
  }
}
if (-not $connected) { Write-Host "Could not connect to Security & Compliance PowerShell — re-run the wizard to retry."; exit 1 }
Write-Host "Connected. Creating policies…"
try {
  if (-not (Get-DlpCompliancePolicy -Identity ${psLit(policyName)} -ErrorAction SilentlyContinue)) {
    # A pilot group created seconds ago is not yet a recipient Exchange can see
    # ("The specified recipient ... couldn't be found"). Wait for it rather than fail.
    $created = $false
    foreach ($attempt in 1..20) {
      try {
        New-DlpCompliancePolicy -Name ${psLit(policyName)} -Mode ${dlpMode} -Locations ${psLit(loc)} -EnforcementPlanes @("Application") -ErrorAction Stop | Out-Null
        $created = $true; break
      } catch {
        if ($_.Exception.Message -notmatch "couldn't be found|could not be found|ManagementObjectNotFound") { throw }
        Write-Host ("  pilot group not yet visible to Exchange (attempt " + $attempt + "/20) — waiting 30s")
        Start-Sleep -Seconds 30
      }
    }
    if (-not $created) { throw "the pilot group never became visible to Exchange Online; re-run the wizard in a few minutes" }
    Write-Host "  created policy ${policyName} (mode ${dlpMode})"
  } else {
    Write-Host "  policy ${policyName} already exists — leaving its mode and scope untouched"
  }
${sitBlock}
${rules}
${dspmBlock}
}
finally {
  Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
}
Write-Host "Policy provisioning done."
`;
}

export function writeCustomSit(path, appName, terms) {
  const rulepack = randomUUID(), publisher = randomUUID(), entity = randomUUID();
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const termsXml = terms.map((t) => `        <Term>${esc(t)}</Term>`).join("\n");
  const xml = `<?xml version="1.0" encoding="utf-16"?>
<RulePackage xmlns="http://schemas.microsoft.com/office/2011/mce">
  <RulePack id="${rulepack}">
    <Version major="1" minor="0" build="0" revision="0"/>
    <Publisher id="${publisher}"/>
    <Details defaultLangCode="en-us">
      <LocalizedDetails langcode="en-us">
        <PublisherName>Agent 365 Governance Kit</PublisherName>
        <Name>${esc(appName)} Custom SIT Pack</Name>
        <Description>Custom sensitive info types.</Description>
      </LocalizedDetails>
    </Details>
  </RulePack>
  <Rules>
    <Entity id="${entity}" patternsProximity="300" recommendedConfidence="65">
      <Pattern confidenceLevel="65"><IdMatch idRef="Keyword_terms"/></Pattern>
    </Entity>
    <Keyword id="Keyword_terms">
      <Group matchStyle="word">
${termsXml}
      </Group>
    </Keyword>
    <LocalizedStrings>
      <Resource idRef="${entity}">
        <Name default="true" langcode="en-us">${esc(appName)} Terms</Name>
        <Description default="true" langcode="en-us">Custom blocked terms.</Description>
      </Resource>
    </LocalizedStrings>
  </Rules>
</RulePackage>`;
  writeFileSync(path, Buffer.from("﻿" + xml, "utf16le"), { mode: 0o600 });
}

/**
 * Exercise the ACTUAL runtime path: token → protectionScopes/compute → processContent.
 * The previous version only called computeScopes while reporting "processContent",
 * so Content.Process.All was never verified.
 */
async function validate({ tenantId, appId, clientSecret, userId, purviewAppName }) {
  const steps = [];
  const withTimeout = (p, ms, what) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);

  let tokJson = {};
  for (let attempt = 0; attempt < 12; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 15_000));
    const tokRes = await withTimeout(fetchRetry(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: appId, client_secret: clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
    }), 20000, "token");
    tokJson = await tokRes.json();
    if (tokJson.access_token || !/AADSTS7000215|invalid_client/i.test(String(tokJson.error_description || tokJson.error))) break;
  }
  if (!tokJson.access_token) throw new Error(`token: ${tokJson.error_description || JSON.stringify(tokJson)}`);
  steps.push("token acquired");

  const scopeRes = await withTimeout(fetch(`https://graph.microsoft.com/v1.0/users/${userId}/dataSecurityAndGovernance/protectionScopes/compute`, {
    method: "POST", headers: { authorization: `Bearer ${tokJson.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ activities: "uploadText,downloadText", locations: [{ "@odata.type": "microsoft.graph.policyLocationApplication", value: appId }] }),
  }), 30000, "protectionScopes/compute");
  if (!scopeRes.ok) throw new Error(`protectionScopes/compute HTTP ${scopeRes.status}: ${(await scopeRes.text()).slice(0, 300)}`);
  const etag = scopeRes.headers.get("etag") ?? "";
  steps.push(`protectionScopes/compute HTTP ${scopeRes.status}${etag ? " (etag received)" : " (no etag)"}`);

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const pcRes = await withTimeout(fetch(`https://graph.microsoft.com/v1.0/users/${userId}/dataSecurityAndGovernance/processContent`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokJson.access_token}`, "content-type": "application/json", ...(etag ? { "If-None-Match": etag } : {}) },
    body: JSON.stringify({
      contentToProcess: {
        contentEntries: [{
          "@odata.type": "microsoft.graph.processConversationMetadata",
          identifier: "a365-wizard-validation-0",
          content: { "@odata.type": "microsoft.graph.textContent", data: "Agent 365 Governance Kit setup validation." },
          name: `${purviewAppName} message`,
          correlationId: "a365-wizard-validation", sequenceNumber: 0, isTruncated: false,
          createdDateTime: now, modifiedDateTime: now,
        }],
        activityMetadata: { activity: "uploadText" },
        deviceMetadata: { deviceType: "Unmanaged" },
        protectedAppMetadata: {
          name: purviewAppName, version: "1.0",
          applicationLocation: { "@odata.type": "microsoft.graph.policyLocationApplication", value: appId },
        },
        integratedAppMetadata: { name: purviewAppName, version: "1.0" },
      },
    }),
  }), 30000, "processContent");
  const pcText = await pcRes.text();
  if (!pcRes.ok) throw new Error(`processContent HTTP ${pcRes.status}: ${pcText.slice(0, 300)}`);
  let verdict = "no policy actions";
  try {
    const j = JSON.parse(pcText || "{}");
    const n = (j.policyActions ?? []).length;
    if (n) verdict = `${n} policy action(s) returned`;
  } catch { /* body may be empty */ }
  steps.push(`processContent HTTP ${pcRes.status} — ${verdict}`);
  return steps;
}

// Only run the wizard when invoked as a script — importing this file (e.g. from
// the test suite) must not provision anything.
const isMain = argv[1] && import.meta.url === pathToFileURL(argv[1]).href;
if (isMain) {
  // Credentials live here for the duration of the run, and are shredded on the way out.
  const work = mkdtempSync(join(tmpdir(), "a365gov-"));
  let exitCode = 0;
  try {
    await main(work);
  } catch (e) {
    console.error(`${C.r}✗ ${e.stack || e.message || String(e)}${C.reset}`);
    printJournal();
    exitCode = 1;
  } finally {
    shred(work);
  }
  process.exit(exitCode);
}
