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
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync, mkdirSync, createWriteStream, chmodSync } from "node:fs";
import { tmpdir, homedir, arch } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { probeTenant } from "../wizard/lib/capabilities.mjs";
import { TokenCache, startDeviceCode, pollDeviceCode, makeDelegatedGraph, CLIENTS, GRAPH_SCOPE_STRING, DEVPORTAL_SCOPE } from "../wizard/lib/auth.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const WIZARD = join(ROOT, "wizard", "agent365-govern.mjs");
const IS_WINDOWS = process.platform === "win32";

const work = mkdtempSync(join(tmpdir(), "a365-installer-"));
const runs = new Map(); // id -> { child, buffer, done, code }

// One sign-in for the whole session. Tokens live in a 0600 file inside the
// work dir (removed on exit); A365_TOKEN_CACHE lets a re-run reuse a sign-in.
const TOKEN_CACHE = process.env.A365_TOKEN_CACHE || join(work, "tokens.json");
const cache = new TokenCache(TOKEN_CACHE);

/** The two sign-ins the run needs, and why. */
const SIGNINS = [
  { key: "graph", clientId: CLIENTS.graphCli, scope: GRAPH_SCOPE_STRING,
    label: "Microsoft 365 (Entra, Purview, Teams app catalog)", consent: "Tick \u201cConsent on behalf of your organization\u201d." },
  { key: "devportal", clientId: CLIENTS.teamsToolkit, scope: DEVPORTAL_SCOPE, optional: true,
    label: "Teams Developer Portal (only for the classic app/bot option)", consent: "" },
];
const signinState = () => SIGNINS.map((s) => ({ key: s.key, label: s.label, consent: s.consent, optional: Boolean(s.optional), done: cache.signedIn(s.clientId) }));

