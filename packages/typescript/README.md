# Agent 365 Governance Kit — TypeScript / Node

Drop-in Microsoft governance for any Node/TypeScript AI agent. Two layers:

- **Purview guard** — DLP/audit/DSPM on any channel via Graph `processContent`.
- **Agent 365 identity + observability** — helpers to light up the admin-center Activity tab for an agent on the Microsoft 365 Agents SDK.

## Install

```bash
npm install @zaatarlabs/agent365-governance-kit
# from this repo:  npm install ./packages/typescript
```

The Microsoft SDKs are **optional peer deps** (only needed for the observability layer):

```bash
npm install @microsoft/agents-hosting @microsoft/opentelemetry
```

## Configure

Run the wizard once from the repo root to provision the tenant and write the `PURVIEW_*`
(and optional `agent365Observability__*`) variables into your `.env`:

```bash
node wizard/agent365-govern.mjs --dry-run   # rehearse — changes nothing
node wizard/agent365-govern.mjs             # provision
```

**Defaults are fail-safe:** the guard is enabled unless `PURVIEW_ENABLED=false`, and it
**blocks** when Purview is unreachable unless `PURVIEW_FAIL_CLOSED=false`. See the
[configuration reference](../../README.md#configuration-reference).

## Purview guard (two calls)

```ts
import { loadConfig, createPurviewGuard } from "@zaatarlabs/agent365-governance-kit";

const guard = createPurviewGuard(loadConfig().purview);

async function handleTurn(prompt: string, conversationId: string) {
  // 1) govern the inbound prompt — block before the model sees it
  const inbound = await guard.evaluate(prompt, "uploadText", { correlationId: conversationId, sequenceNumber: 0 });
  if (inbound.blocked) return inbound.reason;

  const reply = await yourModel(prompt);    // Claude, OpenAI, anything

  // 2) govern the outbound reply
  const outbound = await guard.evaluate(reply, "downloadText", { correlationId: conversationId, sequenceNumber: 1 });
  if (outbound.blocked) return outbound.reason;

  return reply;
}
```

`evaluate()` returns `{ blocked, reason, evaluated, degraded }`.

### Don't rely on `blocked` alone

`blocked === false` can mean "Purview allowed it" *or* "the guard never ran". Check the
guard's state once at startup, and alert on degraded turns:

```ts
const guard = createPurviewGuard(loadConfig().purview);

if (guard.state !== "ready") {
  // "disabled"      → PURVIEW_ENABLED=false
  // "misconfigured" → guard.missing lists the env vars to fix
  logger.error(`Purview guard is ${guard.state}`, { missing: guard.missing });
}

const v = await guard.evaluate(prompt, "uploadText", { correlationId });
if (v.degraded === "error") metrics.increment("purview.unreachable");
```

### Per-call attribution

For a multi-user app, pass the real signed-in user and caller IP — otherwise every
interaction is attributed to `PURVIEW_USER_ID` and no IP is recorded:

```ts
await guard.evaluate(prompt, "uploadText", {
  correlationId, userId: signedInUserObjectId, ipAddress: req.ip,
});
```

## Agent 365 observability (optional)

For an agent that extends `AgentApplication` (Microsoft 365 Agents SDK):

```ts
import { initObservability, agenticAuthorization, refreshTurnObservability, withAgentScope } from "@zaatarlabs/agent365-governance-kit";

await initObservability(loadConfig().observability);   // at startup

// in the AgentApplication constructor:
//   authorization: agenticAuthorization(["https://graph.microsoft.com/.default"])

// in the turn handler:
const details = { agentId, agentName, tenantId };
await refreshTurnObservability(context, this.authorization, details);
await withAgentScope(context, details, { host: "localhost", port: 3978 }, async () => {
  // ... handle the turn ...
});
```

See [`../../AGENT365_SETUP.md`](../../AGENT365_SETUP.md) for the manifest/instance/Frontier onboarding steps.

## Build and test from source

```bash
npm install && npm run build      # compiles src/ -> dist/
npm test                          # 20 behavioural tests against a mock Graph
```

## Notes
- Block fires on **UploadText** (the prompt); the Application plane can't block the response.
- New DLP policies take up to ~1h to propagate, and a policy created in **test mode blocks nothing**.
- Observability only emits on authenticated Teams/Copilot turns.
- Every call is bounded by `PURVIEW_TIMEOUT_MS` and retries 429/5xx with backoff.
- Not published to npm — install from this repo.
