#!/usr/bin/env node
/**
 * agent365-govern init — interactive setup wizard.
 *
 * Auto-provisions everything the Governance Kit needs in the customer's tenant,
 * after a tenant-admin signs in (Azure CLI). It:
 *   1. creates a dedicated app registration (the Purview connector) + secret,
 *   2. grants Content.Process.All + ProtectionScopes.Compute.All + Exchange.ManageAsApp,
 *   3. creates a cert, assigns the Compliance Administrator role,
 *   4. creates the DLP policy + rules + DSPM collection policy (Security & Compliance PS),
 *   5. writes the host app's .env,
 *   6. validates with a live processContent call.
 *
 * Requires: az (Azure CLI, logged in as Global Admin), pwsh 7, openssl.
 * Pure Node built-ins — no install needed to run the wizard.
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { writeFileSync, appendFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Microsoft constants (stable GUIDs) ---
const GRAPH_APP = "00000003-0000-0000-c000-000000000000";
const EXO_APP = "00000002-0000-0ff1-ce00-000000000000";
const ROLE_CONTENT_PROCESS = "5ad511bf-571c-4ef6-8c3c-85b94b85df98"; // Content.Process.All
const ROLE_PROTECTION_SCOPES = "e5a76501-dbb0-492c-ab55-5d09e8837263"; // ProtectionScopes.Compute.All
const ROLE_EXCHANGE_MANAGE = "dc50a0fb-09a3-484d-be87-e023b12c6440"; // Exchange.ManageAsApp
const ROLE_COMPLIANCE_ADMIN = "17315797-102d-40b4-93e0-432062caca18"; // Compliance Administrator
const EXO_MODULE_VERSION = "3.5.1"; // 3.10.x throws NullRef on PowerShell 7.6

const C = { reset: "\x1b[0m", b: "\x1b[1m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m" };
const ok = (m) => console.log(`${C.g}✓${C.reset} ${m}`);
const info = (m) => console.log(`${C.d}·${C.reset} ${m}`);
const warn = (m) => console.log(`${C.y}!${C.reset} ${m}`);
const die = (m) => { console.error(`${C.r}✗ ${m}${C.reset}`); process.exit(1); };

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}
function az(args) { return sh("az", args); }
function azJson(args) { const out = az(args).trim(); return out ? JSON.parse(out) : null; }

async function main() {
  console.log(`${C.b}\n  Agent 365 Governance Kit — setup wizard${C.reset}\n  ${C.d}Purview guard + Agent 365 identity, auto-provisioned.${C.reset}\n`);

  // ---- preflight ----
  try { sh("az", ["version", "-o", "none"]); } catch { die("Azure CLI (az) not found. Install it and run `az login` as a Global Admin."); }
  try { sh("pwsh", ["-NoProfile", "-Command", "$null"]); } catch { die("PowerShell 7 (pwsh) not found. Install it (brew install powershell)."); }
  try { sh("openssl", ["version"]); } catch { die("openssl not found."); }

  let acct;
  try { acct = azJson(["account", "show", "-o", "json"]); }
  catch { warn("Not signed in. Launching `az login` (sign in as a Global Admin)…"); execFileSync("az", ["login"], { stdio: "inherit" }); acct = azJson(["account", "show", "-o", "json"]); }
  const tenantId = acct.tenantId;
  ok(`Signed in: ${acct.user.name}  (tenant ${tenantId})`);

  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q, dflt) => {
    const a = (await rl.question(`${C.b}?${C.reset} ${q}${dflt ? ` ${C.d}[${dflt}]${C.reset}` : ""} `)).trim();
    return a || dflt || "";
  };
  const yes = async (q, dflt = true) => /^y/i.test(await ask(`${q} (${dflt ? "Y/n" : "y/N"})`, dflt ? "y" : "n"));

  // ---- collect variables ----
  const appRegName = await ask("App registration name for the Purview connector:", "Agent Purview Connector");
  const purviewAppName = await ask("App name to show in Purview audit/DSPM:", "Custom AI App");
  const attribUpn = await ask("User to attribute interactions to (UPN):", acct.user.name);
  const envPath = await ask("Path to your agent's .env to write:", join(process.cwd(), ".env"));
  const wantCreditCard = await yes("Create a DLP rule blocking Credit Card Numbers?");
  const customSitTerms = (await ask("Extra block keywords (comma-separated, e.g. salary,compensation) or blank:", "")).split(",").map((s) => s.trim()).filter(Boolean);
  const failClosed = await yes("Fail CLOSED (block when Purview is unreachable)?", false);
  const wantObservability = await yes("Also wire Agent 365 observability (Activity tab)?", true);
  let blueprintId = "", blueprintSecret = "", agentName = "";
  if (wantObservability) {
    agentName = await ask("Agent display name (for observability):", purviewAppName);
    blueprintId = await ask("Agent blueprint app (client) id [blank to skip]:", "");
    if (blueprintId) blueprintSecret = await ask("Blueprint app client secret:", "");
  }

  console.log(`\n${C.b}About to provision in tenant ${tenantId}:${C.reset}`);
  console.log(`  • App registration "${appRegName}" + secret + cert`);
  console.log(`  • Graph: Content.Process.All, ProtectionScopes.Compute.All; Exchange.ManageAsApp; Compliance Administrator role`);
  console.log(`  • DLP policy "${purviewAppName} DLP"${wantCreditCard ? " + Credit Card rule" : ""}${customSitTerms.length ? ` + custom SIT (${customSitTerms.join(", ")})` : ""}`);
  console.log(`  • DSPM collection policy (ingestion ON)`);
  console.log(`  • Write ${envPath}\n`);
  if (!(await yes("Proceed?"))) { rl.close(); die("Aborted."); }

  // ---- 1. app registration + SP + secret ----
  info("Creating app registration…");
  let app = azJson(["ad", "app", "list", "--filter", `displayName eq '${appRegName}'`, "--query", "[0].{appId:appId,id:id}", "-o", "json"]);
  if (!app) app = azJson(["ad", "app", "create", "--display-name", appRegName, "--sign-in-audience", "AzureADMyOrg", "--query", "{appId:appId,id:id}", "-o", "json"]);
  const appId = app.appId;
  try { az(["ad", "sp", "create", "--id", appId, "-o", "none"]); } catch { /* exists */ }
  const spId = azJson(["ad", "sp", "show", "--id", appId, "--query", "id", "-o", "json"]);
  const secretObj = azJson(["ad", "app", "credential", "reset", "--id", appId, "--display-name", "purview-daemon", "--years", "2", "--append", "--query", "{p:password}", "-o", "json"]);
  const clientSecret = secretObj.p;
  ok(`App ${appId}`);

  // ---- 2. graph permissions + consent (assign roles directly = reliable) ----
  info("Granting Graph + Exchange permissions…");
  const graphSp = azJson(["ad", "sp", "show", "--id", GRAPH_APP, "--query", "id", "-o", "json"]);
  let exoSp;
  try { exoSp = azJson(["ad", "sp", "show", "--id", EXO_APP, "--query", "id", "-o", "json"]); }
  catch { exoSp = azJson(["ad", "sp", "create", "--id", EXO_APP, "--query", "id", "-o", "json"]); }
  const assignRole = (resourceId, roleId) => {
    try {
      az(["rest", "--method", "POST", "--url", `https://graph.microsoft.com/v1.0/servicePrincipals/${spId}/appRoleAssignments`,
        "--headers", "Content-Type=application/json",
        "--body", JSON.stringify({ principalId: spId, resourceId, appRoleId: roleId }), "-o", "none"]);
    } catch (e) { if (!/already exists/i.test(String(e.stderr || e))) throw e; }
  };
  assignRole(graphSp, ROLE_CONTENT_PROCESS);
  assignRole(graphSp, ROLE_PROTECTION_SCOPES);
  assignRole(exoSp, ROLE_EXCHANGE_MANAGE);
  ok("App-role assignments granted");

  // ---- 3. cert + Compliance Administrator role ----
  info("Creating certificate and assigning Compliance Administrator…");
  const work = mkdtempSync(join(tmpdir(), "a365gov-"));
  const certPem = join(work, "cert.pem"), keyPem = join(work, "key.pem"), pfx = join(work, "cert.pfx");
  const pfxPw = "Pv" + Math.abs(Date.now() % 1e8) + "x";
  sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPem, "-out", certPem, "-days", "730", "-nodes", "-subj", `/CN=${appRegName}`]);
  sh("openssl", ["pkcs12", "-export", "-out", pfx, "-inkey", keyPem, "-in", certPem, "-passout", `pass:${pfxPw}`]);
  const certBody = sh("cat", [certPem]);
  az(["ad", "app", "credential", "reset", "--id", appId, "--cert", certBody, "--append", "--years", "2", "-o", "none"]);
  try {
    az(["rest", "--method", "POST", "--url", "https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments",
      "--headers", "Content-Type=application/json",
      "--body", JSON.stringify({ principalId: spId, roleDefinitionId: ROLE_COMPLIANCE_ADMIN, directoryScopeId: "/" }), "-o", "none"]);
  } catch (e) { if (!/conflict|exist/i.test(String(e.stderr || e))) throw e; }
  ok("Certificate uploaded, Compliance Administrator assigned");

  // ---- resolve attributed user + onmicrosoft domain ----
  const userId = azJson(["ad", "user", "show", "--id", attribUpn, "--query", "id", "-o", "json"]);
  const org = azJson(["rest", "--method", "GET", "--url", "https://graph.microsoft.com/v1.0/organization?$select=verifiedDomains",
    "--query", "value[0].verifiedDomains[?contains(name,'onmicrosoft.com')].name | [0]", "-o", "json"]);

  // ---- 4. DLP + collection policies via Security & Compliance PowerShell ----
  info("Provisioning Purview policies (this can retry while permissions propagate)…");
  const ps = buildProvisionScript({ appId, org, pfx, pfxPw, purviewAppName, wantCreditCard, customSitTerms, work });
  const psPath = join(work, "provision.ps1");
  writeFileSync(psPath, ps);
  try { execFileSync("pwsh", ["-NoProfile", "-File", psPath], { stdio: "inherit" }); }
  catch { warn("Policy provisioning reported an error — review output above. The connector + permissions are still set; you can re-run with the generated script at " + psPath); }

  // ---- 5. write .env ----
  info(`Writing ${envPath}…`);
  const block = [
    "", "# --- Agent 365 Governance Kit (Purview) ---",
    "PURVIEW_ENABLED=true",
    `PURVIEW_TENANT_ID=${tenantId}`,
    `PURVIEW_CLIENT_ID=${appId}`,
    `PURVIEW_CLIENT_SECRET=${clientSecret}`,
    `PURVIEW_APP_LOCATION=${appId}`,
    `PURVIEW_USER_ID=${userId}`,
    `PURVIEW_USER_UPN=${attribUpn}`,
    `PURVIEW_APP_NAME=${purviewAppName}`,
    `PURVIEW_FAIL_CLOSED=${failClosed}`,
  ];
  if (wantObservability && blueprintId) {
    block.push("", "# --- Agent 365 observability ---",
      "ENABLE_A365_OBSERVABILITY_EXPORTER=true",
      "A365_OBSERVABILITY_LOG_LEVEL=info|warn|error",
      `agent365Observability__tenantId=${tenantId}`,
      `agent365Observability__clientId=${blueprintId}`,
      `agent365Observability__clientSecret=${blueprintSecret}`,
      `agent365Observability__agentBlueprintId=${blueprintId}`,
      `agent365Observability__agentName=${agentName}`,
      `agent365Observability__agentDescription=${agentName}`);
  }
  if (existsSync(envPath)) appendFileSync(envPath, block.join("\n") + "\n");
  else writeFileSync(envPath, block.join("\n") + "\n");
  ok(`.env updated (${envPath})`);

  // ---- 6. validate ----
  info("Validating with a live processContent call…");
  try {
    const valid = await validate({ tenantId, appId, clientSecret, userId });
    ok(`Purview reachable — processContent returned ${valid}`);
  } catch (e) { warn("Validation call failed (often just propagation): " + (e.message || e)); }

  rl.close();
  console.log(`\n${C.g}${C.b}Done.${C.reset} Integrate with two calls — see the README:\n`);
  console.log(`  ${C.d}const guard = createPurviewGuard(loadConfig().purview);`);
  console.log(`  const v = await guard.evaluate(prompt, "uploadText", { correlationId });`);
  console.log(`  if (v.blocked) return v.reason;   // else call your model${C.reset}\n`);
  console.log(`  ${C.y}Note:${C.reset} DLP policies take up to ~1h to propagate before blocks fire.`);
}

