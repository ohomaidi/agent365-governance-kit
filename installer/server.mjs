#!/usr/bin/env node
/**
 * Browser-based setup wizard.
 *
 * The customer double-clicks a launcher; this starts on a loopback-only port,
 * opens their browser, and drives the existing CLI wizard through its
 * --answers file. No terminal, and no second implementation of the
 * provisioning logic to drift out of sync.
 */
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { probeTenant } from "../wizard/lib/capabilities.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const WIZARD = join(ROOT, "wizard", "agent365-govern.mjs");
const IS_WINDOWS = process.platform === "win32";

const work = mkdtempSync(join(tmpdir(), "a365-installer-"));
const runs = new Map(); // id -> { child, buffer, done, code }

function which(cmd) {
  try {
    execFileSync(IS_WINDOWS ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

/** What's installed, and who (if anyone) is signed in. */
function preflight() {
  const tools = {
    node: process.version,
    az: which("az"),
    pwsh: which("pwsh"),
    openssl: IS_WINDOWS ? "n/a" : which("openssl"),
  };
  let account = null;
  if (tools.az) {
    try {
      account = JSON.parse(execFileSync("az", ["account", "show", "-o", "json"], { encoding: "utf8" }));
    } catch { account = null; }
  }
  const missing = [];
  if (!tools.az) missing.push({ name: "Azure CLI", url: "https://learn.microsoft.com/cli/azure/install-azure-cli" });
  if (!tools.pwsh) missing.push({ name: "PowerShell 7", url: "https://learn.microsoft.com/powershell/scripting/install/installing-powershell" });
  if (!IS_WINDOWS && !tools.openssl) missing.push({ name: "OpenSSL", url: "https://www.openssl.org/source/" });
  return {
    tools, missing, platform: process.platform,
    signedIn: Boolean(account),
    account: account ? { user: account.user?.name, tenantId: account.tenantId, name: account.name } : null,
    ready: missing.length === 0,
  };
}

/**
 * Work out what we can from the agent's own folder, so the customer isn't asked
 * questions only a developer could answer.
 */
function inspectAgent(dir) {
  const out = { ok: false, dir, language: null, envPath: null, name: null, evidence: [] };
  try {
    if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
      out.error = "That folder doesn't exist.";
      return out;
    }
  } catch { out.error = "That folder can't be read."; return out; }

  const has = (f) => existsSync(join(dir, f));
  const files = (() => { try { return readdirSync(dir); } catch { return []; } })();

  if (has("package.json")) {
    out.language = "typescript";
    out.evidence.push("package.json");
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name) out.name = pkg.name;
      // A JS project without TypeScript still uses the same Node package.
      if (!has("tsconfig.json") && !pkg.devDependencies?.typescript) out.evidence.push("plain JavaScript");
    } catch { /* name is a nicety */ }
  } else if (has("pyproject.toml") || has("requirements.txt") || files.some((f) => f.endsWith(".py"))) {
    out.language = "python";
    out.evidence.push(has("pyproject.toml") ? "pyproject.toml" : has("requirements.txt") ? "requirements.txt" : "*.py");
  } else if (files.some((f) => f.endsWith(".csproj") || f.endsWith(".sln"))) {
    out.language = "dotnet";
    out.evidence.push(files.find((f) => f.endsWith(".csproj")) || files.find((f) => f.endsWith(".sln")));
  }

  out.envPath = join(dir, ".env");
  out.envExists = existsSync(out.envPath);
  if (!out.name) out.name = dir.split(/[/\\]/).filter(Boolean).pop() || "My Agent";
  out.ok = Boolean(out.language);
  if (!out.ok) out.error = "Couldn't tell what this agent is built with — pick the language yourself under Advanced.";
  return out;
}

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = readFileSync(join(HERE, "ui.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(html);
  }

  if (req.method === "GET" && url.pathname === "/api/preflight") return json(res, 200, preflight());

  // Tooling readiness says nothing about whether the TENANT can do this.
  if (req.method === "GET" && url.pathname === "/api/tenants") {
    // Which directories can this account actually reach?
    try {
      const out = execFileSync("az", ["account", "list", "--all", "-o", "json"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const seen = new Map();
      for (const a of JSON.parse(out || "[]")) {
        if (!seen.has(a.tenantId)) seen.set(a.tenantId, { tenantId: a.tenantId, name: a.name, isDefault: a.isDefault });
      }
      return json(res, 200, { tenants: [...seen.values()] });
    } catch { return json(res, 200, { tenants: [] }); }
  }

  if (req.method === "GET" && url.pathname === "/api/tenant") {
    const azJson = (args) => {
      const out = execFileSync("az", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      return out ? JSON.parse(out) : null;
    };
    try { return json(res, 200, await probeTenant(azJson)); }
    catch (e) { return json(res, 500, { error: String(e.message) }); }
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    // Sign-in is streamed, not awaited. execFileSync here would block the whole
    // single-threaded server, freezing the page for the duration of the login,
    // and swallowing the device code when az can't open a browser (RDP, a
    // server console, a locked-down desktop) — leaving the customer staring at
    // nothing forever.
    let raw = "";
    req.on("data", (c) => (raw += c));
    await new Promise((r) => req.on("end", r));
    let opts = {};
    try { opts = JSON.parse(raw || "{}"); } catch { /* defaults are fine */ }

    const args = ["login"];
    if (opts.tenant) args.push("--tenant", String(opts.tenant));
    if (opts.deviceCode) args.push("--use-device-code");
    args.push("--only-show-errors");

    const id = randomUUID();
    const child = spawn("az", args, { stdio: ["ignore", "pipe", "pipe"] });
    const run = { child, buffer: [], done: false, code: null, deviceCode: null };
    runs.set(id, run);

    const push = (chunk) => {
      const text = String(chunk);
      for (const line of text.split(/\r?\n/)) if (line.trim()) run.buffer.push(line);
      // Surface the device code so the page can show it in large type.
      const m = text.match(/code\s+([A-Z0-9]{6,})\s+to authenticate/i);
      if (m) run.deviceCode = m[1];
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("close", (code) => { run.done = true; run.code = code; });

    // Don't let a cancelled sign-in hang around forever.
    setTimeout(() => { if (!run.done) { try { child.kill(); } catch {} } }, 10 * 60 * 1000);

    return json(res, 200, { id });
  }

  if (req.method === "GET" && url.pathname === "/api/login-status") {
    const run = runs.get(url.searchParams.get("id"));
    if (!run) return json(res, 404, { error: "unknown login" });
    return json(res, 200, {
      done: run.done, code: run.code, deviceCode: run.deviceCode,
      lines: run.buffer.slice(-6),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/run") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    await new Promise((r) => req.on("end", r));
    let payload;
    try { payload = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "bad JSON" }); }

    const id = randomUUID();
    const answersPath = join(work, `${id}.json`);
    writeFileSync(answersPath, JSON.stringify(payload.answers ?? {}, null, 2), { mode: 0o600 });

    const args = [WIZARD, "--answers", answersPath];
    if (payload.dryRun) args.push("--dry-run");
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const run = { child, buffer: [], done: false, code: null, answersPath };
    runs.set(id, run);
    const push = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) run.buffer.push(line);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("close", (code) => {
      run.done = true;
      run.code = code;
      // The answers file holds the operator's inputs; don't leave it around.
      try { rmSync(answersPath, { force: true }); } catch { /* best effort */ }
    });
    return json(res, 200, { id });
  }

  if (req.method === "GET" && url.pathname === "/api/log") {
    const run = runs.get(url.searchParams.get("id"));
    if (!run) return json(res, 404, { error: "unknown run" });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    let sent = 0;
    const tick = setInterval(() => {
      while (sent < run.buffer.length) {
        res.write(`data: ${JSON.stringify(run.buffer[sent++])}\n\n`);
      }
      if (run.done) {
        res.write(`event: done\ndata: ${JSON.stringify({ code: run.code })}\n\n`);
        clearInterval(tick);
        res.end();
      }
    }, 150);
    req.on("close", () => clearInterval(tick));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/detect") {
    return json(res, 200, inspectAgent(url.searchParams.get("dir") || ""));
  }

  if (req.method === "GET" && url.pathname === "/api/defaults") {
    // Deliberately NOT process.cwd(): that is the kit's own folder, and
    // defaulting to it would write the customer's config into our repo.
    return json(res, 200, { home: homedir(), sep: IS_WINDOWS ? "\\" : "/" });
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

// Loopback only — this endpoint can provision a tenant; it must not be reachable
// from the network.
const port = Number(process.env.A365_INSTALLER_PORT ?? 0);
server.listen(port, "127.0.0.1", () => {
  const addr = `http://127.0.0.1:${server.address().port}`;
  console.log(`\n  Agent 365 Governance Kit — setup\n  Open: ${addr}\n`);
  const opener = IS_WINDOWS ? ["cmd", ["/c", "start", "", addr]]
    : process.platform === "darwin" ? ["open", [addr]]
    : ["xdg-open", [addr]];
  try { spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref(); } catch { /* user opens it */ }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { try { rmSync(work, { recursive: true, force: true }); } catch {} process.exit(0); });
}
