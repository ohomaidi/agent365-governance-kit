/**
 * Teams enablement for a registered Agent 365 agent.
 *
 *   buildTeamsPackage()        manifest.zip for a blueprint-based bot agent
 *   publishToOrgCatalog()      POST /appCatalogs/teamsApps (delegated-only API)
 *   installForUsers()          POST /users/{id}/teamwork/installedApps
 *   registerMessagingEndpoint()Teams Developer Portal bot registration
 *   proactiveHello()           a real message from the agent into the user's Teams
 *
 * The package matches what Microsoft's a365 CLI emits for a blueprint-based
 * agent: bots[0].botId = blueprint appId, webApplicationInfo.resource =
 * api://botid-<appId>. No third-party dependency — the zip and the icons are
 * produced here with node:zlib.
 */
import { deflateRawSync, deflateSync } from "node:zlib";

/* ----------------------------------------------------------------- PNG --- */

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Encode an RGBA pixel buffer as PNG. */
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Icons Teams accepts: a 192×192 colour icon and a 32×32 outline that is white
 * and transparent only. The mark is a ring with a dot — an agent, not a brand.
 */
export function defaultIcons(accent = "#3b5bdb") {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16));
  const draw = (size, colour) => {
    const px = Buffer.alloc(size * size * 4);
    const c = (size - 1) / 2, R = size * 0.46, ring = size * 0.09, dot = size * 0.14;
    const radius = size * 0.22; // rounded-square background, colour icon only
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - c, dy = y - c, d = Math.hypot(dx, dy);
      let a = 0, col = [255, 255, 255];
      if (colour) {
        // background: rounded square
        const ex = Math.max(Math.abs(dx) - (c - radius), 0), ey = Math.max(Math.abs(dy) - (c - radius), 0);
        const inside = Math.hypot(ex, ey) <= radius;
        if (inside) { a = 255; col = [r, g, b]; }
      }
      const onRing = Math.abs(d - R * 0.78) <= ring / 2;
      const onDot = d <= dot;
      if (onRing || onDot) { a = 255; col = [255, 255, 255]; }
      px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = a;
    }
    return encodePng(size, size, px);
  };
  return { color: draw(192, true), outline: draw(32, false) };
}