function buildProvisionScript({ appId, org, pfx, pfxPw, purviewAppName, wantCreditCard, customSitTerms, work }) {
  const policyName = `${purviewAppName} DLP`;
  const loc = `[{"Workload":"Applications","Location":"${appId}","LocationDisplayName":"${purviewAppName}","LocationSource":"Entra","LocationType":"Individual","Inclusions":[{"Type":"Tenant","Identity":"All"}]}]`;
  const collLoc = `[{"Workload":"Applications","Location":"${appId}","LocationSource":"Entra","LocationType":"Individual","Inclusions":[{"Type":"Tenant","Identity":"All"}]}]`;
  let rules = "";
  if (wantCreditCard) {
    rules += `
if (-not (Get-DlpComplianceRule -Identity "${purviewAppName} Block CCN" -ErrorAction SilentlyContinue)) {
  New-DlpComplianceRule -Name "${purviewAppName} Block CCN" -Policy "${policyName}" -ContentContainsSensitiveInformation @{Name="Credit Card Number"} -GenerateAlert $true -RestrictAccess @(@{setting="UploadText";value="Block"}) | Out-Null
  Write-Host "  created CCN rule"
}`;
  }
  // custom keyword SIT (optional)
  let sitBlock = "";
  if (customSitTerms.length) {
    const sitXmlPath = join(work, "custom_sit.xml");
    writeCustomSit(sitXmlPath, purviewAppName, customSitTerms);
    sitBlock = `
$sitBytes = [System.IO.File]::ReadAllBytes('${sitXmlPath}')
try { New-DlpSensitiveInformationTypeRulePackage -FileData $sitBytes | Out-Null; Write-Host "  imported custom SIT" } catch { if ($_.Exception.Message -notmatch 'exist') { Write-Host ("  SIT import: " + $_.Exception.Message) } }
Start-Sleep -Seconds 5
if (-not (Get-DlpComplianceRule -Identity "${purviewAppName} Block Terms" -ErrorAction SilentlyContinue)) {
  New-DlpComplianceRule -Name "${purviewAppName} Block Terms" -Policy "${policyName}" -ContentContainsSensitiveInformation @{Name="${purviewAppName} Terms"} -GenerateAlert $true -RestrictAccess @(@{setting="UploadText";value="Block"}) | Out-Null
  Write-Host "  created custom-terms rule"
}`;
  }
  return `$ErrorActionPreference='Stop'
$pw = ConvertTo-SecureString '${pfxPw}' -AsPlainText -Force
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new('${pfx}', $pw)
Remove-Module ExchangeOnlineManagement -ErrorAction SilentlyContinue
if (-not (Get-Module -ListAvailable ExchangeOnlineManagement | Where-Object { $_.Version -eq '${EXO_MODULE_VERSION}' })) {
  Write-Host "Installing ExchangeOnlineManagement ${EXO_MODULE_VERSION}…"
  Install-Module ExchangeOnlineManagement -RequiredVersion ${EXO_MODULE_VERSION} -Scope CurrentUser -Force -AllowClobber
}
Import-Module ExchangeOnlineManagement -RequiredVersion ${EXO_MODULE_VERSION}
$connected=$false
for ($i=1; $i -le 12; $i++) {
  try { Connect-IPPSSession -AppId '${appId}' -Certificate $cert -Organization '${org}' -ShowBanner:$false; $connected=$true; break }
  catch { Write-Host ("  waiting for permission propagation (attempt $i)…"); Start-Sleep -Seconds 60 }
}
if (-not $connected) { Write-Host "Could not connect to Security & Compliance PowerShell yet — re-run this script later."; exit 1 }
Write-Host "Connected. Creating policies…"
if (-not (Get-DlpCompliancePolicy -Identity "${policyName}" -ErrorAction SilentlyContinue)) {
  New-DlpCompliancePolicy -Name "${policyName}" -Mode Enable -Locations '${loc}' -EnforcementPlanes @("Application") | Out-Null
  Write-Host "  created policy ${policyName}"
}
${sitBlock}
${rules}
try {
  if (-not (Get-FeatureConfiguration -FeatureScenario KnowYourData -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "DSPM for AI - Collection policy for enterprise AI apps" })) {
    New-FeatureConfiguration -FeatureScenario KnowYourData -Name "DSPM for AI - Collection policy for enterprise AI apps" -Mode Enable -ScenarioConfig '{"Activities":["UploadText","DownloadText"],"EnforcementPlanes":["Application"],"SensitiveTypeIds":["All"],"IsIngestionEnabled":true}' -Locations '${collLoc}' | Out-Null
    Write-Host "  created DSPM collection policy"
  }
} catch { Write-Host ("  collection policy: " + $_.Exception.Message) }
Disconnect-ExchangeOnline -Confirm:$false | Out-Null
Write-Host "Policy provisioning done."
`;
}

