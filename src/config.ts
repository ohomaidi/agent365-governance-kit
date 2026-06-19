/**
 * Configuration for the Agent 365 Governance Kit.
 *
 * Everything the runtime needs is here. The `init` wizard writes these values
 * into the host app's `.env`; loadConfig() reads them back. Nothing is
 * hard-coded — the same code runs in any tenant.
 */

export interface PurviewConfig {
  /** Whether the Purview guard is active. */
  enabled: boolean;
  /** Entra tenant id. */
  tenantId: string;
  /** App registration (client) id used for the app-only Graph calls. */
  clientId: string;
  /** Client secret for that app registration. */
  clientSecret: string;
  /**
   * The Entra app id registered as the Purview "application location"
   * (the managed cloud app the DLP policy is scoped to). Usually the same
   * value as clientId.
   */
  appLocation: string;
  /**
   * Entra object id of the user every interaction is attributed to. Purview
   * governs per-user; for a single-tenant service this is one service/owner
   * account. For a multi-user app, pass the real signed-in user per call.
   */
  defaultUserId: string;
  /** Friendly app name surfaced in Purview audit/DSPM. */
  appName: string;
  /** Fail-open (allow on transport error) vs fail-closed (block). */
  failClosed: boolean;
}

export interface ObservabilityConfig {
  /** Whether the Agent 365 observability exporter is active. */
  enabled: boolean;
  tenantId: string;
  /** Observability app/client id (the agent blueprint app). */
  clientId: string;
  clientSecret: string;
  /** Agent blueprint id. */
  agentBlueprintId: string;
  agentName: string;
  agentDescription: string;
  /** Log level for the exporter: pipe-delimited subset of info|warn|error. */
  logLevel: string;
}

export interface GovernanceConfig {
  purview: PurviewConfig;
  observability: ObservabilityConfig;
}

function bool(v: string | undefined, dflt = false): boolean {
  if (v === undefined) return dflt;
  return v.toLowerCase() === "true" || v === "1";
}

/** Load config from process.env (populated from the host app's .env). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GovernanceConfig {
  const purview: PurviewConfig = {
    enabled: bool(env.PURVIEW_ENABLED),
    tenantId: env.PURVIEW_TENANT_ID ?? "",
    clientId: env.PURVIEW_CLIENT_ID ?? "",
    clientSecret: env.PURVIEW_CLIENT_SECRET ?? "",
    appLocation: env.PURVIEW_APP_LOCATION ?? env.PURVIEW_CLIENT_ID ?? "",
    defaultUserId: env.PURVIEW_USER_ID ?? "",
    appName: env.PURVIEW_APP_NAME ?? "Custom AI App",
    failClosed: bool(env.PURVIEW_FAIL_CLOSED),
  };
  const observability: ObservabilityConfig = {
    enabled: env.ENABLE_A365_OBSERVABILITY_EXPORTER !== "false",
    tenantId: env.agent365Observability__tenantId ?? env.PURVIEW_TENANT_ID ?? "",
    clientId: env.agent365Observability__clientId ?? "",
    clientSecret: env.agent365Observability__clientSecret ?? "",
    agentBlueprintId: env.agent365Observability__agentBlueprintId ?? "",
    agentName: env.agent365Observability__agentName ?? "Agent",
    agentDescription: env.agent365Observability__agentDescription ?? "",
    logLevel: env.A365_OBSERVABILITY_LOG_LEVEL ?? "info|warn|error",
  };
  return { purview, observability };
}

/** True if the Purview config has every field needed to make live calls. */
export function purviewReady(c: PurviewConfig): boolean {
  return (
    c.enabled &&
    Boolean(c.tenantId && c.clientId && c.clientSecret && c.appLocation && c.defaultUserId)
  );
}