/* ----------------------------------------------------------------- ZIP --- */

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
/** Minimal zip writer (deflate). files: [{name, data:Buffer}] */
export function makeZip(files) {
  const { time, date } = dosDateTime();
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

/* ------------------------------------------------------------ manifest --- */

/**
 * Teams app manifest for a blueprint-based agent. The app id IS the blueprint
 * appId (what a365 publish does), so the Agent 365 registry, the bot and the
 * Teams app all share one identity.
 */
export function buildTeamsManifest({ blueprintAppId, agentName, description, agentUrl, developer = {}, version = "1.0.0", accentColor = "#3b5bdb" }) {
  if (!/^[0-9a-f-]{36}$/i.test(blueprintAppId)) throw new Error("blueprintAppId must be a GUID");
  const short = String(agentName).slice(0, 30);
  const shortDesc = String(description || `${agentName}, governed by Microsoft Agent 365.`).slice(0, 80);
  const host = new URL(agentUrl).host;
  const dev = {
    name: String(developer.name || "IT").slice(0, 32),
    websiteUrl: developer.websiteUrl || `https://${host}`,
    privacyUrl: developer.privacyUrl || developer.websiteUrl || `https://${host}`,
    termsOfUseUrl: developer.termsOfUseUrl || developer.websiteUrl || `https://${host}`,
  };
  return {
    $schema: "https://developer.microsoft.com/en-us/json-schemas/teams/v1.19/MicrosoftTeams.schema.json",
    manifestVersion: "1.19",
    version,
    id: blueprintAppId,
    developer: dev,
    name: { short, full: String(agentName).slice(0, 100) },
    description: { short: shortDesc, full: String(description || shortDesc).slice(0, 4000) },
    icons: { color: "color.png", outline: "outline.png" },
    accentColor,
    bots: [{
      botId: blueprintAppId,
      scopes: ["personal", "team", "groupChat"],
      supportsFiles: false,
      isNotificationOnly: false,
    }],
    permissions: ["identity", "messageTeamMembers"],
    validDomains: [host, "token.botframework.com"],
    webApplicationInfo: { id: blueprintAppId, resource: `api://botid-${blueprintAppId}` },
  };
}

/**
 * AI-teammate manifest (devPreview): the shape Microsoft's a365 CLI emits with
 * --aiteammate and the only Teams path Microsoft fully supports for blueprint
 * agents today ("app-based non-DW publish … not yet implemented" in their CLI).
 * The template links the app to the blueprint; an agent USER is created from
 * it, and Teams delivers messages with the agentic role the SDK requires.
 */
export function buildTeammateManifest(opts) {
  const m = buildTeamsManifest(opts);
  const templateId = opts.templateId || m.id;
  const { bots, webApplicationInfo, permissions, validDomains, ...rest } = m;
  return {
    manifest: {
      ...rest,
      $schema: "https://developer.microsoft.com/en-us/json-schemas/teams/vdevPreview/MicrosoftTeams.schema.json",
      manifestVersion: "devPreview",
      agenticUserTemplates: [{ id: templateId, file: "agenticUserTemplateManifest.json" }],
    },
    template: { id: templateId, schemaVersion: "0.1.0-preview", agentIdentityBlueprintId: opts.blueprintAppId, communicationProtocol: "activityProtocol" },
  };
}

/** The package Teams expects, as a zip Buffer. `teammate: true` builds the AI-teammate form. */
export function buildTeamsPackage(opts) {
  const icons = opts.icons ?? defaultIcons(opts.accentColor);
  if (opts.teammate) {
    const { manifest, template } = buildTeammateManifest(opts);
    const zip = makeZip([
      { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
      { name: "agenticUserTemplateManifest.json", data: JSON.stringify(template, null, 2) },
      { name: "color.png", data: icons.color },
      { name: "outline.png", data: icons.outline },
    ]);
    return { manifest, template, zip };
  }
  const manifest = buildTeamsManifest(opts);
  const zip = makeZip([
    { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
    { name: "color.png", data: icons.color },
    { name: "outline.png", data: icons.outline },
  ]);
  return { manifest, zip };
}

/* ------------------------------------------------------------- catalog --- */

/**
 * Publish (or update) the package in the organisation's app catalog.
 * Delegated Graph only — Microsoft does not offer an application permission.
 * @returns {Promise<{teamsAppId:string, action:"published"|"updated"|"unchanged"}>}
 */
export async function publishToOrgCatalog(graph, zip, externalId) {
  const found = await graph("GET",
    `/v1.0/appCatalogs/teamsApps?$filter=externalId eq '${externalId}' and distributionMethod eq 'organization'&$expand=appDefinitions($select=id,version,publishingState)`);
  const existing = found?.value?.[0];
  const headers = { "content-type": "application/zip" };
  if (!existing) {
    const r = await graph("POST", "/v1.0/appCatalogs/teamsApps", zip, headers);
    return { teamsAppId: r.id, action: "published" };
  }
  // A new version of an existing app goes in as a new app definition.
  try {
    await graph("POST", `/v1.0/appCatalogs/teamsApps/${existing.id}/appDefinitions`, zip, headers);
    return { teamsAppId: existing.id, action: "updated" };
  } catch (e) {
    // Same version already published → nothing to do; anything else is real.
    if (e.status === 409 || /same version|already exists/i.test(e.message)) return { teamsAppId: existing.id, action: "unchanged" };
    throw e;
  }
}

/** Remove the app from the org catalog (cleanup / rehearsal). */
export async function unpublishFromOrgCatalog(graph, externalId) {
  const found = await graph("GET", `/v1.0/appCatalogs/teamsApps?$filter=externalId eq '${externalId}' and distributionMethod eq 'organization'`);
  const existing = found?.value?.[0];
  if (!existing) return false;
  await graph("DELETE", `/v1.0/appCatalogs/teamsApps/${existing.id}`);
  return true;
}

/**
 * Install the app in each user's personal scope so it is in their Teams app
 * bar without them searching for it. Idempotent (409 = already installed).
 * @returns {Promise<Array<{userId:string, status:"installed"|"already"|"failed", error?:string}>>}
 */
export async function installForUsers(graph, teamsAppId, userIds) {
  const out = [];
  for (const userId of [...new Set(userIds)]) {
    try {
      await graph("POST", `/v1.0/users/${userId}/teamwork/installedApps`,
        { "teamsApp@odata.bind": `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/${teamsAppId}` });
      out.push({ userId, status: "installed" });
    } catch (e) {
      if (e.status === 409 || /already installed|Conflict/i.test(e.message)) out.push({ userId, status: "already" });
      else out.push({ userId, status: "failed", error: e.message });
    }
  }
  return out;
}

/* ----------------------------------------------------- Developer Portal --- */

/**
 * Register (or update) the bot in the Teams Developer Portal — this is where
 * the messaging endpoint lives. Bot ID = blueprint appId. Same call Teams
 * Toolkit's botFramework/create action makes.
 * @returns {Promise<{action:"created"|"updated"|"unchanged", messagingEndpoint:string}>}
 */
export async function registerMessagingEndpoint(devPortal, { botId, name, description = "", messagingEndpoint, iconUrl = "" }) {
  if (!/^https:\/\//i.test(messagingEndpoint)) throw new Error("messagingEndpoint must be https");
  let existing = null;
  try { existing = await devPortal("GET", `/api/botframework/${botId}`); }
  catch (e) { if (e.status !== 404) throw e; }
  const reg = {
    botId, name: String(name).slice(0, 42), description: String(description).slice(0, 512), iconUrl,
    messagingEndpoint, callingEndpoint: "", configuredChannels: ["msteams"], isSingleTenant: true,
  };
  if (!existing) {
    await devPortal("POST", "/api/botframework", reg);
    return { action: "created", messagingEndpoint };
  }
  if (existing.messagingEndpoint === messagingEndpoint && existing.name === reg.name) return { action: "unchanged", messagingEndpoint };
  await devPortal("POST", `/api/botframework/${botId}`, { ...existing, ...reg });
  return { action: "updated", messagingEndpoint };
}

export async function getMessagingEndpoint(devPortal, botId) {
  try { const r = await devPortal("GET", `/api/botframework/${botId}`); return r?.messagingEndpoint ?? null; }
  catch (e) { if (e.status === 404) return null; throw e; }
}

export async function deleteBotRegistration(devPortal, botId) {
  try { await devPortal("DELETE", `/api/botframework/${botId}`); return true; }
  catch (e) { if (e.status === 404) return false; throw e; }
}

/* ---------------------------------------------------------- smoke test --- */

/**
 * Token AS THE AGENT IDENTITY, the way the Microsoft 365 Agents SDK does it.
 * Entra refuses plain app-only tokens for a blueprint against the Messaging
 * Bot API (AADSTS82001); the agentic flow is two steps:
 *   1. blueprint (client secret) → token for api://AzureAdTokenExchange with
 *      fmi_path = <agent identity id>
 *   2. client_id = <agent identity id>, client_assertion = that token →
 *      app-only token for the resource.
 */
export async function agentIdentityToken({ tenantId, blueprintAppId, blueprintSecret, agentIdentityId, scope }) {
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const post = (body) => fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }).then((r) => r.json());
  const step1 = await post({ client_id: blueprintAppId, client_secret: blueprintSecret, grant_type: "client_credentials",
    scope: "api://AzureAdTokenExchange/.default", fmi_path: agentIdentityId, client_info: "2" });
  if (!step1.access_token) throw new Error(`blueprint token: ${step1.error_description || step1.error}`);
  const step2 = await post({ client_id: agentIdentityId, grant_type: "client_credentials", scope,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: step1.access_token, client_info: "2" });
  if (!step2.access_token) throw new Error(`agent identity token: ${step2.error_description || step2.error}`);
  return step2.access_token;
}

/**
 * Prove the Teams path from the agent's side: mint a token as the agent
 * identity, open a personal conversation with the user and send one message.
 * Works only once the app is installed for that user — which the wizard did a
 * moment earlier.
 *
 * Returns {ok, detail}. Never throws: the outcome is reported, not fatal.
 */
export async function proactiveHello({ tenantId, blueprintAppId, blueprintSecret, agentIdentityId, messagingBotApiAppId, userId, agentName, text, serviceUrl = "https://smba.trafficmanager.net/teams/" }) {
  let token;
  try {
    token = await agentIdentityToken({ tenantId, blueprintAppId, blueprintSecret, agentIdentityId, scope: `${messagingBotApiAppId}/.default` });
  } catch (e) { return { ok: false, detail: e.message }; }
  const base = serviceUrl.replace(/\/+$/, "");
  const conv = await fetch(`${base}/v3/conversations`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      bot: { id: `28:${blueprintAppId}`, name: agentName },
      members: [{ id: userId }],
      tenantId, isGroup: false,
      channelData: { tenant: { id: tenantId } },
    }),
  });
  const convText = await conv.text();
  if (!conv.ok) return { ok: false, detail: `create conversation HTTP ${conv.status}: ${convText.slice(0, 300)}` };
  const convId = JSON.parse(convText).id;
  const msg = await fetch(`${base}/v3/conversations/${encodeURIComponent(convId)}/activities`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ type: "message", from: { id: `28:${blueprintAppId}`, name: agentName }, text }),
  });
  const msgText = await msg.text();
  if (!msg.ok) return { ok: false, detail: `send HTTP ${msg.status}: ${msgText.slice(0, 300)}` };
  return { ok: true, detail: `message delivered (conversation ${convId})` };
}

