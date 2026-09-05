/**
 * Agent 365 registration — the part that used to be a manual checklist.
 *
 * Microsoft now exposes agent registration through Graph, so the wizard can
 * create the identity blueprint, mint its credential and register the agent
 * instance (with its A2A agent card) instead of printing instructions.
 *
 *   POST  /beta/agentIdentityBlueprints            create the blueprint
 *   POST  /beta/agentIdentityBlueprints/{id}/addPassword
 *   POST  /beta/agentRegistry/agentInstances       register instance + manifest
 *   GET   /beta/agentRegistry/agentInstances       verify
 *
 * Permissions: AgentInstance.ReadWrite.All, plus the *Agent Registry
 * Administrator* and *Agent ID Administrator* roles. Blueprint creation
 * REQUIRES at least one sponsor.
 *
 * These are /beta endpoints — Microsoft labels them "subject to change" and
 * unsupported in production. Every call here is therefore best-effort and
 * reports precisely what failed rather than aborting the Purview work that
 * already succeeded.
 *
 * NOTE: the legacy Entra agentRegistry API retired 2026-06-15. Agents
 * registered before then must be re-registered through these endpoints.
 */

export const GRAPH_BETA = "https://graph.microsoft.com/beta";

/** Transports the registry understands, in the order we prefer them. */
export const TRANSPORTS = ["JSONRPC", "HTTP+JSON", "GRPC"];

/**
 * Build an A2A agent card manifest.
 *
 * This is the document Agent 365 stores to describe what the agent is and can
 * do. It's embedded in the agentInstance POST — there is no standalone create
 * for a manifest.
 */
export function buildAgentCard({
  displayName,
  description,
  version = "1.0.0",
  protocolVersion = "1.0",
  organization,
  organizationUrl,
  iconUrl,
  documentationUrl,
  skills = [],
  ownerIds = [],
  originatingStore = "Agent 365 Governance Kit",
  inputModes = ["text/plain"],
  outputModes = ["text/plain"],
}) {
  if (!displayName) throw new Error("agent card requires a displayName");
  const card = {
    displayName,
    description: description || displayName,
    protocolVersion,
    version,
    originatingStore,
    defaultInputModes: inputModes,
    defaultOutputModes: outputModes,
    supportsAuthenticatedExtendedCard: false,
    skills: skills.map((s, i) => ({
      id: s.id || `skill-${i + 1}`,
      name: s.name || s.id || `Skill ${i + 1}`,
      description: s.description || "",
      tags: s.tags || [],
    })),
  };
  if (ownerIds.length) card.ownerIds = ownerIds;
  if (iconUrl) card.iconUrl = iconUrl;
  if (documentationUrl) card.documentationUrl = documentationUrl;
  if (organization) card.provider = { organization, url: organizationUrl || "" };
  return card;
}

/**
 * Build the agentInstance POST body.
 *
 * `url` is the agent's own endpoint and may be ANY reachable address — which is
 * what makes it possible to register a third-party agent you cannot modify.
 * Point it at a governance proxy instead and every registered call is inspected.
 */
export function buildInstancePayload({
  displayName,
  url,
  blueprintId,
  identityId,
  managedBy,
  ownerIds = [],
  sourceAgentId,
  originatingStore = "Agent 365 Governance Kit",
  preferredTransport = "JSONRPC",
  additionalInterfaces = [],
  card,
}) {
  if (!displayName) throw new Error("agent instance requires a displayName");
  if (!url) throw new Error("agent instance requires a url");
  if (!/^https:\/\//i.test(url)) {
    throw new Error(`agent instance url must be https (got "${url}")`);
  }
  if (!TRANSPORTS.includes(preferredTransport)) {
    throw new Error(`preferredTransport must be one of ${TRANSPORTS.join(", ")}`);
  }
  const body = {
    displayName,
    url,
    preferredTransport,
    originatingStore,
    agentCardManifest: card,
  };
  if (blueprintId) body.agentIdentityBlueprintId = blueprintId;
  if (identityId) body.agentIdentityId = identityId;
  if (managedBy) body.managedBy = managedBy;
  if (ownerIds.length) body.ownerIds = ownerIds;
  if (sourceAgentId) body.sourceAgentId = sourceAgentId;
  if (additionalInterfaces.length) {
    body.additionalInterfaces = additionalInterfaces.map((i) => ({
      url: i.url,
      transport: i.transport,
    }));
  }
  return body;
}