function writeCustomSit(path, appName, terms) {
  const guid = () => globalThis.crypto.randomUUID();
  const rulepack = guid(), publisher = guid(), entity = guid();
  const termsXml = terms.map((t) => `        <Term>${t}</Term>`).join("\n");
  const xml = `<?xml version="1.0" encoding="utf-16"?>
<RulePackage xmlns="http://schemas.microsoft.com/office/2011/mce">
  <RulePack id="${rulepack}">
    <Version major="1" minor="0" build="0" revision="0"/>
    <Publisher id="${publisher}"/>
    <Details defaultLangCode="en-us">
      <LocalizedDetails langcode="en-us">
        <PublisherName>Agent 365 Governance Kit</PublisherName>
        <Name>${appName} Custom SIT Pack</Name>
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
        <Name default="true" langcode="en-us">${appName} Terms</Name>
        <Description default="true" langcode="en-us">Custom blocked terms.</Description>
      </Resource>
    </LocalizedStrings>
  </Rules>
</RulePackage>`;
  writeFileSync(path, Buffer.from("﻿" + xml, "utf16le"));
}

async function validate({ tenantId, appId, clientSecret, userId }) {
  const tok = await (await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: appId, client_secret: clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  }).then((r) => r.json())).access_token;
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${userId}/dataSecurityAndGovernance/protectionScopes/compute`, {
    method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify({ activities: "uploadText,downloadText", locations: [{ "@odata.type": "microsoft.graph.policyLocationApplication", value: appId }] }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return `HTTP ${res.status}`;
}

main().catch((e) => die(e.stack || e.message || String(e)));
