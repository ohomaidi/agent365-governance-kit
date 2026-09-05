/**
 * Tests for the wizard's pure logic — the parts that decide what gets created
 * in a customer tenant, and what gets written to their .env.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { psLit, odata, writeEnvBlock, buildProvisionScript, makeCertificate,
         agent365Checklist, integrationSnippet, ensurePilotGroup, grantBlueprintConsent, BEGIN, END } from "../agent365-govern.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "a365-wiztest-"));

describe("shell/PowerShell quoting", () => {
  test("single quotes are doubled for PowerShell literals", () => {
    assert.equal(psLit("O'Brien Corp"), "'O''Brien Corp'");
  });

  test("a quote cannot terminate the literal early", () => {
    const out = psLit("x'; Remove-Item -Recurse / #");
    assert.equal(out.startsWith("'"), true);
    assert.equal(out.endsWith("'"), true);
    // every interior quote is escaped as a doubled pair
    assert.equal(/(^'|[^'])'(?!')/.test(out.slice(1, -1)), false);
  });

  test("OData literals escape quotes", () => {
    assert.equal(odata("O'Brien"), "O''Brien");
  });
});

describe(".env writing", () => {
  const block = ["PURVIEW_ENABLED=true", "PURVIEW_CLIENT_SECRET=secret-v1"];

  test("creates a new .env with the managed markers", () => {
    const p = join(tmp(), ".env");
    assert.equal(writeEnvBlock(p, block), "created");
    const s = readFileSync(p, "utf8");
    assert.match(s, new RegExp(BEGIN.replace(/[>]/g, "\\>")));
    assert.match(s, /PURVIEW_CLIENT_SECRET=secret-v1/);
  });

  test("re-running REPLACES the block instead of appending a duplicate", () => {
    const p = join(tmp(), ".env");
    writeEnvBlock(p, block);
    const how = writeEnvBlock(p, ["PURVIEW_ENABLED=true", "PURVIEW_CLIENT_SECRET=secret-v2"]);
    assert.equal(how, "replaced");
    const s = readFileSync(p, "utf8");
    assert.equal((s.match(/PURVIEW_CLIENT_SECRET=/g) || []).length, 1, "must not leave two secrets");
    assert.match(s, /secret-v2/);
    assert.equal(s.includes("secret-v1"), false);
    assert.equal((s.match(new RegExp(BEGIN.replace(/[>]/g, "\\>"), "g")) || []).length, 1);
  });

  test("preserves the host app's own variables", () => {
    const p = join(tmp(), ".env");
    writeFileSync(p, "APP_PORT=3000\nOPENAI_KEY=xyz\n");
    writeEnvBlock(p, block);
    const s = readFileSync(p, "utf8");
    assert.match(s, /APP_PORT=3000/);
    assert.match(s, /OPENAI_KEY=xyz/);
  });

  test("backs up an existing .env before touching it", () => {
    const p = join(tmp(), ".env");
    writeFileSync(p, "APP_PORT=3000\n");
    writeEnvBlock(p, block);
    assert.equal(existsSync(`${p}.bak`), true);
    assert.match(readFileSync(`${p}.bak`, "utf8"), /APP_PORT=3000/);
  });

  test("comments out loose keys written by the older wizard", () => {
    const p = join(tmp(), ".env");
    writeFileSync(p, "APP_PORT=3000\nPURVIEW_CLIENT_SECRET=old-loose-secret\n");
    const how = writeEnvBlock(p, block);
    assert.match(how, /replaced/);
    const s = readFileSync(p, "utf8");
    assert.match(s, /# superseded by agent365-governance-kit: PURVIEW_CLIENT_SECRET=old-loose-secret/);
    // The only *live* secret line is the new one.
    const live = s.split("\n").filter((l) => /^PURVIEW_CLIENT_SECRET=/.test(l));
    assert.deepEqual(live, ["PURVIEW_CLIENT_SECRET=secret-v1"]);
  });
});

describe("provisioning script safety", () => {
  const base = {
    appId: "app-1", org: "contoso.onmicrosoft.com", pfx: "/tmp/x.pfx",
    purviewAppName: "Abbas", wantCreditCard: true, customSitTerms: [], work: tmpdir(),
    scopeInclusions: [{ Type: "Group", Identity: "pilot@contoso.com" }],
    wantDspm: true, dspmIngest: false,
  };

  /** The DLP policy line is the one that decides whether prompts get blocked.
   *  (The DSPM collection policy legitimately uses -Mode Enable — it collects,
   *  it doesn't block — so assert on the DLP line specifically.) */
  const dlpLine = (ps) => ps.split("\n").find((l) => l.includes("New-DlpCompliancePolicy")) ?? "";

  test("defaults to a TEST mode, not active blocking", () => {
    const ps = buildProvisionScript({ ...base, dlpMode: "TestWithNotifications" });
    assert.match(dlpLine(ps), /-Mode TestWithNotifications/);
    assert.equal(/-Mode Enable\b/.test(dlpLine(ps)), false, "DLP policy must not enforce by default");
  });

  test("pilot-group scope does not become tenant-wide", () => {
    const ps = buildProvisionScript({ ...base, dlpMode: "TestWithNotifications" });
    assert.match(ps, /pilot@contoso\.com/);
    assert.equal(ps.includes('"Type":"Tenant"'), false, "must not silently widen to the tenant");
  });

  test("tenant-wide scope is emitted only when explicitly requested", () => {
    const ps = buildProvisionScript({
      ...base, dlpMode: "Enable", scopeInclusions: [{ Type: "Tenant", Identity: "All" }],
    });
    assert.match(ps, /"Type":"Tenant"/);
    assert.match(dlpLine(ps), /-Mode Enable/);
  });

  test("the PFX password is never written into the script", () => {
    const ps = buildProvisionScript({ ...base, dlpMode: "TestWithNotifications" });
    assert.match(ps, /\$env:A365_PFX_PW/, "password must come from the environment");
    assert.equal(/ConvertTo-SecureString\s+'/.test(ps), false, "no inline password literal");
  });

  test("DSPM ingestion is off unless asked for", () => {
    const off = buildProvisionScript({ ...base, dlpMode: "TestWithNotifications", dspmIngest: false });
    assert.match(off, /"IsIngestionEnabled":false/);
    const on = buildProvisionScript({ ...base, dlpMode: "TestWithNotifications", dspmIngest: true });
    assert.match(on, /"IsIngestionEnabled":true/);
  });

  test("skipping DSPM emits no collection policy at all", () => {
    const ps = buildProvisionScript({ ...base, dlpMode: "TestWithNotifications", wantDspm: false });
    assert.equal(ps.includes("New-FeatureConfiguration"), false);
  });

  test("an app name with a quote cannot break out of the literal", () => {
    const ps = buildProvisionScript({
      ...base, purviewAppName: "Ab'bas'; Remove-Item /", dlpMode: "TestWithNotifications",
    });
    // The injected quote is escaped, so no bare "'; " sequence survives.
    assert.equal(ps.includes("'; Remove-Item /'"), false);
    assert.match(ps, /Ab''bas/);
  });

  test("always disconnects the PowerShell session, even on error", () => {
    const ps = buildProvisionScript({ ...base, dlpMode: "TestWithNotifications" });
    assert.match(ps, /finally\s*\{[\s\S]*Disconnect-ExchangeOnline/);
  });

  test("does not silently change an existing policy's mode or scope", () => {
    const ps = buildProvisionScript({ ...base, dlpMode: "Enable" });
    assert.match(ps, /already exists — leaving its mode and scope untouched/);
  });
});

