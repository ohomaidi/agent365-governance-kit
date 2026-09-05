/**
 * @zaatarlabs/agent365-governance-kit
 *
 * Drop-in Microsoft governance for any custom AI agent:
 *   - Purview guard  — DLP/audit/DSPM on any channel (createPurviewGuard).
 *   - Agent 365      — agentic identity + Activity-tab observability.
 *
 * Quick start (see README):
 *   import { loadConfig, createPurviewGuard } from "@zaatarlabs/agent365-governance-kit";
 *   const cfg = loadConfig();
 *   const guard = createPurviewGuard(cfg.purview);
 *   const verdict = await guard.evaluate(userPrompt, "uploadText", { correlationId });
 *   if (verdict.blocked) return verdict.reason;   // don't call the model
 */
export { loadConfig, purviewReady, purviewState, missingFields } from "./config.js";
export type { GovernanceConfig, PurviewConfig, ObservabilityConfig, GuardState } from "./config.js";

export { createPurviewGuard } from "./purview.js";
export type { PurviewGuard, EvalResult, EvaluateOptions, Activity, DegradedReason } from "./purview.js";

export { initObservability } from "./observability.js";
export {
  agenticAuthorization,
  refreshTurnObservability,
  withAgentScope,
  turnAgentId,
} from "./agentic.js";
export type { AgentDetails } from "./agentic.js";
