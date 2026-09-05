/**
 * Tests for the wizard's pure logic — the parts that decide what gets created
 * in a customer tenant, and what gets written to their .env.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { psLit, odata, writeEnvBlock, buildProvisionScript, BEGIN, END } from "../agent365-govern.mjs";

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
