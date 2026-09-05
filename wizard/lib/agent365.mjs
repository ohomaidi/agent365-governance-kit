/**
 * Agent 365 registration — the part that used to be a manual checklist.
 *
 * This is the flow Microsoft documents today, and every step below has been
 * run live against a licensed tenant and returned 2xx:
 *
 *   1. POST /v1.0/applications/microsoft.graph.agentIdentityBlueprint      blueprint
 *   2. POST /v1.0/applications/{id}/microsoft.graph.agentIdentityBlueprint/addPassword
 *   3. POST /v1.0/serviceprincipals/microsoft.graph.agentIdentityBlueprintPrincipal
 *   4. POST /beta/servicePrincipals/microsoft.graph.agentIdentity           agent identity
 *   5. POST /beta/copilot/agentRegistrations                                Agent 365 registry
 *   6. GET  /beta/copilot/agentRegistrations/{id}                           verify
 *
 * The old /beta/agentRegistry/* surface retired on 2026-06-15 and returns 404
 * for everyone; step 5 is its replacement (the "Agent Registration API").
 *
 * Two things make this robust in practice:
 *   - Entra replication. A seconds-old object can 404 on one replica, or come
 *     back as 400 "does not exist" from a dependent endpoint. Every step retries
 *     those signatures with backoff instead of failing.
 *   - Idempotency. Re-running finds the existing blueprint, principal and
 *     registration (registrations are keyed by sourceAgentId) so a customer can
 *     rehearse and re-run without stacking duplicates.
 *
 * Permissions (application, on the connector app):
 *   AgentIdentityBlueprint.Create, AgentIdentityBlueprint.AddRemoveCreds.All,
 *   AgentIdentityBlueprintPrincipal.Create, AgentIdentity.Create.All,
 *   AgentIdentity.Read.All, AgentRegistration.ReadWrite.All
 *
 * `graph` is injected: graph(method, path, body?, headers?) resolves to the
 * parsed body on 2xx and throws an Error carrying `.status` and `.body`
 * otherwise. Paths are full ("/v1.0/…" or "/beta/…").
 */

export const GRAPH = "https://graph.microsoft.com";
export const GRAPH_BETA = `${GRAPH}/beta`;

const ODATA4 = { "OData-Version": "4.0" };

/** Turn a display name into a stable registry key: "Abbas Test 1" → "abbas-test-1". */
export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

