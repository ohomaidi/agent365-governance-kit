/**
 * Teams bridge — the half of Agent 365 a third-party agent cannot give you.
 *
 * The reverse proxy in server.mjs governs traffic that already flows to the
 * vendor's own API. It cannot, by itself, put that agent in Teams: Teams
 * speaks Bot Framework activities to a messaging endpoint that must
 * authenticate as the agent's blueprint identity, and the Agent 365 Activity
 * tab wants OpenTelemetry spans minted from each authenticated turn.
 *
 * This module is that endpoint. Mounted at /api/messages on the proxy it:
 *
 *   Teams --activity--> [ verify JWT (Microsoft 365 Agents SDK)
 *                         Purview: uploadText  -> refuse in-chat if blocked
 *                         upstream call in the vendor's dialect
 *                         Purview: downloadText -> refuse in-chat if blocked
 *                         reply as the agent; record the turn for Agent 365 ]
 *
 * The identity and endpoint values come from the .env the wizard writes
 * (agent_id, connections__service_connection__*, agent365Observability__*), so
 * a proxy-fronted vendor agent is wired exactly like an agent you own. With no
 * agent_id configured it runs in the SDK's anonymous mode, which is what the
 * Agents Playground and the test-suite use.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolveDialect } from "./dialects.mjs";

const require = createRequire(import.meta.url);

/** Same marker the kit's sample agent uses, so a block is obvious in a demo. */
export const BLOCK_PREFIX = "🛡️";

/**
 * Observability is optional at import time: the Microsoft OpenTelemetry distro
 * is a real dependency, but a proxy with no agent365Observability__* config
 * must still start. Loaded lazily so a missing/broken install degrades to
 * "no Activity tab", not "no Teams".
 */