function which(cmd) {
  try {
    execFileSync(IS_WINDOWS ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

/* ---- PowerShell 7: found on PATH, or downloaded to the user's profile ---- */
const PWSH_VERSION = "7.4.6";
const PWSH_HOME = join(homedir(), ".agent365", `pwsh-${PWSH_VERSION}`);
const PWSH_BIN = join(PWSH_HOME, IS_WINDOWS ? "pwsh.exe" : "pwsh");
function pwshPath() {
  if (process.env.A365_PWSH && existsSync(process.env.A365_PWSH)) return process.env.A365_PWSH;
  if (which("pwsh")) return "pwsh";
  if (existsSync(PWSH_BIN)) return PWSH_BIN;
  return "";
}
function pwshAsset() {
  const a = arch() === "arm64" ? "arm64" : "x64";
  if (IS_WINDOWS) return { file: `PowerShell-${PWSH_VERSION}-win-${a}.zip`, kind: "zip" };
  if (process.platform === "darwin") return { file: `powershell-${PWSH_VERSION}-osx-${a}.tar.gz`, kind: "tgz" };
  return { file: `powershell-${PWSH_VERSION}-linux-${a}.tar.gz`, kind: "tgz" };
}
/** Download the official portable build into ~/.agent365 (no admin rights needed). */
async function installPwsh(log) {
  const { file, kind } = pwshAsset();
  const url = `https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/${file}`;
  mkdirSync(PWSH_HOME, { recursive: true });
  const archive = join(PWSH_HOME, file);
  log(`Downloading PowerShell ${PWSH_VERSION} from github.com/PowerShell/PowerShell…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));
  log("Extracting…");
  if (kind === "tgz") {
    execFileSync("tar", ["-xzf", archive, "-C", PWSH_HOME], { stdio: "ignore" });
    chmodSync(PWSH_BIN, 0o755);
  } else {
    // Windows PowerShell 5.1 is always present and can unzip.
    execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${PWSH_HOME}' -Force`], { stdio: "ignore" });
  }
  rmSync(archive, { force: true });
  execFileSync(PWSH_BIN, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { stdio: "ignore" });
  log(`PowerShell ${PWSH_VERSION} ready at ${PWSH_BIN}`);
  return PWSH_BIN;
}

/** What's installed, and who (if anyone) is signed in. */
function preflight() {
  const pwsh = pwshPath();
  const tools = {
    node: process.version,
    pwsh: pwsh ? (pwsh === "pwsh" ? true : pwsh) : false,
    openssl: IS_WINDOWS ? "n/a" : which("openssl"),
  };
  const missing = [];
  if (!pwsh) missing.push({ name: "PowerShell 7", url: "https://learn.microsoft.com/powershell/scripting/install/installing-powershell", auto: true });
  if (!IS_WINDOWS && !tools.openssl) missing.push({ name: "OpenSSL", url: "https://www.openssl.org/source/" });
  const account = cache.account(CLIENTS.graphCli);
  const signins = signinState();
  return {
    tools, missing, platform: process.platform,
    signins,
    signedIn: signins.filter((s) => !s.optional).every((s) => s.done),
    account: account ? { user: account.upn, tenantId: account.tenantId, name: account.name } : null,
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
  if (req.method === "GET" && url.pathname === "/api/tenant") {
    try { return json(res, 200, await probeTenant(makeDelegatedGraph(cache), cache.account(CLIENTS.graphCli))); }
    catch (e) { return json(res, 500, { error: String(e.message) }); }
  }

  // Download a portable PowerShell 7 into the user's profile. Streamed so the
  // page can show progress; nothing system-wide is touched.
  if (req.method === "POST" && url.pathname === "/api/install-pwsh") {
    const id = randomUUID();
    const run = { buffer: [], done: false, code: null };
    runs.set(id, run);
    installPwsh((m) => run.buffer.push(m))
      .then(() => { run.done = true; run.code = 0; })
      .catch((e) => { run.buffer.push(`\u2717 ${e.message}`); run.done = true; run.code = 1; });
    return json(res, 200, { id });
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    // Device-code sign-in, in-process: no Azure CLI, and the password is typed
    // into Microsoft's page, never into ours. The page shows the code in large
    // type and polls for completion; the server never blocks.
    let raw = "";
    req.on("data", (c) => (raw += c));
    await new Promise((r) => req.on("end", r));
    let opts = {};
    try { opts = JSON.parse(raw || "{}"); } catch { /* defaults are fine */ }
    const which = SIGNINS.find((x) => x.key === (opts.which || "graph")) ?? SIGNINS[0];
    // The second sign-in must land in the same tenant as the first.
    const tenant = (which.key !== "graph" && cache.account(CLIENTS.graphCli)?.tenantId) || String(opts.tenant || "").trim() || "organizations";

    const id = randomUUID();
    const run = { done: false, code: null, deviceCode: null, verificationUri: "", error: "", which: which.key };
    runs.set(id, run);
    (async () => {
      const dc = await startDeviceCode({ tenant, clientId: which.clientId, scope: which.scope });
      run.deviceCode = dc.userCode; run.verificationUri = dc.verificationUri;
      const tok = await pollDeviceCode({ tenant, clientId: which.clientId, deviceCode: dc.deviceCode, interval: dc.interval, expiresIn: dc.expiresIn });
      cache.addSignIn(which.clientId, tok, which.scope);
    })().then(() => { run.done = true; run.code = 0; })
      .catch((e) => { run.error = String(e.message || e); run.done = true; run.code = 1; });
    return json(res, 200, { id, which: which.key });
  }

  if (req.method === "GET" && url.pathname === "/api/login-status") {
    const run = runs.get(url.searchParams.get("id"));
    if (!run) return json(res, 404, { error: "unknown login" });
    return json(res, 200, {
      done: run.done, code: run.code, deviceCode: run.deviceCode, verificationUri: run.verificationUri,
      error: run.error, which: run.which, signins: signinState(), lines: run.buffer ? run.buffer.slice(-6) : [],
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
    const pwsh = pwshPath();
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: "0", A365_TOKEN_CACHE: TOKEN_CACHE, ...(pwsh && pwsh !== "pwsh" ? { A365_PWSH: pwsh } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Keep a copy of every run on disk: a failure seen only in the browser tab
    // is gone when the tab is; a file under ~/.agent365/logs can be sent along.
    const logDir = join(homedir(), ".agent365", "logs");
    let logFile = "";
    try {
      mkdirSync(logDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = String(payload.answers?.agentName ?? "agent").replace(/[^\w-]+/g, "_").slice(0, 40);
      logFile = join(logDir, `${stamp}-${name}${payload.dryRun ? "-dryrun" : ""}.log`);
      writeFileSync(logFile, "", { mode: 0o600 });
    } catch { logFile = ""; }
    const run = { child, buffer: [], done: false, code: null, answersPath, logFile };
    runs.set(id, run);
    const push = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) run.buffer.push(line);
      if (logFile) { try { appendFileSync(logFile, String(chunk)); } catch { /* best effort */ } }
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("close", (code) => {
      run.done = true;
      run.code = code;
      // The answers file holds the operator's inputs; don't leave it around.
      try { rmSync(answersPath, { force: true }); } catch { /* best effort */ }
    });
    return json(res, 200, { id, logFile });
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

  if (req.method === "GET" && url.pathname === "/api/task-status") {
    const run = runs.get(url.searchParams.get("id"));
    if (!run) return json(res, 404, { error: "unknown task" });
    return json(res, 200, { done: run.done, code: run.code, lines: run.buffer.slice(-8) });
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
