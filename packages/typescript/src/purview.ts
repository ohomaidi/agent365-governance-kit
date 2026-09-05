import { PurviewConfig, GuardState, purviewState, missingFields } from "./config.js";

/**
 * Microsoft Purview governance guard — the channel-agnostic core.
 *
 * Wraps the two Microsoft Graph "Purview SDK" calls:
 *   1. protectionScopes/compute  — which policies apply to this user+activity.
 *   2. processContent            — submit the prompt/response for evaluation;
 *                                  returns policy actions (e.g. block) and
 *                                  captures the interaction for DSPM/audit.
 *
 * Drop into ANY agent: call guard.evaluate() on the inbound prompt before you
 * call the model, and on the model's reply before you return it. No Microsoft
 * channel required — this is what governs a non-Microsoft surface.
 *
 * Reliability contract:
 *   - Every HTTP call is bounded by config.timeoutMs (no unbounded hangs).
 *   - 429 / 5xx / network errors are retried with backoff, honouring Retry-After.
 *   - When the guard cannot reach Purview it honours config.failClosed
 *     (default TRUE — block). It never silently allows.
 */

export type Activity = "uploadText" | "downloadText" | "uploadFile" | "downloadFile";

/** Why an evaluation did not reach Purview. */
export type DegradedReason = "disabled" | "misconfigured" | "error";

export interface EvalResult {
  blocked: boolean;
  reason?: string;
  /** True if Purview was actually reached and returned a verdict. */
  evaluated: boolean;
  /**
   * Set whenever `evaluated` is false. Lets a caller distinguish a deliberate
   * opt-out ("disabled") from a broken deployment ("misconfigured"/"error").
   */
  degraded?: DegradedReason;
}

export interface EvaluateOptions {
  /** Override the attributed user (Entra object id) for this call. */
  userId?: string;
  /** Thread id so Purview groups the turns of one conversation. */
  correlationId?: string;
  /** Per-message sequence within the thread (0,1,2,…). */
  sequenceNumber?: number;
  /** Real client IP for this call. Omitted from the payload when absent. */
  ipAddress?: string;
  /** Caller-supplied cancellation, combined with the internal timeout. */
  signal?: AbortSignal;
}

export interface PurviewGuard {
  /** True only when fully configured AND enabled. */
  readonly ready: boolean;
  /** "ready" | "disabled" | "misconfigured" — see config.ts. */
  readonly state: GuardState;
  /** Env var names missing when state === "misconfigured". */
  readonly missing: string[];
  evaluate(text: string, activity: Activity, opts?: EvaluateOptions): Promise<EvalResult>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Strip anything secret-shaped out of text bound for a log. */
function redact(s: string, secret: string): string {
  let out = s;
  if (secret && secret.length > 4) out = out.split(secret).join("***REDACTED***");
  return out.replace(/("?(?:client_secret|access_token|refresh_token|id_token)"?\s*[:=]\s*"?)[^"&,\s}]+/gi, "$1***REDACTED***");
}

/** Retryable = throttling, transient server errors, and network/timeout faults. */
function retryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

function backoffMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const secs = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  }
  const base = Math.min(500 * 2 ** attempt, 8_000);
  return base + Math.floor(Math.random() * 250); // jitter
}

