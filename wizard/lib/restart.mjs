/**
 * Restarting the customer's agent after its .env changed — when we can tell
 * how it is run.
 *
 * Detection, in order:
 *   pm2      — a pm2 process whose cwd is the agent folder      → pm2 restart <name>
 *   launchd  — a ~/Library/LaunchAgents plist mentioning the folder → launchctl kickstart -k
 *   systemd  — a user/system unit mentioning the folder (Linux)     → systemctl restart
 *   process  — a running node process whose cwd is the folder       → stop it, relaunch
 *              the same command in the same folder (stdout to logs/agent.log if present)
 *
 * Anything else (Docker, App Service, Windows service, a dev terminal) is
 * reported as "restart it yourself", with the reason. Never guesses a command.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const IS_WINDOWS = process.platform === "win32";
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000, ...opts });
const has = (cmd) => { try { sh(IS_WINDOWS ? "where" : "which", [cmd]); return true; } catch { return false; } };
const same = (a, b) => a && b && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** @returns {{kind:string, detail:string, restart?:()=>Promise<string>}} */
export function detectRunner(agentDir, deps = {}) {
  const run = deps.sh ?? sh, hasCmd = deps.has ?? has, home = deps.home ?? homedir();

  // pm2
  if (hasCmd("pm2")) {
    try {
      const list = JSON.parse(run("pm2", ["jlist"]));
      const p = list.find((x) => same(x.pm2_env?.pm_cwd, agentDir));
      if (p) return { kind: "pm2", detail: `pm2 process "${p.name}"`, restart: async () => { run("pm2", ["restart", String(p.name)]); return `pm2 restart ${p.name}`; } };
    } catch { /* not under pm2 */ }
  }
  // launchd (macOS)
  if (process.platform === "darwin") {
    const dir = join(home, "Library", "LaunchAgents");
    try {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".plist"))) {
        const body = readFileSync(join(dir, f), "utf8");
        if (!body.includes(agentDir)) continue;
        const label = (body.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/) ?? [])[1] ?? f.replace(/\.plist$/, "");
        return { kind: "launchd", detail: `launchd job ${label}`, restart: async () => { run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${label}`]); return `launchctl kickstart -k ${label}`; } };
      }
    } catch { /* no LaunchAgents */ }
  }
  // systemd (Linux)
  if (process.platform === "linux" && hasCmd("systemctl")) {
    for (const scope of ["--user", "--system"]) {
      try {
        const units = run("systemctl", [scope, "list-units", "--type=service", "--all", "--no-legend", "--plain"]).split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
        for (const u of units) {
          const show = run("systemctl", [scope, "show", u, "-p", "WorkingDirectory", "-p", "ExecStart"]);
          if (show.includes(agentDir)) return { kind: "systemd", detail: `${scope.replace("--", "")} unit ${u}`, restart: async () => { run("systemctl", [scope, "restart", u]); return `systemctl ${scope} restart ${u}`; } };
        }
      } catch { /* not systemd-managed */ }
    }
  }
  // a bare node process started in that folder
  const procs = deps.processes ?? listNodeProcesses(agentDir);
  if (procs.length) {
    // Every node process started in that folder reads the same .env (an agent
    // and its web portal, say), so all of them are relaunched, each with its
    // own command line.
    return {
      kind: "process",
      detail: procs.map((p) => `process ${p.pid} (${p.args.join(" ")})`).join(", "),
      restart: async () => {
        const done = [];
        for (const p of procs) {
          try { process.kill(p.pid, "SIGTERM"); } catch { /* already gone */ }
        }
        await new Promise((r) => setTimeout(r, 1500));
        for (const p of procs) {
          try { process.kill(p.pid, 0); process.kill(p.pid, "SIGKILL"); } catch { /* exited */ }
          const logPath = existsSync(join(agentDir, "logs")) ? join(agentDir, "logs", "agent.log") : "";
          const out = logPath ? openSync(logPath, "a") : "ignore";
          const child = spawn(p.args[0], p.args.slice(1), { cwd: agentDir, detached: true, stdio: ["ignore", out, out], env: process.env });
          child.unref();
          done.push(`"${p.args.join(" ")}" → pid ${child.pid}`);
        }
        return `relaunched in ${agentDir}: ${done.join("; ")}`;
      },
    };
  }
  return { kind: "", detail: "no pm2 process, launchd job, systemd unit or running node process found for this folder" };
}

/** Node processes whose working directory is the agent folder. macOS/Linux only. */
export function listNodeProcesses(agentDir) {
  if (IS_WINDOWS) return [];
  const out = [];
  try {
    const lines = sh("ps", ["-axo", "pid=,args="]).split("\n");
    for (const line of lines) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m || !/(^|\/)node(\s|$)/.test(m[2]) || /agent365-govern\.mjs|installer\/server\.mjs/.test(m[2])) continue;
      const pid = Number(m[1]);
      let cwd = "";
      try {
        cwd = process.platform === "linux"
          ? readFileSync(`/proc/${pid}/cwd`, "utf8")
          : (sh("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).match(/\nn(.+)/) ?? [])[1] ?? "";
      } catch { cwd = ""; }
      if (same(cwd, agentDir)) out.push({ pid, args: m[2].split(/\s+/) });
    }
  } catch { /* ps unavailable */ }
  return out;
}