async function loadObservability(log) {
  try {
    const otel = await import("@microsoft/opentelemetry");
    const { resourceFromAttributes } = await import("@opentelemetry/resources");
    return { ...otel, resourceFromAttributes };
  } catch (e) {
    log.warn?.(`[teams] observability packages unavailable (${e.message}) — turns will not appear in the Agent 365 Activity tab.`);
    return null;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.upstream        Base URL of the agent being fronted.
 * @param {object} opts.guard           PurviewGuard from the governance kit.
 * @param {string} [opts.dialect]       a2a | openai | generic (auto = generic for a bare text turn).
 * @param {string} [opts.upstreamPath]  Override the dialect's default path.
 * @param {string} [opts.upstreamModel] Model name for the openai dialect.
 * @param {string} [opts.agentName]
 * @param {string} [opts.agentDescription]
 * @param {number} [opts.port]          Reported in observability spans.
 * @param {object} [opts.log]
 * @returns {Promise<{handler: Function, anonymous: boolean, observability: boolean, appId: string}>}
 */
export async function createTeamsBridge(opts) {
  const {
    upstream, guard, dialect: dialectName = "generic", upstreamPath, upstreamModel,
    agentName = process.env.agent365Observability__agentName || "Agent",
    agentDescription = process.env.agent365Observability__agentDescription || "",
    port = 8787, log = console,
  } = opts;
  if (!upstream) throw new Error("teams bridge requires an upstream URL");
  if (!guard) throw new Error("teams bridge requires a Purview guard");

  const express = require("express");
  const hosting = require("@microsoft/agents-hosting");
  const { AgentApplication, MemoryStorage, CloudAdapter, authorizeJWT, getAuthConfigWithDefaults } = hosting;

  const upstreamBase = upstream.replace(/\/+$/, "");
  const d = resolveDialect(dialectName === "auto" ? "generic" : dialectName, null);
  const authConfig = getAuthConfigWithDefaults();
  const anonymous = !authConfig.clientId;

  // ---- observability (Agent 365 Activity tab) ----
  const details = {
    agentId: process.env.agent365Observability__agentId ?? "",
    agentName, agentDescription,
    agentBlueprintId: process.env.agent365Observability__agentBlueprintId ?? "",
    tenantId: process.env.agent365Observability__tenantId ?? "",
  };
  const wantObs = process.env.ENABLE_A365_OBSERVABILITY_EXPORTER !== "false" && Boolean(details.agentId) && !anonymous;
  const otel = wantObs ? await loadObservability(log) : null;
  if (otel) {
    otel.useMicrosoftOpenTelemetry({
      resource: otel.resourceFromAttributes({ "service.name": agentName, "service.version": "0.3.0" }),
      instrumentationOptions: { http: { enabled: false } },
      a365: {
        enabled: true,
        tokenResolver: (agentId, tenantId) => otel.AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId) ?? "",
      },
    });
    log.log?.("[teams] Agent 365 observability exporter ENABLED.");
  }

  // ---- the agent ----
  const app = new AgentApplication({
    storage: new MemoryStorage(),
    ...(anonymous ? {} : {
      // "agentic" is the handler id refreshObservabilityToken() looks up.
      authorization: {
        agentic: {
          type: "AgenticUserAuthorization",
          scopes: ["https://graph.microsoft.com/.default"],
          altBlueprintConnectionName: "service_connection",
        },
      },
    }),
  });

  app.onConversationUpdate("membersAdded", async (context) => {
    await context.sendActivity(`Hi, I'm ${agentName}. I'm registered in Microsoft Agent 365 and every message here is checked by Purview. Ask me something.`);
  });

  app.onActivity("message", async (context) => {
    const text = String(context.activity.text ?? "").trim();
    if (!text) { await context.sendActivity("I received an empty message — try sending some text."); return; }
    const conversationId = context.activity.conversation?.id ?? "";
    const senderObjectId = context.activity.from?.aadObjectId || undefined;
    const act = context.activity;
    const turnAgentId = act.getAgenticInstanceId?.() ?? details.agentId;
    const turnTenantId = act.getAgenticTenantId?.() ?? details.tenantId;

    // One turn of work, with or without a span around it.
    const turn = async (scope) => {
      const opts2 = { correlationId: conversationId || randomUUID(), userId: senderObjectId };
      const refuse = async (reason) => {
        const msg = `${BLOCK_PREFIX} ${reason ?? "Blocked by policy."}`;
        scope?.recordOutputMessages([msg]);
        await context.sendActivity(msg);
      };
      scope?.recordInputMessages([text]);
      const inbound = await guard.evaluate(text, "uploadText", { ...opts2, sequenceNumber: 0 });
      if (inbound.blocked) return refuse(inbound.reason);

      const reply = await callUpstream({ upstreamBase, d, upstreamPath, upstreamModel, text, conversationId });

      const outbound = await guard.evaluate(reply, "downloadText", { ...opts2, sequenceNumber: 1 });
      if (outbound.blocked) return refuse(outbound.reason);
      scope?.recordOutputMessages([reply]);
      await context.sendActivity(reply);
    };

    if (!otel) {
      try { await turn(null); }
      catch (err) { log.error?.(`[teams] turn failed: ${err.message}`); await context.sendActivity(`⚠️ ${agentName} could not answer: ${err.message}`); }
      return;
    }

    try {
      await otel.AgenticTokenCacheInstance.refreshObservabilityToken(turnAgentId, turnTenantId, context, app.authorization);
    } catch (e) { log.warn?.(`[teams] observability token refresh failed: ${e.message}`); }
    const baggage = new otel.BaggageBuilder().tenantId(turnTenantId).agentId(turnAgentId).conversationId(conversationId).build();
    await baggage.run(async () => {
      const scope = otel.InvokeAgentScope.start(
        { content: text, conversationId, channel: { name: context.activity.channelId ?? "msteams" } },
        { endpoint: { host: "proxy", port } },
        { ...details, agentId: turnAgentId, tenantId: turnTenantId, agentName: act.recipient?.name ?? agentName, agentAUID: act.recipient?.aadObjectId });
      try {
        await scope.withActiveSpanAsync(() => turn(scope));
      } catch (err) {
        scope.recordError(err);
        log.error?.(`[teams] turn failed: ${err.message}`);
        await context.sendActivity(`⚠️ ${agentName} could not answer: ${err.message}`);
      } finally { scope.dispose(); }
    });
  });

  const adapter = app.adapter ?? new CloudAdapter();
  const ex = express();
  ex.use(express.json({ limit: "2mb" }));
  ex.use(authorizeJWT(authConfig));
  ex.post("/api/messages", (req, res) => adapter.process(req, res, (context) => app.run(context), app.options?.headerPropagation));

  return { handler: ex, anonymous, observability: Boolean(otel), appId: authConfig.clientId ?? "" };
}

/** One text turn against the fronted agent, in its own wire format. */
export async function callUpstream({ upstreamBase, d, upstreamPath, upstreamModel, text, conversationId, fetchImpl = fetch }) {
  const { path, body } = d.compose(text, { conversationId, model: upstreamModel });
  const target = upstreamBase + (upstreamPath ?? path);
  const res = await fetchImpl(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}: ${raw.slice(0, 200)}`);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return raw.trim(); }
  if (parsed?.error) throw new Error(`upstream error: ${parsed.error.message ?? JSON.stringify(parsed.error).slice(0, 200)}`);
  const reply = d.replyText(parsed);
  if (!reply) throw new Error("upstream returned no text the dialect recognises");
  return reply;
}
