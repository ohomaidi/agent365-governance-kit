/**
 * Agent 365 agentic-identity helpers.
 *
 * These wrap the per-turn observability + tracing the Agent 365 SDK needs, so a
 * host agent only has to make three calls. The Microsoft SDKs are PEER deps,
 * loaded dynamically.
 *
 * In the host AgentApplication:
 *   1. constructor — spread agenticAuthorization(scopes) into `authorization`.
 *   2. turn handler — `await refreshTurnObservability(context, this.authorization)`.
 *   3. wrap the model call in `await withAgentScope(context, details, fn)`.
 */

export interface AgentDetails {
  agentId: string;
  agentName: string;
  agentDescription?: string;
  tenantId: string;
}

/**
 * The `authorization` block to spread into an AgentApplication constructor.
 * `scopes` defaults to Microsoft Graph; override for other resources.
 */
export function agenticAuthorization(
  scopes: string[] = ["https://graph.microsoft.com/.default"],
  altBlueprintConnectionName = "service_connection",
) {
  return {
    agentic: {
      type: "AgenticUserAuthorization",
      scopes,
      altBlueprintConnectionName,
    },
  };
}

/** Read the live instance id off a turn (falls back to the configured id). */
export function turnAgentId(context: any, fallback: AgentDetails): { agentId: string; tenantId: string } {
  const act = context?.activity ?? {};
  return {
    agentId: act.getAgenticInstanceId?.() ?? fallback.agentId,
    tenantId: act.getAgenticTenantId?.() ?? fallback.tenantId,
  };
}

/**
 * Mint and cache the observability OBO token for this turn, keyed to the LIVE
 * instance id (NOT the blueprint id — the obs endpoint authorizes by instance).
 * Safe to call every turn; no-ops if the SDK isn't installed.
 */
export async function refreshTurnObservability(
  context: any,
  authorization: unknown,
  fallback: AgentDetails,
): Promise<void> {
  let otel: any;
  try {
    otel = await import("@microsoft/opentelemetry");
  } catch {
    return;
  }
  const { agentId, tenantId } = turnAgentId(context, fallback);
  try {
    await otel.AgenticTokenCacheInstance.refreshObservabilityToken(agentId, tenantId, context, authorization);
  } catch (e) {
    console.error("[obs] refreshObservabilityToken failed:", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Run `fn` inside an Agent 365 trace scope (baggage + InvokeAgentScope) so the
 * turn shows up in the Activity tab. Returns whatever `fn` returns.
 */
export async function withAgentScope<T>(
  context: any,
  details: AgentDetails,
  endpoint: { host: string; port: number },
  fn: () => Promise<T>,
): Promise<T> {
  let otel: any;
  try {
    otel = await import("@microsoft/opentelemetry");
  } catch {
    return fn();
  }
  const { agentId, tenantId } = turnAgentId(context, details);
  const conversationId = context?.activity?.conversation?.id ?? "";
  const { BaggageBuilder, InvokeAgentScope } = otel;

  const baggage = new BaggageBuilder().tenantId(tenantId).agentId(agentId).conversationId(conversationId).build();
  return baggage.run(async () => {
    const request = { conversationId };
    const agentDetails = { agentId, agentName: details.agentName, tenantId };
    const scope = InvokeAgentScope.start(request, { endpoint }, agentDetails);
    try {
      return await fn();
    } finally {
      scope?.end?.();
    }
  });
}
