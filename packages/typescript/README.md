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

Run the wizard once (`npx agent365-govern` from the repo root) to provision the tenant and write the `PURVIEW_*` (and optional `agent365Observability__*`) variables into your `.env`.

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

`evaluate()` returns `{ blocked, reason, evaluated }`.

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

## Build from source

```bash
npm install && npm run build      # compiles src/ -> dist/
```

## Notes
- Block fires on **UploadText** (the prompt); the Application plane can't block the response.
- New DLP policies take up to ~1h to propagate.
- Observability only emits on authenticated Teams/Copilot turns.
