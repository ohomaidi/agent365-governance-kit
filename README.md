# Agent 365 Governance Kit

Drop-in **Microsoft governance for any custom AI agent** — Claude, OpenAI, anything. Two layers:

- **Purview guard** — runs every prompt and reply through Microsoft Purview (Graph `processContent`) so they're audited, classified, captured for DSPM-for-AI, and **blocked inline** by your DLP policies. Works on *any* channel, including non-Microsoft surfaces (web portals, APIs).
- **Agent 365 identity + observability** — wiring so a registered agent's authenticated turns light up the admin-center **Activity tab**.

A setup **wizard** provisions the whole Microsoft side for you after a tenant admin signs in.

---

## Run from source (this repo)

Not yet published to npm — clone and build:

```bash
git clone https://github.com/ohomaidi/agent365-governance-kit.git
cd agent365-governance-kit
npm install          # installs typescript + @types/node
npm run build        # compiles src/ -> dist/
npm run init         # launches the setup wizard (same as: node bin/agent365-govern.mjs)
```

The wizard needs **Azure CLI** (`az`), **PowerShell 7** (`pwsh`), and **openssl** on PATH, and you must sign in as a tenant **Global Admin** when prompted.

## 1. Install (once published)

```bash
npm install @zaatarlabs/agent365-governance-kit
```

## 2. Provision (one time, tenant admin)

```bash
npx agent365-govern        # or: node bin/agent365-govern.mjs
```

The wizard signs you in (`az login` as Global Admin) and then:

1. creates a dedicated app registration + secret + certificate,
2. grants `Content.Process.All`, `ProtectionScopes.Compute.All`, `Exchange.ManageAsApp`,
3. assigns the **Compliance Administrator** role,
4. creates a DLP policy + rules (Credit Card and/or your custom keywords) and a DSPM collection policy,
5. writes all `PURVIEW_*` (and optional `agent365Observability__*`) values into your app's `.env`,
6. runs a live validation call.

> **Why a dedicated app, not your agent's identity?** Agentic identities can't mint app-only tokens (`AADSTS82001`). The guard uses a normal app registration with app-only client credentials.

**Requirements:** Azure CLI (`az`), PowerShell 7 (`pwsh`), `openssl`, and a tenant **Global Admin** to run the wizard.

## 3. Integrate (two calls)

```ts
import { loadConfig, createPurviewGuard } from "@zaatarlabs/agent365-governance-kit";

const guard = createPurviewGuard(loadConfig().purview);

async function handleTurn(userPrompt: string, conversationId: string) {
  // 1) govern the inbound prompt — block before the model sees it
  const inbound = await guard.evaluate(userPrompt, "uploadText", { correlationId: conversationId, sequenceNumber: 0 });
  if (inbound.blocked) return inbound.reason;

  const reply = await yourModel(userPrompt);   // Claude, OpenAI, anything

  // 2) govern the outbound reply
  const outbound = await guard.evaluate(reply, "downloadText", { correlationId: conversationId, sequenceNumber: 1 });
  if (outbound.blocked) return outbound.reason;

  return reply;
}
```

That's it. `guard.evaluate()` returns `{ blocked, reason, evaluated }`.

### Agent 365 observability (optional)

For an agent registered in Agent 365 (extends `AgentApplication`):

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

---

## Configuration (written by the wizard)

| Variable | Meaning |
|---|---|
| `PURVIEW_ENABLED` | turn the guard on/off |
| `PURVIEW_TENANT_ID` | Entra tenant id |
| `PURVIEW_CLIENT_ID` / `PURVIEW_CLIENT_SECRET` | the connector app credentials |
| `PURVIEW_APP_LOCATION` | the Entra app id the DLP policy is scoped to (= client id) |
| `PURVIEW_USER_ID` | Entra object id every interaction is attributed to |
| `PURVIEW_APP_NAME` | name shown in Purview audit/DSPM |
| `PURVIEW_FAIL_CLOSED` | `true` = block when Purview is unreachable; `false` = allow |

## Notes & limits

- **Block direction:** the Application enforcement plane blocks **UploadText** (the prompt), not the model's response. Govern by blocking the *question*.
- **Propagation:** new DLP policies can take up to ~1 hour to start enforcing.
- **Per-user scoping:** the managed-app plane doesn't accept user/group scoping via PowerShell; scope in the Purview portal if needed. By default the policy applies tenant-wide, but only your attributed user flows through the app.
- **Billing:** Purview API calls for custom apps are metered (pay-as-you-go on the Azure subscription).
- **PowerShell:** the wizard pins ExchangeOnlineManagement `3.5.1` (newer 3.10.x throws on PowerShell 7.6).