describe("certificate generation", () => {
  const capture = () => {
    const calls = [];
    const run = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return ""; };
    return { calls, run };
  };

  test("the PFX password never appears in argv on either platform", () => {
    const { calls, run } = capture();
    makeCertificate({ work: "/tmp/w", subjectName: "Abbas", pfxPw: "P@ssw0rd-secret", run });
    for (const c of calls) {
      const argv = (c.args || []).join(" ");
      assert.equal(argv.includes("P@ssw0rd-secret"), false,
        `password leaked into argv of ${c.cmd} (visible in ps auxww)`);
    }
  });

  test("the password is handed over through the environment instead", () => {
    const { calls, run } = capture();
    makeCertificate({ work: "/tmp/w", subjectName: "Abbas", pfxPw: "s3cret-value", run });
    const withEnv = calls.filter((c) => c.opts?.env?.A365_PFX_PW === "s3cret-value");
    assert.ok(withEnv.length > 0, "no call received the password via env");
  });

  test("a hostile subject name cannot inject shell or PowerShell syntax", () => {
    const { calls, run } = capture();
    makeCertificate({ work: "/tmp/w", subjectName: "Ab'; Remove-Item / #", pfxPw: "x", run });
    const all = calls.map((c) => (c.args || []).join(" ")).join("\n");
    assert.equal(all.includes("Remove-Item / #"), false, "subject name was not sanitised");
    assert.match(all, /Ab__ Remove-Item _ _|Ab__/);
  });

  test("returns the paths the provisioning step needs", () => {
    const { run } = capture();
    const r = makeCertificate({ work: "/tmp/w", subjectName: "A", pfxPw: "x", run });
    assert.match(r.certPem, /cert\.pem$/);
    assert.match(r.pfxPath, /cert\.pfx$/);
  });
});

