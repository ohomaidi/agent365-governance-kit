/**
 * Wiring the Purview guard into the customer's agent — without asking them to
 * edit code.
 *
 *   detectGuard()   is the guard already integrated? (dependency or calls present)
 *   wireNodeGuard() Node agents on the Microsoft 365 Agents SDK: install the kit
 *                   package from the shipped tarball, drop the preload file, and
 *                   prefix the start script with `node --import`. Idempotent.
 *
 * Python and .NET have no equivalent runtime hook the kit can install safely, so
 * for those the wizard says so and offers the governance proxy instead.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";

const PRELOAD = "agent365-guard.preload.mjs";
const PKG = "@zaatarlabs/agent365-governance-kit";

function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }
function* walk(dir, depth = 3) {
  if (depth < 0) return;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "dist" || e.name === "bin" || e.name === "obj") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth - 1);
    else yield p;
  }
}
function grepAny(dir, exts, patterns) {
  for (const f of walk(dir)) {
    if (!exts.some((x) => f.endsWith(x))) continue;
    let s = ""; try { if (statSync(f).size > 2_000_000) continue; s = readFileSync(f, "utf8"); } catch { continue; }
    if (patterns.some((re) => re.test(s))) return basename(f);
  }
  return "";
}

/**
 * @returns {{wired:boolean, how:string}} how = "dependency" | "calls" | "preload" | ""
 */
export function detectGuard(agentDir, lang) {
  if (lang === "proxy") return { wired: true, how: "proxy" };
  if (lang.startsWith("py")) {
    const req = ["requirements.txt", "pyproject.toml"].map((f) => { try { return readFileSync(join(agentDir, f), "utf8"); } catch { return ""; } }).join("\n");
    if (/agent365[-_]governance/.test(req)) return { wired: true, how: "dependency" };
    const f = grepAny(agentDir, [".py"], [/agent365_governance/, /PurviewGuard/]);
    return f ? { wired: true, how: "calls" } : { wired: false, how: "" };
  }
  if (lang.startsWith("dot") || lang.startsWith("cs") || lang.startsWith("net")) {
    const f = grepAny(agentDir, [".csproj", ".cs"], [/Agent365\.Governance/, /PurviewGuard/]);
    return f ? { wired: true, how: f.endsWith(".csproj") ? "dependency" : "calls" } : { wired: false, how: "" };
  }
  const pkg = readJson(join(agentDir, "package.json")) ?? {};
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (String(pkg.scripts?.start ?? "").includes(PRELOAD)) return { wired: true, how: "preload" };
  if (deps[PKG]) {
    const f = grepAny(agentDir, [".ts", ".js", ".mjs", ".cjs"], [/agent365-governance-kit/, /guard\.evaluate\(/]);
    if (f) return { wired: true, how: "calls" };
  }
  return { wired: false, how: "" };
}

/** Find the kit tarball the installer ships (kit/packages/*.tgz) or build one from a checkout. */
export function findKitTarball(kitRoot, run = execFileSync) {
  const shipped = join(kitRoot, "packages");
  try {
    const tgz = readdirSync(shipped).find((f) => /^zaatarlabs-agent365-governance-kit-.*\.tgz$/.test(f));
    if (tgz) return join(shipped, tgz);
  } catch { /* no shipped tarball */ }
  const src = join(kitRoot, "packages", "typescript");
  if (existsSync(join(src, "package.json"))) {
    const out = run("npm", ["pack", "--silent", "--pack-destination", shipped], { cwd: src, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop();
    return join(shipped, basename(out));
  }
  return "";
}

/**
 * Install the kit and the preload into a Node agent. Returns what was done.
 * @returns {{steps:string[], warnings:string[], startScript:string}}
 */
export function wireNodeGuard({ agentDir, tarball, run = execFileSync }) {
  const steps = [], warnings = [];
  const pkgPath = join(agentDir, "package.json");
  const pkg = readJson(pkgPath);
  if (!pkg) throw new Error(`no package.json in ${agentDir}`);

  // 1. dependency, from the shipped tarball (copied in so the project stays portable)
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (!deps[PKG]) {
    if (!tarball || !existsSync(tarball)) throw new Error("the kit's package tarball was not found — cannot install the guard");
    const local = join(agentDir, basename(tarball));
    copyFileSync(tarball, local);
    run("npm", ["install", "--no-audit", "--no-fund", `./${basename(tarball)}`], { cwd: agentDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    steps.push(`installed ${PKG} from ${basename(tarball)}`);
  } else steps.push(`${PKG} already a dependency`);

  // 2. preload file next to the agent
  const preloadSrc = new URL("../../packages/typescript/auto/agent365-guard.preload.mjs", import.meta.url);
  const preloadDst = join(agentDir, PRELOAD);
  let src = "";
  try { src = readFileSync(preloadSrc, "utf8"); }
  catch {
    // shipped layout: the preload is inside the installed package
    try { src = readFileSync(join(agentDir, "node_modules", "@zaatarlabs", "agent365-governance-kit", "auto", PRELOAD), "utf8"); } catch { /* below */ }
  }
  if (!src) throw new Error("preload file not found in the kit");
  writeFileSync(preloadDst, src);
  steps.push(`wrote ${PRELOAD}`);

  // 3. start script
  const fresh = readJson(pkgPath) ?? pkg;
  fresh.scripts ??= {};
  const start = String(fresh.scripts.start ?? "");
  let newStart = start;
  if (start.includes(PRELOAD)) {
    steps.push("start script already loads the guard");
  } else if (/^node\s+/.test(start)) {
    newStart = start.replace(/^node\s+/, `node --import ./${PRELOAD} `);
  } else if (!start) {
    const main = fresh.main || "dist/index.js";
    newStart = `node --import ./${PRELOAD} ${main}`;
  } else {
    warnings.push(`start script is "${start}" — not a plain "node …" command; add --import ./${PRELOAD} to however the agent is started`);
  }
  if (newStart !== start) {
    fresh.scripts.start = newStart;
    writeFileSync(pkgPath, JSON.stringify(fresh, null, 2) + "\n");
    steps.push(`start script → ${newStart}`);
  }
  return { steps, warnings, startScript: newStart };
}