/* ---------------------------------------------- Agent 365 (M365) path --- */

/**
 * Register the agent's messaging endpoint with Microsoft's Agent 365 service —
 * what `a365 setup all --m365` does. This is the path that delivers Teams
 * messages with the agentic role the Agents SDK needs; a Developer Portal bot
 * delivers through the classic channel, where a blueprint identity cannot
 * mint the reply token (AADSTS82001, observed live). Idempotent.
 */
export async function registerAgent365Endpoint(svc, { tenantId, blueprintAppId, callbackUri }) {
  if (!/^https:\/\//i.test(callbackUri)) throw new Error("callbackUri must be https");
  const r = await svc("POST", "/agents/botManagement/createAgentBlueprint", { tenantId, callbackUri, agentIdentityBlueprintId: blueprintAppId });
  return { callbackUri: r?.callbackUri ?? callbackUri, type: r?.type ?? "", message: r?.message ?? "" };
}

export async function deleteAgent365Endpoint(svc, { tenantId, blueprintAppId }) {
  try { await svc("POST", "/agents/botManagement/deleteAgentBlueprint", { tenantId, agentIdentityBlueprintId: blueprintAppId }); return true; }
  catch (e) { if (e.status === 404) return false; throw e; }
}

/**
 * The agent USER — an Entra user of type agentUser whose identity parent is
 * the agent identity. This is what Teams talks to on the Agent 365 path; the
 * SDK answers with the agentic-user token flow. Idempotent by UPN.
 * @returns {Promise<{id:string, userPrincipalName:string, created:boolean}>}
 */
export async function ensureAgentUser(graph, { displayName, mailNickname, domain, agentIdentityId, usageLocation = "US" }) {
  const upn = `${mailNickname}@${domain}`;
  const found = (await graph("GET", `/beta/users?$filter=userPrincipalName eq '${upn.replace(/'/g, "''")}'&$select=id,userPrincipalName,usageLocation`))?.value?.[0];
  if (found) {
    if (!found.usageLocation) await graph("PATCH", `/v1.0/users/${found.id}`, { usageLocation });
    return { id: found.id, userPrincipalName: found.userPrincipalName, created: false };
  }
  const u = await graph("POST", "/beta/users/microsoft.graph.agentUser", {
    "@odata.type": "#microsoft.graph.agentUser",
    displayName, mailNickname, userPrincipalName: upn, accountEnabled: true, identityParentId: agentIdentityId,
  });
  await graph("PATCH", `/v1.0/users/${u.id}`, { usageLocation });
  return { id: u.id, userPrincipalName: u.userPrincipalName ?? upn, created: true };
}

/**
 * Assign the tenant's Agent 365 licence to the agent user. Picks the first
 * subscribed SKU whose part number looks like an Agent 365 / Frontier SKU
 * unless `skuId` is given. Reports "none available" instead of guessing.
 * @returns {Promise<{status:"assigned"|"already"|"none", sku?:string}>}
 */
export async function assignAgentLicence(graph, userId, { skuId, match = /AGENT_FRONTIER|AGENT365|A365|COPILOT_AGENT/i } = {}) {
  const skus = (await graph("GET", "/v1.0/subscribedSkus?$select=skuId,skuPartNumber,prepaidUnits,consumedUnits"))?.value ?? [];
  const sku = skuId ? skus.find((s) => s.skuId === skuId) : skus.find((s) => match.test(s.skuPartNumber) && s.consumedUnits < (s.prepaidUnits?.enabled ?? 0));
  if (!sku) return { status: "none" };
  const have = (await graph("GET", `/v1.0/users/${userId}?$select=assignedLicenses`))?.assignedLicenses ?? [];
  if (have.some((l) => l.skuId === sku.skuId)) return { status: "already", sku: sku.skuPartNumber };
  await graph("POST", `/v1.0/users/${userId}/assignLicense`, { addLicenses: [{ skuId: sku.skuId, disabledPlans: [] }], removeLicenses: [] });
  return { status: "assigned", sku: sku.skuPartNumber };
}
