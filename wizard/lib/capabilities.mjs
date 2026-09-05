/**
 * Tenant capability probe.
 *
 * Tooling preflight (is az installed? am I signed in?) says nothing about
 * whether the TENANT can actually do any of this. A tenant with no licences
 * passes every tooling check and then fails ten minutes in, at
 * Connect-IPPSSession, in front of the customer.
 *
 * This asks the tenant directly, through the signed-in admin's delegated
 * Graph client. `graph` is injected so it's testable offline.
 */

/** Well-known app ids we look for to infer that a service exists in the tenant. */
export const EXCHANGE_ONLINE_APP = "00000002-0000-0ff1-ce00-000000000000";
export const GRAPH_APP = "00000003-0000-0000-c000-000000000000";

/** Graph application permissions the Purview guard needs at runtime. */
export const PURVIEW_ROLES = ["Content.Process.All", "ProtectionScopes.Compute.All"];

/** Graph application permissions Agent 365 registration needs. */
export const AGENT365_ROLES = [
  "AgentIdentityBlueprint.Create",
  "AgentIdentityBlueprintPrincipal.Create",
  "AgentIdentity.Create.All",
  "AgentRegistration.ReadWrite.All",
];

/** Roles the wizard's stages actually need. */
export const ROLES = {
  "Global Administrator": "everything (supersedes the rest)",
  "Compliance Administrator": "create DLP and DSPM policies",
  "Security Administrator": "security policy management",
  "Agent Registry Administrator": "register agents in the Agent 365 registry",
  "Agent ID Administrator": "create and manage agent identity blueprints",
  "Privileged Role Administrator": "assign Compliance Administrator to the connector",
};

const ok = (name, detail) => ({ name, status: "ok", detail });
const warn = (name, detail, fix) => ({ name, status: "warn", detail, fix });
const bad = (name, detail, fix) => ({ name, status: "fail", detail, fix });

/**
 * @param {(method:string, path:string, body?:any) => Promise<any>} graph  Delegated Graph client; throws on non-2xx.
 * @param {{id?:string, upn?:string, tenantId?:string}|null} account         Who is signed in (from the token cache).
 * @returns {Promise<{checks: object[], summary: {ok:number,warn:number,fail:number}, canProvisionPurview:boolean, canRegisterAgent365:boolean}>}
 */