/**
 * Build the agentIdentityBlueprint create body.
 * Sponsors are required by the API; we surface that as a clear error rather
 * than letting Graph return an opaque 400.
 */
export function buildBlueprintPayload({
  displayName,
  description,
  sponsorIds = [],
  signInAudience = "AzureADMyOrg",
  tags = [],
}) {
  if (!displayName) throw new Error("blueprint requires a displayName");
  if (!sponsorIds.length) {
    throw new Error("blueprint requires at least one sponsor (a user or group object id)");
  }
  const body = {
    displayName,
    signInAudience,
    "sponsors@odata.bind": sponsorIds.map(
      (id) => `https://graph.microsoft.com/beta/directoryObjects/${id}`,
    ),
  };
  if (description) body.description = description.slice(0, 1024);
  if (tags.length) body.tags = tags;
  return body;
}

/**
 * Registration driver. `graph` is an injected caller:
 *   graph(method, path, body?) -> parsed JSON | null
 * so this whole flow is unit-testable without a tenant.
 */
export async function registerAgent(graph, opts, log = () => {}) {
  const {
    agentName, agentDescription, agentUrl, sponsorIds = [], ownerIds = [],
    managedBy, existingBlueprintId, transport = "JSONRPC",
    organization, skills = [],
  } = opts;

  const result = { blueprintId: "", blueprintAppId: "", blueprintSecret: "", instanceId: "", steps: [] };

  // 1. Blueprint — reuse if the caller already has one.
  let blueprintId = existingBlueprintId || "";
  if (blueprintId) {
    const bp = await graph("GET", `/agentIdentityBlueprints/${blueprintId}`);
    result.blueprintAppId = bp?.appId ?? "";
    result.steps.push(`reused existing blueprint ${blueprintId}`);
    log(`reused blueprint ${blueprintId}`);
  } else {
    const bp = await graph("POST", "/agentIdentityBlueprints", buildBlueprintPayload({
      displayName: `${agentName} Blueprint`,
      description: agentDescription,
      sponsorIds,
      tags: ["agent365-governance-kit"],
    }));
    blueprintId = bp?.id ?? "";
    result.blueprintAppId = bp?.appId ?? "";
    if (!blueprintId) throw new Error("blueprint creation returned no id");
    result.steps.push(`created blueprint ${blueprintId} (appId ${result.blueprintAppId})`);
    log(`created blueprint ${blueprintId}`);

    // 2. Credential for the blueprint (used by the observability exporter).
    const pw = await graph("POST", `/agentIdentityBlueprints/${blueprintId}/addPassword`, {
      passwordCredential: { displayName: "agent365-governance-kit" },
    });
    result.blueprintSecret = pw?.secretText ?? "";
    result.steps.push(result.blueprintSecret ? "minted blueprint secret" : "blueprint secret NOT returned");
    log("minted blueprint secret");
  }
  result.blueprintId = blueprintId;

  // 3. Register the instance together with its agent card.
  const card = buildAgentCard({
    displayName: agentName,
    description: agentDescription,
    organization,
    skills,
    ownerIds,
  });
  const payload = buildInstancePayload({
    displayName: agentName,
    url: agentUrl,
    blueprintId,
    managedBy,
    ownerIds,
    preferredTransport: transport,
    card,
  });
  const inst = await graph("POST", "/agentRegistry/agentInstances", payload);
  result.instanceId = inst?.id ?? "";
  if (!result.instanceId) throw new Error("agent instance creation returned no id");
  result.agentUserId = inst?.agentUserId ?? "";
  result.steps.push(`registered agent instance ${result.instanceId}`);
  log(`registered instance ${result.instanceId}`);

  // 4. Read it back — registration that isn't verified isn't registration.
  const check = await graph("GET", `/agentRegistry/agentInstances/${result.instanceId}`);
  result.verified = Boolean(check?.id);
  result.steps.push(result.verified ? "verified via GET" : "WARNING: read-back failed");

  return result;
}

/** List what's already registered, so the wizard can offer to reuse or replace. */
export async function listAgentInstances(graph) {
  const res = await graph("GET", "/agentRegistry/agentInstances");
  return res?.value ?? [];
}

/** Remove a stale registration (e.g. one stranded by the June 2026 retirement). */
export async function deleteAgentInstance(graph, id) {
  await graph("DELETE", `/agentRegistry/agentInstances/${id}`);
}
