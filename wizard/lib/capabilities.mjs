/**
 * Tenant capability probe.
 *
 * Tooling preflight (is az installed? am I signed in?) says nothing about
 * whether the TENANT can actually do any of this. A tenant with no licences
 * passes every tooling check and then fails ten minutes in, at
 * Connect-IPPSSession, in front of the customer.
 *
 * This asks the tenant directly. `az` is injected so it's testable offline.
 */

/** Well-known app ids we look for to infer that a service exists in the tenant. */
export const EXCHANGE_ONLINE_APP = "00000002-0000-0ff1-ce00-000000000000";
export const GRAPH_APP = "00000003-0000-0000-c000-000000000000";

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
 * @param {(args: string[]) => any} azJson  Runs `az ...` and parses JSON; throws on failure.
 * @returns {Promise<{checks: object[], summary: {ok:number,warn:number,fail:number}, canProvisionPurview:boolean, canRegisterAgent365:boolean}>}
 */
export async function probeTenant(azJson) {
  const checks = [];
  let account = null;

  // --- who and where ---
  try {
    account = azJson(["account", "show", "-o", "json"]);
    checks.push(ok("Signed in", `${account.user?.name} — tenant ${account.tenantId}`));
  } catch {
    checks.push(bad("Signed in", "not signed in", "Run: az login"));
    return finish(checks, account);
  }

  // --- organisation + the onmicrosoft domain Connect-IPPSSession needs ---
  try {
    const org = azJson(["rest", "--method", "GET", "--url",
      "https://graph.microsoft.com/v1.0/organization?$select=displayName,verifiedDomains", "-o", "json"]);
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
    const r = azJson(["rest", "--method", "GET", "--url",
      "https://graph.microsoft.com/v1.0/subscribedSkus", "-o", "json"]);
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
    azJson(["ad", "sp", "show", "--id", EXCHANGE_ONLINE_APP, "--query", "id", "-o", "json"]);
    checks.push(ok("Exchange Online", "service principal present"));
  } catch {
    checks.push(bad("Exchange Online", "service principal not found",
      "Connect-IPPSSession will fail, so no DLP or DSPM policy can be created."));
  }

  // --- Purview: is the app role the guard needs even offered here? ---
  try {
    const graph = azJson(["ad", "sp", "show", "--id", GRAPH_APP, "-o", "json"]);
    const roles = (graph?.appRoles ?? []).map((r) => r.value);
    const need = ["Content.Process.All", "ProtectionScopes.Compute.All"];
    const missing = need.filter((n) => !roles.includes(n));
    checks.push(missing.length
      ? bad("Purview Graph API", `missing app role(s): ${missing.join(", ")}`,
            "The Purview SDK surface isn't available to this tenant.")
      : ok("Purview Graph API", "Content.Process.All + ProtectionScopes.Compute.All available"));
  } catch (e) {
    checks.push(warn("Purview Graph API", "could not inspect Microsoft Graph app roles", String(e.message).slice(0, 160)));
  }

  // --- Agent 365 registry (beta) ---
  try {
    azJson(["rest", "--method", "GET", "--url",
      "https://graph.microsoft.com/beta/agentRegistry/agentInstances", "-o", "json"]);
    checks.push(ok("Agent 365 registry", "reachable"));
  } catch (e) {
    const msg = String(e.message || e);
    checks.push(/not\s*found|404/i.test(msg)
      ? bad("Agent 365 registry", "not available in this tenant (404)",
            "Agent 365 registration will be skipped. Purview still works.")
      : /forbid|403|authoriz/i.test(msg)
      ? bad("Agent 365 registry", "access denied (403)",
            "Needs the Agent Registry Administrator role.")
      : warn("Agent 365 registry", "could not be probed", msg.slice(0, 160)));
  }

  // --- roles actually held ---
  try {
    const me = azJson(["ad", "signed-in-user", "show", "--query", "id", "-o", "json"]);
    const memberOf = azJson(["rest", "--method", "GET", "--url",
      `https://graph.microsoft.com/v1.0/users/${me}/memberOf?$select=displayName`, "-o", "json"]);
    const held = (memberOf?.value ?? []).map((g) => g.displayName).filter(Boolean);
    const isGA = held.includes("Global Administrator");
    const relevant = Object.keys(ROLES).filter((r) => held.includes(r));
    if (isGA) {
      checks.push(ok("Directory roles", `Global Administrator${relevant.length > 1 ? ` (+ ${relevant.filter(r => r !== "Global Administrator").join(", ")})` : ""}`));
      if (!held.includes("Agent Registry Administrator")) {
        checks.push(warn("Agent Registry Administrator",
          "not held explicitly — Global Administrator normally supersedes it",
          "If registration returns 403, assign this role and re-run."));
      }
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
    account: account ? { user: account.user?.name, tenantId: account.tenantId } : null,
    checks, summary,
    // Purview needs Exchange Online + the Graph roles; Agent 365 needs the registry.
    canProvisionPurview: !failed("Exchange Online") && !failed("Purview Graph API") && !failed("Licences"),
    canRegisterAgent365: !failed("Agent 365 registry"),
  };
}
