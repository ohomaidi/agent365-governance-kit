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
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

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

  if (req.method === "POST" && url.pathname === "/api/login") {
    // az login opens the system browser itself; we just wait for it.
    try {
      execFileSync("az", ["login"], { stdio: "ignore" });
      return json(res, 200, preflight());
    } catch (e) {
      return json(res, 500, { error: "az login failed or was cancelled" });
    }
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

  if (req.method === "GET" && url.pathname === "/api/defaults") {
    return json(res, 200, { home: homedir(), cwd: process.cwd(), sep: IS_WINDOWS ? "\\" : "/" });
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
