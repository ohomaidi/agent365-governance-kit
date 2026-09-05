/**
 * Standing up the governance proxy for a third-party agent — the customer
 * never runs npm or node by hand.
 *
 *   scaffoldProxy()  folder with package.json pinned to the shipped tarballs,
 *                    `npm install`, start scripts for macOS/Linux and Windows
 *   startProxy()     launch it detached, wait for /_governance/health
 */
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, openSync, chmodSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync, spawn } from "node:child_process";

const PROXY_PKG = "@zaatarlabs/agent365-governance-proxy";
const KIT_PKG = "@zaatarlabs/agent365-governance-kit";

/** Find both shipped tarballs (kit/packages/*.tgz) or pack them from a checkout. */
export function findProxyTarballs(kitRoot, run = execFileSync) {
  const dir = join(kitRoot, "packages");
  const pick = (re) => { try { const f = readdirSync(dir).find((x) => re.test(x)); return f ? join(dir, f) : ""; } catch { return ""; } };
  let kit = pick(/^zaatarlabs-agent365-governance-kit-.*\.tgz$/), proxy = pick(/^zaatarlabs-agent365-governance-proxy-.*\.tgz$/);
  const pack = (sub) => {
    const src = join(kitRoot, "packages", sub);
    if (!existsSync(join(src, "package.json"))) return "";
    const out = run("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: src, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop();
    return join(dir, basename(out));
  };
  if (!kit) kit = pack("typescript");
  if (!proxy) proxy = pack("proxy");
  return { kit, proxy };
}

/**
 * @returns {{steps:string[], startCommand:string}}
 */
export function scaffoldProxy({ dir, tarballs, run = execFileSync }) {
  const steps = [];
  if (!tarballs?.kit || !tarballs?.proxy) throw new Error("the kit and proxy tarballs were not found — cannot set up the proxy");
  mkdirSync(join(dir, "logs"), { recursive: true });
  for (const t of [tarballs.kit, tarballs.proxy]) { const dst = join(dir, basename(t)); if (!existsSync(dst)) copyFileSync(t, dst); }
  const pkgPath = join(dir, "package.json");
  const pkg = {
    name: "agent365-governance-proxy-instance", private: true, type: "module",
    description: "Governance proxy instance written by the Agent 365 Governance Kit installer",
    scripts: { start: `node node_modules/${PROXY_PKG}/src/bin.mjs` },
    dependencies: { [KIT_PKG]: `file:./${basename(tarballs.kit)}`, [PROXY_PKG]: `file:./${basename(tarballs.proxy)}` },
  };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  steps.push(`installed ${PROXY_PKG} and its dependencies in ${dir}`);
  writeFileSync(join(dir, "start.sh"), `#!/bin/bash\n# Start the governance proxy (settings in .env next to this file).\ncd "$(dirname "$0")" && exec node node_modules/${PROXY_PKG}/src/bin.mjs "$@"\n`);
  try { chmodSync(join(dir, "start.sh"), 0o755); } catch { /* windows */ }
  writeFileSync(join(dir, "start.cmd"), `@echo off\r\ncd /d "%~dp0"\r\nnode node_modules\\${PROXY_PKG.replace("/", "\\")}\\src\\bin.mjs %*\r\n`);
  steps.push("wrote start.sh / start.cmd");
  return { steps, startCommand: `node node_modules/${PROXY_PKG}/src/bin.mjs` };
}

/** Launch detached; resolve when /_governance/health answers (any status) or after `timeoutMs`. */
export async function startProxy({ dir, port = 8787, timeoutMs = 20_000, fetchImpl = fetch }) {
  const out = openSync(join(dir, "logs", "proxy.log"), "a");
  const child = spawn(process.execPath, [join(dir, "node_modules", PROXY_PKG, "src", "bin.mjs")], { cwd: dir, detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/_governance/health`);
      const j = await res.json();
      return { pid: child.pid, governing: Boolean(j.governing), guard: j.guard, teams: Boolean(j.teams), status: res.status };
    } catch { /* not up yet */ }
  }
  return { pid: child.pid, governing: false, guard: "unknown", teams: false, status: 0 };
}
