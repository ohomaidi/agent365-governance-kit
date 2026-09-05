/**
 * Configuration for the Agent 365 Governance Kit.
 *
 * Everything the runtime needs is here. The `init` wizard writes these values
 * into the host app's `.env`; loadConfig() reads them back. Nothing is
 * hard-coded — the same code runs in any tenant.
 *
 * SAFE DEFAULTS (v0.2): the guard is ENABLED and FAIL-CLOSED unless you say
 * otherwise. Forgetting to set an env var can no longer silently disable
 * governance — it produces a loud, blocking misconfiguration instead.
 */

export interface PurviewConfig {
  /**
   * Whether the Purview guard is active. Defaults to TRUE — set
   * `PURVIEW_ENABLED=false` to deliberately opt out (e.g. local dev).
   */
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
   * account. For a multi-user app, pass the real signed-in user per call —
   * see `EvaluateOptions.userId`. Attributing every user's traffic to one
   * object id makes the DSPM/audit trail misleading.
   */
  defaultUserId: string;
  /** Friendly app name surfaced in Purview audit/DSPM. */
  appName: string;
  /**
   * Fail-closed (block when Purview is unreachable) vs fail-open (allow).
   * Defaults to TRUE. Set `PURVIEW_FAIL_CLOSED=false` only if availability
   * genuinely outranks governance for your deployment.
   */
  failClosed: boolean;
  /** Per-HTTP-request timeout in ms. Default 10000. */
  timeoutMs: number;
  /** Retries for throttling (429) and transient 5xx. Default 3. */
  maxRetries: number;
  /**
   * Device type reported to Purview. Default "Unmanaged". A server-side agent
   * is not really a device; this is metadata only.
   */
  deviceType: string;
  /**
   * Client IP reported to Purview. Empty by default — the field is OMITTED
   * rather than sent as a fake value, so audit records don't all read
   * 127.0.0.1. Pass the real caller IP per call via `EvaluateOptions.ipAddress`.
   */
  deviceIp: string;
  /** Graph base URL. Override only for testing against a mock. */
  graphBaseUrl: string;
  /** Entra login base URL. Override only for testing against a mock. */
  loginBaseUrl: string;
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

/**
 * Guard lifecycle state.
 * - "ready"        — fully configured, evaluating live.
 * - "disabled"     — deliberately switched off (PURVIEW_ENABLED=false).
 * - "misconfigured"— enabled but missing required values. Treated as a failure,
 *                    NOT as "off": evaluate() honours failClosed.
 */
export type GuardState = "ready" | "disabled" | "misconfigured";

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return dflt;
}

function int(v: string | undefined, dflt: number, min: number, max: number): number {
  if (v === undefined || v.trim() === "") return dflt;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** Load config from process.env (populated from the host app's .env). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GovernanceConfig {
  const purview: PurviewConfig = {
    // Default ON. Silence-is-governance is the failure mode we're designing out.
    enabled: bool(env.PURVIEW_ENABLED, true),
    tenantId: env.PURVIEW_TENANT_ID ?? "",
    clientId: env.PURVIEW_CLIENT_ID ?? "",
    clientSecret: env.PURVIEW_CLIENT_SECRET ?? "",
    appLocation: env.PURVIEW_APP_LOCATION ?? env.PURVIEW_CLIENT_ID ?? "",
    defaultUserId: env.PURVIEW_USER_ID ?? "",
    appName: env.PURVIEW_APP_NAME ?? "Custom AI App",
    // Default CLOSED. An unreachable governance plane must not mean "allow".
    failClosed: bool(env.PURVIEW_FAIL_CLOSED, true),
    timeoutMs: int(env.PURVIEW_TIMEOUT_MS, 10_000, 1_000, 120_000),
    maxRetries: int(env.PURVIEW_MAX_RETRIES, 3, 0, 10),
    deviceType: env.PURVIEW_DEVICE_TYPE ?? "Unmanaged",
    deviceIp: env.PURVIEW_DEVICE_IP ?? "",
    graphBaseUrl: env.PURVIEW_GRAPH_BASE_URL ?? "https://graph.microsoft.com/v1.0",
    loginBaseUrl: env.PURVIEW_LOGIN_BASE_URL ?? "https://login.microsoftonline.com",
  };
  const observability: ObservabilityConfig = {
    enabled: bool(env.ENABLE_A365_OBSERVABILITY_EXPORTER, true),
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

/** The required fields for live calls, in the order we report them. */
const REQUIRED: Array<[keyof PurviewConfig, string]> = [
  ["tenantId", "PURVIEW_TENANT_ID"],
  ["clientId", "PURVIEW_CLIENT_ID"],
  ["clientSecret", "PURVIEW_CLIENT_SECRET"],
  ["appLocation", "PURVIEW_APP_LOCATION"],
  ["defaultUserId", "PURVIEW_USER_ID"],
];

/** Env var names that are set but empty/missing. Empty array = complete. */
export function missingFields(c: PurviewConfig): string[] {
  return REQUIRED.filter(([k]) => !String(c[k] ?? "").trim()).map(([, envName]) => envName);
}

/** True if the Purview config has every field needed to make live calls. */
export function purviewReady(c: PurviewConfig): boolean {
  return c.enabled && missingFields(c).length === 0;
}

/** Classify the guard so callers can tell "off" apart from "broken". */
export function purviewState(c: PurviewConfig): GuardState {
  if (!c.enabled) return "disabled";
  return missingFields(c).length === 0 ? "ready" : "misconfigured";
}