/** Entra replication signatures worth waiting out. */
function isReplicationLag(err) {
  const msg = String(err?.body?.error?.message ?? err?.message ?? "").toLowerCase();
  return err?.status === 404 || (err?.status === 400 && msg.includes("does not exist"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Call with backoff on replication lag only; other errors surface immediately. */
async function withReplication(fn, log, label) {
  const waits = [0, 10_000, 20_000, 30_000, 45_000, 60_000];
  let last;
  for (const w of waits) {
    if (w) { log(`${label}: waiting ${w / 1000}s for replication`); await sleep(w); }
    try { return await fn(); } catch (e) {
      last = e;
      if (!isReplicationLag(e)) throw e;
    }
  }
  throw last;
}

/** A2A-style agent card for the registration. */
export function buildAgentCard({ displayName, description, url, organization, version = "1.0.0", skills = [] }) {
  if (!displayName) throw new Error("agent card requires a displayName");
  const card = {
    name: displayName,
    version,
    description: description || displayName,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: (skills.length ? skills : [{ id: "chat", name: "Chat", description: "Conversational assistant" }])
      .map((s, i) => ({ id: s.id || `skill-${i + 1}`, name: s.name || s.id || `Skill ${i + 1}`, description: s.description || "" })),
  };
  if (url) card.url = url;
  if (organization) card.provider = { organization };
  return card;
}

/** Body for POST /beta/copilot/agentRegistrations. */
export function buildRegistrationPayload({
  displayName, description, sourceAgentId, ownerIds = [], createdBy, managedByAppId,
  agentIdentityId, agentIdentityBlueprintId, card, originatingStore = "Agent 365 Governance Kit",
}) {
  if (!displayName) throw new Error("registration requires a displayName");
  if (!ownerIds.length && !managedByAppId) throw new Error("registration requires ownerIds or managedByAppId");
  if (!createdBy) throw new Error("registration requires createdBy");
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const body = {
    displayName,
    description: description || displayName,
    sourceAgentId: sourceAgentId || slugify(displayName),
    originatingStore,
    createdBy,
    sourceCreatedDateTime: now,
    sourceLastModifiedDateTime: now,
    agentCard: card,
  };
  if (ownerIds.length) body.ownerIds = ownerIds;
  if (managedByAppId) body.managedByAppId = managedByAppId;
  if (agentIdentityId) body.agentIdentityId = agentIdentityId;
  if (agentIdentityBlueprintId) body.agentIdentityBlueprintId = agentIdentityBlueprintId;
  return body;
}

/** Body for creating the blueprint. Sponsors are required by the API. */
export function buildBlueprintPayload({ displayName, sponsorIds = [], ownerIds = [] }) {
  if (!displayName) throw new Error("blueprint requires a displayName");
  if (!sponsorIds.length) throw new Error("blueprint requires at least one sponsor (a user object id)");
  const bind = (ids) => ids.map((id) => `${GRAPH}/v1.0/users/${id}`);
  const body = {
    "@odata.type": "Microsoft.Graph.AgentIdentityBlueprint",
    displayName,
    "sponsors@odata.bind": bind(sponsorIds),
  };
  if (ownerIds.length) body["owners@odata.bind"] = bind(ownerIds);
  return body;
}

/**
 * Register an agent in Agent 365. Returns ids, the blueprint secret (only ever
 * returned once by Graph), and a step log.
 */
export async function registerAgent(graph, opts, log = () => {}) {
  const {
    agentName, agentDescription, agentUrl, sponsorIds = [], ownerIds = [],
    managedByAppId, organization, skills = [],
    sourceAgentId = slugify(agentName),
    existingBlueprintId = "",
  } = opts;
  if (!agentName) throw new Error("agentName is required");
  if (!sponsorIds.length) throw new Error("a sponsor (user object id) is required");

  const r = { steps: [], blueprintId: "", blueprintAppId: "", blueprintSecret: "",
              blueprintPrincipalId: "", agentIdentityId: "", registrationId: "", verified: false };
  const owners = ownerIds.length ? ownerIds : sponsorIds;
  const createdBy = owners[0];

  // ---- 1. blueprint: reuse by id, then by name, else create ----
  const bpName = `${agentName} Blueprint`;
  let bp = null;
  if (existingBlueprintId) {
    bp = await graph("GET", `/v1.0/applications/microsoft.graph.agentIdentityBlueprint/${existingBlueprintId}`);
    r.steps.push(`reused blueprint ${bp.id}`);
  } else {
    const found = await graph("GET",
      `/v1.0/applications/microsoft.graph.agentIdentityBlueprint?$filter=displayName eq '${bpName.replace(/'/g, "''")}'&$select=id,appId,displayName`);
    bp = found?.value?.[0] ?? null;
    if (bp) {
      r.steps.push(`found existing blueprint ${bp.id}`);
    } else {
      bp = await graph("POST", "/v1.0/applications/microsoft.graph.agentIdentityBlueprint",
        buildBlueprintPayload({ displayName: bpName, sponsorIds, ownerIds: owners }), ODATA4);
      r.steps.push(`created blueprint ${bp.id}`);
    }
  }
  r.blueprintId = bp.id; r.blueprintAppId = bp.appId;
  log(`blueprint ${bp.id}`);

  // ---- 2. credential (secretText is only returned at creation) ----
  const pw = await withReplication(
    () => graph("POST", `/v1.0/applications/${bp.id}/microsoft.graph.agentIdentityBlueprint/addPassword`,
      { passwordCredential: { displayName: "agent365-governance-kit" } }),
    log, "addPassword");
  r.blueprintSecret = pw?.secretText ?? "";
  r.steps.push(r.blueprintSecret ? "minted blueprint secret" : "WARNING: blueprint secret not returned");

  // ---- 3. blueprint principal: reuse or create ----
  const sp = await withReplication(
    () => graph("GET", `/v1.0/servicePrincipals?$filter=appId eq '${bp.appId}'&$select=id`), log, "principal lookup");
  let prin = sp?.value?.[0] ?? null;
  if (prin) {
    r.steps.push(`found existing blueprint principal ${prin.id}`);
  } else {
    prin = await withReplication(
      () => graph("POST", "/v1.0/serviceprincipals/microsoft.graph.agentIdentityBlueprintPrincipal",
        { appId: bp.appId }, ODATA4),
      log, "principal");
    r.steps.push(`created blueprint principal ${prin.id}`);
  }
  r.blueprintPrincipalId = prin.id;

  // ---- 4. agent identity: reuse by name under this blueprint, else create ----
  let ident = null;
  try {
    const list = await graph("GET",
      `/beta/servicePrincipals/microsoft.graph.agentIdentity?$filter=agentIdentityBlueprintId eq '${bp.appId}'&$select=id,displayName`);
    ident = (list?.value ?? []).find((i) => i.displayName === agentName) ?? null;
  } catch { /* filter may be unsupported; fall through to create */ }
  if (ident) {
    r.steps.push(`found existing agent identity ${ident.id}`);
  } else {
    ident = await withReplication(
      () => graph("POST", "/beta/servicePrincipals/microsoft.graph.agentIdentity", {
        displayName: agentName,
        agentIdentityBlueprintId: bp.appId,
        "sponsors@odata.bind": sponsorIds.map((id) => `${GRAPH}/v1.0/users/${id}`),
      }),
      log, "agent identity");
    r.steps.push(`created agent identity ${ident.id}`);
  }
  r.agentIdentityId = ident.id;
  log(`agent identity ${ident.id}`);

  // ---- 5. Agent 365 registration: keyed by sourceAgentId, so reuse if present ----
  let reg = null;
  try {
    reg = await graph("GET", `/beta/copilot/agentRegistrations/${encodeURIComponent(sourceAgentId)}`);
  } catch (e) { if (e?.status !== 404) throw e; }
  if (reg?.id) {
    r.steps.push(`found existing registration ${reg.id}`);
  } else {
    const card = buildAgentCard({ displayName: agentName, description: agentDescription, url: agentUrl, organization, skills });
    reg = await withReplication(
      () => graph("POST", "/beta/copilot/agentRegistrations", buildRegistrationPayload({
        displayName: agentName, description: agentDescription, sourceAgentId,
        ownerIds: owners, createdBy, managedByAppId,
        agentIdentityId: ident.id, agentIdentityBlueprintId: bp.appId, card,
      })),
      log, "registration");
    r.steps.push(`registered in Agent 365 as ${reg.id}`);
  }
  r.registrationId = reg.id;

  // ---- 6. read it back: registration that isn't verified isn't registration ----
  try {
    const check = await withReplication(
      () => graph("GET", `/beta/copilot/agentRegistrations/${encodeURIComponent(r.registrationId)}`), log, "verify");
    r.verified = Boolean(check?.id);
  } catch { r.verified = false; }
  r.steps.push(r.verified ? "verified via GET" : "WARNING: read-back failed");
  return r;
}

/** Remove a registration (e.g. to rehearse from clean). */
export async function deleteRegistration(graph, id) {
  await graph("DELETE", `/beta/copilot/agentRegistrations/${encodeURIComponent(id)}`);
}
