import { ObservabilityConfig } from "./config.js";

/**
 * Agent 365 observability — initializes the Microsoft OpenTelemetry distro with
 * the a365 exporter so authenticated turns light up the admin-center Activity
 * tab.
 *
 * The @microsoft/opentelemetry package is a PEER dependency and loaded
 * dynamically: a Purview-only consumer never pays for it.
 *
 * Note: the exporter only succeeds for AUTHENTICATED Teams/Copilot turns — the
 * OBO token is minted per-turn (see agentic.ts refreshTurnObservability).
 */
export async function initObservability(config: ObservabilityConfig): Promise<void> {
  if (!config.enabled) {
    console.log("[observability] a365 exporter disabled.");
    return;
  }
  let otel: any;
  try {
    otel = await import("@microsoft/opentelemetry");
  } catch {
    console.warn("[observability] @microsoft/opentelemetry not installed — skipping. Install it to enable the Activity tab.");
    return;
  }
  const { useMicrosoftOpenTelemetry, AgenticTokenCacheInstance } = otel;
  useMicrosoftOpenTelemetry({
    a365: {
      enabled: true,
      tokenResolver: (agentId: string, tenantId: string) =>
        AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId) ?? "",
    },
  });
  console.log("[observability] Microsoft OpenTelemetry initialized (a365 exporter ENABLED).");
}
