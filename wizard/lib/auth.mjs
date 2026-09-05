/**
 * Sign-in for the wizard and the installer — no Azure CLI required.
 *
 * The customer signs in once with the OAuth 2.0 device-code flow (a short code
 * typed into microsoft.com/devicelogin). The refresh token that comes back is
 * kept in a 0600 file for the duration of the run and exchanged for access
 * tokens per resource:
 *
 *   Microsoft Graph          everything the wizard creates in Entra + Purview scopes,
 *                            the Teams app catalog (delegated-only API), app installs
 *   Teams Developer Portal   bot registration = the messaging endpoint
 *
 * Why not the Azure CLI: its token cannot carry AppCatalog.* (Microsoft
 * pre-authorises first-party apps per scope and AADSTS65002 refuses the rest),
 * and the Developer Portal 403s it. Both were verified live before this module
 * was written.
 *
 * Public client identities used (Microsoft-owned, device-code capable):
 *   Microsoft Graph Command Line Tools  14d82eec-204b-4c2f-b7e8-296a70dab67e
 *   Teams Toolkit                        7ea7c24c-b1f6-4a20-9d11-9ae12e9e7ac0
 * They show up under those names in the tenant's sign-in log, which is the
 * honest description of what happened.
 *
 * Pure Node built-ins. The password never passes through this process: the
 * user types it into Microsoft's page, never here.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

export const CLIENTS = {
  graphCli: "14d82eec-204b-4c2f-b7e8-296a70dab67e",
  teamsToolkit: "7ea7c24c-b1f6-4a20-9d11-9ae12e9e7ac0",
};

/** Delegated Graph scopes the wizard needs, as one consent. */
export const GRAPH_SCOPES = [
  "User.ReadWrite.All",
  "Group.ReadWrite.All",
  "Application.ReadWrite.All",
  "AppRoleAssignment.ReadWrite.All",
  "DelegatedPermissionGrant.ReadWrite.All",
  "RoleManagement.ReadWrite.Directory",
  "Organization.Read.All",
  "AppCatalog.ReadWrite.All",
  "TeamsAppInstallation.ReadWriteForUser",
  "Directory.AccessAsUser.All",
];
export const GRAPH_SCOPE_STRING = GRAPH_SCOPES.map((s) => `https://graph.microsoft.com/${s}`).join(" ");
export const DEVPORTAL_SCOPE = "https://dev.teams.microsoft.com/AppDefinitions.ReadWrite";
export const DEVPORTAL_BASE = "https://dev.teams.microsoft.com";

const LOGIN = "https://login.microsoftonline.com";

function form(body) {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) };
}

/** Decode a JWT's claims without verifying it (we only read our own tokens). */
export function claims(jwt) {
  try {
    const p = String(jwt).split(".")[1];
    return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch { return {}; }
}

/**
 * Step 1 of device-code sign-in. Returns what the page must show the user.
 * @returns {Promise<{deviceCode:string,userCode:string,verificationUri:string,message:string,interval:number,expiresIn:number}>}
 */
export async function startDeviceCode({ tenant = "organizations", clientId = CLIENTS.graphCli, scope = GRAPH_SCOPE_STRING }) {
  const res = await fetch(`${LOGIN}/${tenant}/oauth2/v2.0/devicecode`, form({ client_id: clientId, scope: `${scope} openid profile offline_access` }));
  const j = await res.json();
  if (!j.device_code) throw new Error(`device code request failed: ${j.error_description || JSON.stringify(j)}`);
  return { deviceCode: j.device_code, userCode: j.user_code, verificationUri: j.verification_uri, message: j.message, interval: j.interval ?? 5, expiresIn: j.expires_in ?? 900 };
}

/**
 * Step 2: wait for the user to finish. Resolves to the raw token response.
 * `onPending` is called on every poll so a UI can show it's alive.
 */
export async function pollDeviceCode({ tenant = "organizations", clientId = CLIENTS.graphCli, deviceCode, interval = 5, expiresIn = 900, onPending = () => {}, signal }) {
  const deadline = Date.now() + expiresIn * 1000;
  let wait = interval;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("sign-in cancelled");
    await new Promise((r) => setTimeout(r, wait * 1000));
    const res = await fetch(`${LOGIN}/${tenant}/oauth2/v2.0/token`,
      form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: deviceCode }));
    const j = await res.json();
    if (j.access_token) return j;
    if (j.error === "authorization_pending") { onPending(); continue; }
    if (j.error === "slow_down") { wait += 5; continue; }
    throw new Error(j.error_description || j.error || "sign-in failed");
  }
  throw new Error("the sign-in code expired before it was used");
}

/**
 * Refresh-token backed token store. One file, mode 0600, shredded by the caller.
 * Layout: { clients: { [clientId]: { tenant, refreshToken, account } }, tokens: { [clientId|scope]: { token, exp } } }
 */
