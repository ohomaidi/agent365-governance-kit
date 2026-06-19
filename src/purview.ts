import { PurviewConfig, purviewReady } from "./config.js";

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
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

export type Activity = "uploadText" | "downloadText" | "uploadFile" | "downloadFile";

export interface EvalResult {
  blocked: boolean;
  reason?: string;
  /** True if Purview was actually reached (false = disabled or transport error). */
  evaluated: boolean;
}

export interface EvaluateOptions {
  /** Override the attributed user (Entra object id) for this call. */
  userId?: string;
  /** Thread id so Purview groups the turns of one conversation. */
  correlationId?: string;
  /** Per-message sequence within the thread (0,1,2,…). */
  sequenceNumber?: number;
}

export interface PurviewGuard {
  readonly ready: boolean;
  evaluate(text: string, activity: Activity, opts?: EvaluateOptions): Promise<EvalResult>;
}

export function createPurviewGuard(config: PurviewConfig): PurviewGuard {
  const ready = purviewReady(config);

  // --- token cache ---
  let tokenValue = "";
  let tokenExpiresMs = 0;
  async function getToken(): Promise<string> {
    const now = Date.now();
    if (tokenValue && now < tokenExpiresMs - 60_000) return tokenValue;
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    const res = await fetch(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    tokenValue = json.access_token;
    tokenExpiresMs = now + json.expires_in * 1000;
    return tokenValue;
  }

  // --- protection-scope cache (per user) ---
  const SCOPE_TTL_MS = 55 * 60 * 1000;
  const scopeCache = new Map<string, { etag: string; at: number }>();

  async function computeScopes(token: string, userId: string): Promise<void> {
    const res = await fetch(
      `${GRAPH}/users/${userId}/dataSecurityAndGovernance/protectionScopes/compute`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          activities: "uploadText,downloadText",
          locations: [
            { "@odata.type": "microsoft.graph.policyLocationApplication", value: config.appLocation },
          ],
        }),
      },
    );
    if (!res.ok) throw new Error(`computeScopes ${res.status}: ${await res.text()}`);
    scopeCache.set(userId, { etag: res.headers.get("etag") ?? "", at: Date.now() });
  }

  async function ensureScopes(token: string, userId: string): Promise<string> {
    const cached = scopeCache.get(userId);
    if (!cached || !cached.etag || Date.now() - cached.at > SCOPE_TTL_MS) {
      await computeScopes(token, userId);
    }
    return scopeCache.get(userId)?.etag ?? "";
  }

  async function evaluate(text: string, activity: Activity, opts: EvaluateOptions = {}): Promise<EvalResult> {
    if (!ready) return { blocked: false, evaluated: false };
    const userId = opts.userId ?? config.defaultUserId;
    const correlationId = opts.correlationId ?? "default";
    const sequenceNumber = opts.sequenceNumber ?? 0;
    try {
      const token = await getToken();
      const etag = await ensureScopes(token, userId);
      const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "");

      const res = await fetch(`${GRAPH}/users/${userId}/dataSecurityAndGovernance/processContent`, {
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
            deviceMetadata: { deviceType: "Unmanaged", ipAddress: "127.0.0.1" },
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
      });
      if (!res.ok) throw new Error(`processContent ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as {
        protectionScopeState?: string;
        policyActions?: Array<{ action?: string; restrictionAction?: string }>;
      };

      // Policy changed in the tenant → drop the cached scope so we recompute.
      if (json.protectionScopeState === "modified") scopeCache.delete(userId);

      const block = (json.policyActions ?? []).find(
        (a) => a.action === "restrictAccess" && a.restrictionAction === "block",
      );
      if (block) {
        return { blocked: true, evaluated: true, reason: "Blocked by a Microsoft Purview data-loss-prevention policy." };
      }
      return { blocked: false, evaluated: true };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[purview] evaluate(${activity}) failed:`, detail);
      return {
        blocked: config.failClosed,
        evaluated: false,
        reason: config.failClosed ? "Governance check unavailable." : undefined,
      };
    }
  }

  return { ready, evaluate };
}
