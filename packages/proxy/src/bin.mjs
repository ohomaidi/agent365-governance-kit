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

Register this proxy's public URL as the agentInstance url in Agent 365 and the
registry points at a governed endpoint.
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

const { listen, stats } = createGovernanceProxy({
  upstream,
  guard,
  dialect: arg("dialect", "auto"),
  requestPaths: list(arg("request-paths")),
  responsePaths: list(arg("response-paths")),
  streaming: arg("streaming", "buffer"),
  maxBodyBytes: Number(arg("max-body", 5 * 1024 * 1024)),
});

const port = Number(arg("port", process.env.GOVERNANCE_PROXY_PORT ?? 8787));
const host = arg("host", "0.0.0.0");
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
