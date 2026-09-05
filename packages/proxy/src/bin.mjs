#!/usr/bin/env node
/**
 * agent365-govern-proxy — run the governance proxy in front of an agent.
 *
 *   agent365-govern-proxy --upstream https://vendor.example.com --port 8787
 *
 * Reads the same PURVIEW_* environment the rest of the kit uses, so the guard
 * is configured by the wizard exactly as it would be inside your own agent.
 */
import "dotenv/config";
import { loadConfig, createPurviewGuard } from "@zaatarlabs/agent365-governance-kit";
import { createGovernanceProxy } from "./server.mjs";
import { createTeamsBridge } from "./teams.mjs";

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes(`--${name}`);

if (has("help") || has("h")) {
  console.log(`
agent365-govern-proxy — Microsoft Purview governance for an agent you can't modify

  --upstream <url>     REQUIRED. The agent to front.
  --port <n>           Listen port (default 8787).
  --host <addr>        Bind address (default 0.0.0.0).
  --dialect <name>     a2a | openai | generic | auto   (default auto)
  --request-paths <a,b>   Custom dot-paths to the prompt text.
  --response-paths <a,b>  Custom dot-paths to the reply text.
  --streaming <mode>   buffer (default, governed) | passthrough (NOT governed)
  --max-body <bytes>   Request body cap (default 5242880).
  --teams <on|off>     Teams bridge on /api/messages (default: on when the wizard
                       wrote agent_id + connections__service_connection__* to .env).
  --upstream-path <p>  Path the Teams bridge posts a turn to (default per dialect:
                       a2a "/", openai "/v1/chat/completions", generic "/").
  --upstream-model <m> Model name to send with the openai dialect.

Register this proxy's public URL as the agent's endpoint in Agent 365 and the
registry points at a governed endpoint; with the Teams bridge on, Teams
messages reach the vendor agent through the same Purview checks.
`);
  process.exit(0);
}

const upstream = arg("upstream", process.env.GOVERNANCE_UPSTREAM);
if (!upstream) {
  console.error("✗ --upstream is required (or set GOVERNANCE_UPSTREAM).");
  process.exit(1);
}

const guard = createPurviewGuard(loadConfig().purview);
const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

const port = Number(arg("port", process.env.GOVERNANCE_PROXY_PORT ?? 8787));
const host = arg("host", "0.0.0.0");

const teamsWanted = arg("teams", process.env.agent_id || process.env.connections__service_connection__settings__clientId ? "on" : "off") !== "off";
let teams = null;
if (teamsWanted) {
  const bridge = await createTeamsBridge({
    upstream, guard, port,
    dialect: arg("dialect", process.env.GOVERNANCE_DIALECT || "auto"),
    upstreamPath: arg("upstream-path", process.env.GOVERNANCE_UPSTREAM_PATH), upstreamModel: arg("upstream-model", process.env.GOVERNANCE_UPSTREAM_MODEL),
  });
  teams = bridge.handler;
  console.log(`[proxy] Teams bridge on /api/messages (${bridge.anonymous ? "ANONYMOUS — no agent_id configured; fine for the Playground, not for Teams" : `app ${bridge.appId}`}; observability ${bridge.observability ? "on" : "off"})`);
}

const { listen, stats } = createGovernanceProxy({
  upstream,
  guard,
  teams,
  dialect: arg("dialect", process.env.GOVERNANCE_DIALECT || "auto"),
  requestPaths: list(arg("request-paths")),
  responsePaths: list(arg("response-paths")),
  streaming: arg("streaming", "buffer"),
  maxBodyBytes: Number(arg("max-body", 5 * 1024 * 1024)),
});

await listen(port, host);

console.log(`[proxy] listening on http://${host}:${port}`);
console.log(`[proxy] fronting ${upstream}`);
if (guard.state === "ready") {
  console.log("[proxy] Purview guard ACTIVE — prompts and replies are evaluated.");
} else if (guard.state === "disabled") {
  console.warn("[proxy] Purview guard OFF (PURVIEW_ENABLED=false). Traffic is NOT governed.");
} else {
  console.error(`[proxy] Purview guard MISCONFIGURED — missing ${guard.missing.join(", ")}.`);
}
console.log(`[proxy] health: http://${host}:${port}/_governance/health`);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n[proxy] ${JSON.stringify(stats)}`);
    process.exit(0);
  });
}