describe("closing output", () => {
  // A ReferenceError here only surfaces at the very end of a real provision,
  // after the tenant has already been changed — so it gets its own coverage.
  test("the checklist renders with and without a blueprint id", () => {
    for (const id of ["", undefined, "bp-app-123"]) {
      const out = agent365Checklist({ agentName: "Abbas", lang: "typescript", blueprintId: "", blueprintAppId: id,
                                      messagingEndpoint: id ? "https://a.example.com/api/messages" : "" });
      assert.match(out, /Completing Agent 365 setup/);
      assert.match(out, /Teams Developer Portal/, "the one remaining manual step is named");
      assert.match(out, id ? /Bot ID\s+bp-app-123/ : /<blueprint appId>/);
    }
  });

  test("an integration snippet exists for every language the wizard offers", () => {
    for (const lang of ["typescript", "python", "dotnet", "csharp", "unknown"]) {
      assert.ok(integrationSnippet(lang).includes("guard"), `no snippet for ${lang}`);
    }
  });
});

describe("pilot group scope", () => {
  const stub = (existing) => {
    const calls = [];
    const azJson = (args) => {
      const key = args.join(" "); calls.push(key);
      if (key.includes("groups?$filter=mailNickname")) return existing ? { id: "g-1", mail: "pilot@contoso.com", displayName: "P" } : null;
      if (key.includes("/members?")) return ["u-1"];
      if (key.includes("--method POST") && key.includes("/groups ")) return { id: "g-new", mail: "new@contoso.com", displayName: "P" };
      return null;
    };
    const az = (args) => { calls.push(args.join(" ")); return ""; };
    return { calls, deps: { azJson, az } };
  };

  test("creates a Microsoft 365 (mail-enabled) group when none exists", () => {
    const { calls, deps } = stub(false);
    const g = ensurePilotGroup({ displayName: "P", mailNickname: "p", ownerId: "o", memberIds: ["u-1"] }, deps);
    assert.equal(g.created, true); assert.equal(g.mail, "new@contoso.com");
    const post = calls.find((c) => c.includes("--method POST") && c.includes("/groups "));
    assert.match(post, /"groupTypes":\["Unified"\]/); assert.match(post, /"mailEnabled":true/);
  });

  test("reuses an existing group and adds only the missing members", () => {
    const { calls, deps } = stub(true);
    const g = ensurePilotGroup({ displayName: "P", mailNickname: "p", ownerId: "o", memberIds: ["u-1", "u-2"] }, deps);
    assert.equal(g.created, false);
    const adds = calls.filter((c) => c.includes("/members/$ref"));
    assert.equal(adds.length, 1, "u-1 is already a member; only u-2 is added");
    assert.match(adds[0], /directoryObjects\/u-2/);
  });

  test("Purview binds to Tenant or Group only — a per-user binding is never emitted", () => {
    const ps = buildProvisionScript({
      appId: "app", org: "o.onmicrosoft.com", pfx: "/x.pfx", purviewAppName: "A", wantCreditCard: true,
      customSitTerms: [], work: "/tmp", dlpMode: "TestWithNotifications",
      scopeInclusions: [{ Type: "Group", Identity: "a-pilot@o.onmicrosoft.com" }], wantDspm: false, dspmIngest: false,
    });
    assert.match(ps, /"Type":"Group","Identity":"a-pilot@o\.onmicrosoft\.com"/);
    assert.equal(ps.includes('"Type":"User"'), false);
  });
});