export class TokenCache {
  constructor(path) {
    this.path = path;
    this.data = { clients: {}, tokens: {} };
    if (path && existsSync(path)) {
      try { this.data = JSON.parse(readFileSync(path, "utf8")); } catch { /* start clean */ }
      this.data.clients ??= {}; this.data.tokens ??= {};
    }
  }
  save() {
    if (!this.path) return;
    writeFileSync(this.path, JSON.stringify(this.data), { mode: 0o600 });
    try { chmodSync(this.path, 0o600); } catch { /* windows */ }
  }
  /** Record a completed device-code sign-in. */
  addSignIn(clientId, tokenResponse, scopeKey) {
    const c = claims(tokenResponse.id_token || tokenResponse.access_token);
    const tenant = c.tid;
    this.data.clients[clientId] = {
      tenant,
      refreshToken: tokenResponse.refresh_token,
      account: { id: c.oid, upn: c.preferred_username || c.upn || c.unique_name || "", name: c.name || "", tenantId: tenant },
    };
    if (scopeKey && tokenResponse.access_token) {
      this.data.tokens[`${clientId}|${scopeKey}`] = { token: tokenResponse.access_token, exp: Date.now() + (tokenResponse.expires_in ?? 3600) * 1000 };
    }
    this.save();
    return this.data.clients[clientId].account;
  }
  account(clientId = CLIENTS.graphCli) { return this.data.clients[clientId]?.account ?? null; }
  signedIn(clientId = CLIENTS.graphCli) { return Boolean(this.data.clients[clientId]?.refreshToken); }
  /**
   * Access token for `scope` under `clientId`, from cache or by refresh-token
   * exchange (which also rotates the refresh token).
   */
  /** Re-read the file: another process (installer + wizard) may have rotated the refresh token. */
  reload() {
    if (!this.path || !existsSync(this.path)) return;
    try { const d = JSON.parse(readFileSync(this.path, "utf8")); this.data = { clients: d.clients ?? {}, tokens: d.tokens ?? {} }; } catch { /* keep what we have */ }
  }
  async token(scope, clientId = CLIENTS.graphCli) {
    const key = `${clientId}|${scope}`;
    const hit = this.data.tokens[key];
    if (hit && Date.now() < hit.exp - 120_000) return hit.token;
    this.reload();
    const fresh = this.data.tokens[key];
    if (fresh && Date.now() < fresh.exp - 120_000) return fresh.token;
    let last;
    for (const delay of [0, 2000, 5000]) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const cl = this.data.clients[clientId];
      if (!cl?.refreshToken) throw new Error(`not signed in (${clientId})`);
      const res = await fetch(`${LOGIN}/${cl.tenant}/oauth2/v2.0/token`,
        form({ grant_type: "refresh_token", client_id: clientId, refresh_token: cl.refreshToken, scope: `${scope} openid profile offline_access` }));
      const j = await res.json();
      if (j.access_token) {
        if (j.refresh_token) cl.refreshToken = j.refresh_token;
        this.data.tokens[key] = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
        this.save();
        return j.access_token;
      }
      last = Object.assign(new Error(`token for ${scope}: ${j.error_description || j.error || "refused"}`), { code: j.error, body: j });
      // A rotated refresh token (used by a sibling process) or a transient STS error: pick up the file again and retry.
      if (!/invalid_grant|temporarily_unavailable|server_error/i.test(String(j.error))) break;
      this.reload();
    }
    throw last;
  }
}

/**
 * Delegated Graph client with the same contract as the app-only client in the
 * wizard: graph(method, path, body?, headers?) → parsed body on 2xx, else throws
 * an Error with .status and .body. Paths are "/v1.0/…" or "/beta/…".
 * Raw (non-JSON) bodies are sent when `body` is a Buffer and a content-type header is given.
 */
export function makeDelegatedGraph(cache, { clientId = CLIENTS.graphCli, scope = GRAPH_SCOPE_STRING } = {}) {
  return async function graph(method, path, body, headers = {}) {
    const delays = [0, 3000, 8000];
    let last;
    for (const d of delays) {
      if (d) await new Promise((r) => setTimeout(r, d));
      const t = await cache.token(scope, clientId);
      const isRaw = Buffer.isBuffer(body);
      const res = await fetch(`https://graph.microsoft.com${path}`, {
        method,
        headers: { authorization: `Bearer ${t}`, ...(body && !isRaw ? { "content-type": "application/json" } : {}), ...headers },
        body: body === undefined ? undefined : (isRaw ? body : JSON.stringify(body)),
      });
      const text = await res.text();
      let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
      if (res.ok) return parsed;
      last = Object.assign(new Error(`${method} ${path} -> HTTP ${res.status}: ${(parsed?.error?.message ?? text).slice(0, 300)}`),
        { status: res.status, body: parsed });
      // Only transient server errors are retried; 4xx is an answer.
      if (res.status < 500 || res.status === 501) break;
    }
    throw last;
  };
}

/** Teams Developer Portal client (bot registration / messaging endpoint). */
export function makeDevPortal(cache, { clientId = CLIENTS.teamsToolkit } = {}) {
  return async function devPortal(method, path, body, headers = {}) {
    const t = await cache.token(DEVPORTAL_SCOPE, clientId);
    const isRaw = Buffer.isBuffer(body);
    const res = await fetch(`${DEVPORTAL_BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${t}`, ...(body && !isRaw ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : (isRaw ? body : JSON.stringify(body)),
    });
    const text = await res.text();
    let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    if (res.ok) return parsed;
    throw Object.assign(new Error(`${method} ${path} -> HTTP ${res.status}: ${(parsed?.error?.message ?? parsed?.message ?? text).slice(0, 300)}`),
      { status: res.status, body: parsed });
  };
}