export function createPurviewGuard(config: PurviewConfig): PurviewGuard {
  const GRAPH = config.graphBaseUrl || "https://graph.microsoft.com/v1.0";
  const LOGIN = config.loginBaseUrl || "https://login.microsoftonline.com";
  const state = purviewState(config);
  const missing = missingFields(config);
  const ready = state === "ready";

  // Announce the guard's disposition once, at construction, so a misconfigured
  // deployment is obvious at startup rather than invisible at request time.
  if (state === "disabled") {
    console.warn("[purview] guard DISABLED (PURVIEW_ENABLED=false). No prompts or replies will be governed.");
  } else if (state === "misconfigured") {
    console.error(
      `[purview] guard MISCONFIGURED — missing ${missing.join(", ")}. ` +
        (config.failClosed
          ? "failClosed=true, so every evaluate() will BLOCK until this is fixed."
          : "failClosed=false, so every evaluate() will ALLOW ungoverned. Fix the config."),
    );
  }

  /**
   * One HTTP attempt with a hard timeout, plus bounded retries.
   * Returns the final Response; throws on exhausted retries or transport error.
   */
  async function request(url: string, init: RequestInit, label: string, callerSignal?: AbortSignal): Promise<Response> {
    let lastErr: unknown;
    // Per-call, not shared: concurrent turns must not overwrite each other's backoff.
    let lastRetryAfter: string | null = null;
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt - 1, lastRetryAfter));
      const timer = new AbortController();
      const t = setTimeout(() => timer.abort(new Error(`${label} timed out after ${config.timeoutMs}ms`)), config.timeoutMs);
      // Combine our timeout with any caller cancellation.
      const onAbort = () => timer.abort(callerSignal?.reason);
      callerSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(url, { ...init, signal: timer.signal });
        if (retryableStatus(res.status) && attempt < config.maxRetries) {
          lastRetryAfter = res.headers.get("retry-after");
          lastErr = new Error(`${label} ${res.status}`);
          continue;
        }
        return res;
      } catch (err) {
        // Caller cancelled: don't retry, propagate immediately.
        if (callerSignal?.aborted) throw err;
        lastErr = err;
        lastRetryAfter = null;
        if (attempt >= config.maxRetries) break;
      } finally {
        clearTimeout(t);
        callerSignal?.removeEventListener("abort", onAbort);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  // --- token cache (single-flight: concurrent turns share one refresh) ---
  let tokenValue = "";
  let tokenExpiresMs = 0;
  let inFlight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    const res = await request(
      `${LOGIN}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
      "token",
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`token ${res.status}: ${redact(text, config.clientSecret)}`);
    const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("token response contained no access_token");
    tokenValue = json.access_token;
    tokenExpiresMs = Date.now() + (json.expires_in ?? 3600) * 1000;
    return tokenValue;
  }

  async function getToken(): Promise<string> {
    if (tokenValue && Date.now() < tokenExpiresMs - 60_000) return tokenValue;
    if (!inFlight) {
      inFlight = fetchToken().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  // --- protection-scope cache (per user) ---
  // NOTE: we cache the *absence* of an ETag too. Previously a missing ETag made
  // ensureScopes() recompute on every single evaluate() call.
  const SCOPE_TTL_MS = 55 * 60 * 1000;
  const scopeCache = new Map<string, { etag: string; at: number }>();

  /** Scope the compute call to the activities we actually submit. */
  const SCOPE_ACTIVITIES = "uploadText,downloadText,uploadFile,downloadFile";

  async function computeScopes(token: string, userId: string, signal?: AbortSignal): Promise<void> {
    const res = await request(
      `${GRAPH}/users/${encodeURIComponent(userId)}/dataSecurityAndGovernance/protectionScopes/compute`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          activities: SCOPE_ACTIVITIES,
          locations: [
            { "@odata.type": "microsoft.graph.policyLocationApplication", value: config.appLocation },
          ],
        }),
      },
      "computeScopes",
      signal,
    );
    if (!res.ok) throw new Error(`computeScopes ${res.status}: ${redact(await res.text(), config.clientSecret)}`);
    scopeCache.set(userId, { etag: res.headers.get("etag") ?? "", at: Date.now() });
  }

  async function ensureScopes(token: string, userId: string, signal?: AbortSignal): Promise<string> {
    const cached = scopeCache.get(userId);
    if (!cached || Date.now() - cached.at > SCOPE_TTL_MS) {
      await computeScopes(token, userId, signal);
    }
    return scopeCache.get(userId)?.etag ?? "";
  }

  async function evaluate(text: string, activity: Activity, opts: EvaluateOptions = {}): Promise<EvalResult> {
    if (state === "disabled") {
      return { blocked: false, evaluated: false, degraded: "disabled" };
    }
    if (state === "misconfigured") {
      return {
        blocked: config.failClosed,
        evaluated: false,
        degraded: "misconfigured",
        reason: config.failClosed
          ? `Governance unavailable: Purview guard is misconfigured (missing ${missing.join(", ")}).`
          : undefined,
      };
    }

    const userId = opts.userId ?? config.defaultUserId;
    const correlationId = opts.correlationId ?? "default";
    const sequenceNumber = opts.sequenceNumber ?? 0;
    try {
      const token = await getToken();
      const etag = await ensureScopes(token, userId, opts.signal);
      // Full RFC3339 UTC instant. The previous format dropped the "Z", leaving
      // the timestamp without a timezone designator.
      const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

      // Only send an IP when we actually know one — a hardcoded 127.0.0.1 makes
      // every audit record look like it came from localhost.
      const ip = opts.ipAddress ?? config.deviceIp;
      const deviceMetadata: Record<string, string> = { deviceType: config.deviceType };
      if (ip) deviceMetadata.ipAddress = ip;

      const res = await request(
        `${GRAPH}/users/${encodeURIComponent(userId)}/dataSecurityAndGovernance/processContent`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(etag ? { "If-None-Match": etag } : {}),
          },
          body: JSON.stringify({
            contentToProcess: {
              contentEntries: [
                {
                  "@odata.type": "microsoft.graph.processConversationMetadata",
                  identifier: `${correlationId}-${sequenceNumber}`,
                  content: { "@odata.type": "microsoft.graph.textContent", data: text },
                  name: `${config.appName} message`,
                  correlationId,
                  sequenceNumber,
                  isTruncated: false,
                  createdDateTime: nowIso,
                  modifiedDateTime: nowIso,
                },
              ],
              activityMetadata: { activity },
              deviceMetadata,
              protectedAppMetadata: {
                name: config.appName,
                version: "1.0",
                applicationLocation: {
                  "@odata.type": "microsoft.graph.policyLocationApplication",
                  value: config.appLocation,
                },
              },
              integratedAppMetadata: { name: config.appName, version: "1.0" },
            },
          }),
        },
        "processContent",
        opts.signal,
      );
      const raw = await res.text();
      if (!res.ok) throw new Error(`processContent ${res.status}: ${redact(raw, config.clientSecret)}`);
      const json = (raw ? JSON.parse(raw) : {}) as {
        protectionScopeState?: string;
        policyActions?: Array<{ action?: string; restrictionAction?: string }>;
      };

      // Policy changed in the tenant → drop the cached scope so we recompute.
      if (json.protectionScopeState === "modified") scopeCache.delete(userId);

      const actions = json.policyActions ?? [];
      const eq = (a: string | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();
      const block = actions.find((a) => eq(a.action, "restrictAccess") && eq(a.restrictionAction, "block"));
      if (block) {
        return { blocked: true, evaluated: true, reason: "Blocked by a Microsoft Purview data-loss-prevention policy." };
      }
      // Surface restriction actions we don't recognise instead of silently allowing.
      for (const a of actions) {
        if (eq(a.action, "restrictAccess") && !eq(a.restrictionAction, "block")) {
          console.warn(`[purview] unhandled restrictionAction "${a.restrictionAction}" — allowing. Review policy mapping.`);
        }
      }
      return { blocked: false, evaluated: true };
    } catch (err) {
      const detail = redact(err instanceof Error ? err.message : String(err), config.clientSecret);
      console.error(`[purview] evaluate(${activity}) failed:`, detail);
      return {
        blocked: config.failClosed,
        evaluated: false,
        degraded: "error",
        reason: config.failClosed ? "Governance check unavailable." : undefined,
      };
    }
  }

  return { ready, state, missing, evaluate };
}