describe("DSPM collection policy is per-tenant", () => {
  const base = {
    appId: "app-2", org: "o.onmicrosoft.com", pfx: "/x.pfx", purviewAppName: "Abbas Test 2", wantCreditCard: false,
    customSitTerms: [], work: "/tmp", dlpMode: "TestWithNotifications",
    scopeInclusions: [{ Type: "Group", Identity: "p@o.onmicrosoft.com" }],
  };
  test("a second agent is appended to the existing policy, not skipped", () => {
    const ps = buildProvisionScript({ ...base, wantDspm: true, dspmIngest: false });
    assert.match(ps, /New-FeatureConfiguration/, "creates it when absent");
    assert.match(ps, /Set-FeatureConfiguration -Identity \$fc\.Identity -Locations \$merged/, "appends when present");
    assert.match(ps, /could not be appended/, "says so honestly if the append does not take");
  });
  test("no DSPM means no DSPM cmdlets at all", () => {
    const ps = buildProvisionScript({ ...base, wantDspm: false, dspmIngest: false });
    assert.equal(/FeatureConfiguration/.test(ps), false);
  });
});

describe("blueprint admin consent", () => {
  const stub = (grantExists, scope = "") => {
    const calls = [];
    const azJson = (a) => { const k = a.join(" "); calls.push(k);
      if (k.includes("sp show")) return "rsp-1";
      if (k.includes("oauth2PermissionGrants?$filter")) return grantExists ? { id: "g-1", scope } : null;
      return null; };
    const az = (a) => { calls.push(a.join(" ")); return ""; };
    return { calls, deps: { azJson, az } };
  };
  test("grants tenant-wide delegated consent for each resource when none exists", () => {
    const { calls, deps } = stub(false);
    const out = grantBlueprintConsent({ blueprintPrincipalId: "bp-sp" }, deps);
    const posts = calls.filter((c) => c.includes("--method POST") && c.includes("oauth2PermissionGrants"));
    assert.equal(posts.length, 3);
    assert.ok(posts.every((c) => c.includes('"consentType":"AllPrincipals"') && c.includes('"clientId":"bp-sp"')));
    assert.ok(posts.some((c) => c.includes("Agent365.Observability.OtelWrite")));
    assert.equal(out.filter((l) => l.startsWith("consent granted")).length, 3);
  });
  test("merges scopes into an existing grant instead of duplicating it", () => {
    const { calls, deps } = stub(true, "SomeOther.Scope");
    grantBlueprintConsent({ blueprintPrincipalId: "bp-sp" }, deps);
    const patches = calls.filter((c) => c.includes("--method PATCH"));
    assert.equal(patches.length, 3);
    assert.ok(patches[0].includes("SomeOther.Scope"), "existing scope preserved");
    assert.equal(calls.some((c) => c.includes("--method POST") && c.includes("oauth2PermissionGrants")), false);
  });
});


describe("Security & Compliance connect is verified, not assumed", () => {
  const ps = buildProvisionScript({
    appId: "app", org: "o.onmicrosoft.com", pfx: "/x.pfx", purviewAppName: "A", wantCreditCard: true,
    customSitTerms: [], work: "/tmp", dlpMode: "TestWithNotifications",
    scopeInclusions: [{ Type: "Group", Identity: "p@o.onmicrosoft.com" }], wantDspm: false, dspmIngest: false,
  });
  test("checks the DLP cmdlets actually imported after connecting", () => {
    assert.match(ps, /Get-Command Get-DlpCompliancePolicy/);
  });
  test("never swallows the connect's output stream (that is what lost the cmdlets on a retry)", () => {
    const connects = ps.split("\n").filter((l) => l.includes("Connect-IPPSSession"));
    assert.ok(connects.length >= 1);
    for (const l of connects) assert.equal(l.includes("*>$null"), false, l);
  });
  test("resets the half-open session before retrying", () => {
    const i = ps.indexOf("catch {"); const j = ps.indexOf("Start-Sleep -Seconds $delays[$i]");
    assert.ok(i > -1 && j > i);
    assert.match(ps.slice(i, j), /Disconnect-ExchangeOnline/);
  });
});