export async function probeTenant(graph, account) {
  const checks = [];

  // --- who and where ---
  if (!account?.tenantId) {
    checks.push(bad("Signed in", "not signed in", "Use the installer's Sign in button."));
    return finish(checks, null);
  }
  checks.push(ok("Signed in", `${account.upn} — tenant ${account.tenantId}`));

  // --- organisation + the onmicrosoft domain Connect-IPPSSession needs ---
  try {
    const org = await graph("GET", "/v1.0/organization?$select=displayName,verifiedDomains");
    const o = org?.value?.[0];
    const domains = (o?.verifiedDomains ?? []).map((d) => d.name);
    const onms = domains.find((d) => d.endsWith(".onmicrosoft.com"));
    checks.push(onms
      ? ok("Organisation", `${o.displayName} — ${onms}`)
      : bad("Organisation", `${o?.displayName ?? "unknown"} has no .onmicrosoft.com domain`,
            "Security & Compliance PowerShell needs one to connect."));
  } catch (e) {
    checks.push(bad("Organisation", "could not read organization", String(e.message).slice(0, 160)));
  }

  // --- licences: the single best predictor of "this will actually work" ---
  let skus = [];
  try {
    const r = await graph("GET", "/v1.0/subscribedSkus");
    skus = (r?.value ?? []).map((s) => s.skuPartNumber);
    if (!skus.length) {
      checks.push(bad("Licences", "no subscribed SKUs in this tenant",
        "Purview, Exchange Online and Agent 365 are all unavailable without licences."));
    } else {
      checks.push(ok("Licences", `${skus.length} SKU(s): ${skus.slice(0, 6).join(", ")}${skus.length > 6 ? "…" : ""}`));
    }
  } catch (e) {
    checks.push(warn("Licences", "could not read subscribedSkus", String(e.message).slice(0, 160)));
  }

  // --- Exchange Online must exist for the Security & Compliance endpoint ---
  try {
    const sp = await graph("GET", `/v1.0/servicePrincipals?$filter=appId eq '${EXCHANGE_ONLINE_APP}'&$select=id`);
    if (!sp?.value?.length) throw new Error("absent");
    checks.push(ok("Exchange Online", "service principal present"));
  } catch {
    checks.push(bad("Exchange Online", "service principal not found",
      "Connect-IPPSSession will fail, so no DLP or DSPM policy can be created."));
  }

  // --- Which Graph app roles this tenant actually offers ---
  //
  // NOTE: we deliberately do NOT probe the agent registry directly: the admin's
  // delegated token carries no agent scopes, so that call returns 404/403 in
  // every tenant — including ones where the feature is fully available. The
  // presence of the app roles is the honest signal, and it's also what the
  // connector app will be granted.
  let graphRoles = [];
  try {
    const gsp = (await graph("GET", `/v1.0/servicePrincipals?$filter=appId eq '${GRAPH_APP}'&$select=appRoles`))?.value?.[0];
    graphRoles = (gsp?.appRoles ?? []).filter((r) => r.isEnabled !== false).map((r) => r.value);
  } catch (e) {
    checks.push(warn("Microsoft Graph", "could not inspect app roles", String(e.message).slice(0, 160)));
  }

  if (graphRoles.length) {
    const missing = PURVIEW_ROLES.filter((n) => !graphRoles.includes(n));
    checks.push(missing.length
      ? bad("Purview Graph API", `missing app role(s): ${missing.join(", ")}`,
            "The Purview SDK surface isn't available to this tenant.")
      : ok("Purview Graph API", "Content.Process.All + ProtectionScopes.Compute.All available"));

    // The Entra agent registry API retired on 2026-06-15. The permissions are
    // still published, so their presence proves nothing — say so plainly rather
    // than promising a registration that will 404.
    const a365Missing = AGENT365_ROLES.filter((n) => !graphRoles.includes(n));
    checks.push(a365Missing.length
      ? bad("Agent 365 registration", `missing app role(s): ${a365Missing.join(", ")}`,
            "Registration will be skipped. Purview is unaffected.")
      : ok("Agent 365 registration", "blueprint, identity and registration permissions available"));
    checks.push(graphRoles.includes("CopilotPackages.ReadWrite.All")
      ? ok("Agent 365 inventory", "CopilotPackages.ReadWrite.All available")
      : warn("Agent 365 inventory", "CopilotPackages.ReadWrite.All not offered",
             "The agent inventory API won't be readable."));
  }

  // --- roles actually held ---
  try {
    const memberOf = await graph("GET", `/v1.0/users/${account.id || "me"}/memberOf?$select=displayName`);
    const held = (memberOf?.value ?? []).map((g) => g.displayName).filter(Boolean);
    const isGA = held.includes("Global Administrator");
    const relevant = Object.keys(ROLES).filter((r) => held.includes(r));
    if (isGA) {
      checks.push(ok("Directory roles", `Global Administrator${relevant.length > 1 ? ` (+ ${relevant.filter(r => r !== "Global Administrator").join(", ")})` : ""}`));
      // Registration runs app-only under the connector app, so the operator's
      // own directory roles only need to cover granting those app roles.
    } else if (relevant.length) {
      checks.push(warn("Directory roles", `holds: ${relevant.join(", ")}`,
        "Global Administrator is what the wizard assumes for the Purview stage."));
    } else {
      checks.push(bad("Directory roles", "no privileged directory roles found",
        "Provisioning needs Global Administrator, or Compliance + Privileged Role Administrator."));
    }
  } catch (e) {
    checks.push(warn("Directory roles", "could not read role membership", String(e.message).slice(0, 160)));
  }

  return finish(checks, account);
}

function finish(checks, account) {
  const summary = {
    ok: checks.filter((c) => c.status === "ok").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
  };
  const failed = (name) => checks.some((c) => c.name === name && c.status === "fail");
  return {
    account: account ? { user: account.upn, tenantId: account.tenantId } : null,
    checks, summary,
    // Purview needs Exchange Online + the Graph roles; Agent 365 needs the registry.
    canProvisionPurview: !failed("Exchange Online") && !failed("Purview Graph API") && !failed("Licences"),
    canRegisterAgent365: !failed("Agent 365 registration"),
  };
}
