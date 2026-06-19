# Agent 365 Governance Kit

Drop-in **Microsoft governance for any custom AI agent** — in **TypeScript/Node, Python, and .NET**. Two layers:

- **Purview guard** — runs every prompt and reply through Microsoft Purview (Graph `processContent`) so they're audited, classified, captured for DSPM-for-AI, and **blocked inline** by your DLP policies. Works on *any* channel, including non-Microsoft surfaces (web portals, APIs). Available in all three languages.
- **Agent 365 identity + observability** — wiring so a registered agent's authenticated turns light up the admin-center **Activity tab**. Node + .NET (the languages with a Microsoft Agents SDK).

A one-time **wizard** provisions the whole Microsoft side after a tenant admin signs in, then writes your config and prints the remaining manual Agent 365 steps.

```
agent365-governance-kit/
├── wizard/              # shared setup wizard (Node CLI) — provisions any tenant
├── packages/
│   ├── typescript/      # @zaatarlabs/agent365-governance-kit  (Purview + Agent 365)
│   ├── python/          # agent365-governance-kit              (Purview)
│   └── dotnet/          # ZaatarLabs.Agent365.Governance       (Purview)
├── AGENT365_SETUP.md    # manual onboarding steps the wizard can't automate
└── README.md
```

---

## 1. Provision (one time, tenant admin)

From the repo root:

```bash
node wizard/agent365-govern.mjs      # or: npm run init  /  npx agent365-govern
```

The wizard signs you in (`az login` as Global Admin), asks for your variables and your agent's language, then:

1. creates a dedicated app registration + secret + certificate,
2. grants `Content.Process.All`, `ProtectionScopes.Compute.All`, `Exchange.ManageAsApp`,
3. assigns the **Compliance Administrator** role,
4. creates a DLP policy + rules (Credit Card and/or your custom keywords) and a DSPM collection policy,
5. writes all `PURVIEW_*` (and optional `agent365Observability__*`) values into your app's `.env`,
6. runs a live validation call,
7. prints the integration snippet for your language **and the manual Agent 365 steps** (also saved to `AGENT365_SETUP.md`).

**Requirements:** Azure CLI (`az`), PowerShell 7 (`pwsh`), `openssl`, and a tenant **Global Admin**.

> **Why a dedicated app, not your agent's identity?** Agentic identities can't mint app-only tokens (`AADSTS82001`). The guard uses a normal app registration with app-only client credentials.

## 2. Integrate (two calls)

Pick your language — full instructions in each package README:

| Language | Package | Integration |
|---|---|---|
| TypeScript / Node | [`packages/typescript`](packages/typescript/README.md) | `guard.evaluate(text, "uploadText", { correlationId })` |
| Python | [`packages/python`](packages/python/README.md) | `guard.evaluate(text, "uploadText", correlation_id=cid)` |
| .NET | [`packages/dotnet`](packages/dotnet/README.md) | `await guard.EvaluateAsync(text, "uploadText", correlationId: cid)` |

The pattern is the same everywhere:

```
inbound = guard.evaluate(prompt, "uploadText")   # block before the model sees it
if inbound.blocked: return inbound.reason
reply = yourModel(prompt)                          # Claude, OpenAI, anything
outbound = guard.evaluate(reply, "downloadText")  # block before returning
if outbound.blocked: return outbound.reason
return reply
```

## 3. Finish Agent 365 onboarding (if you want the Activity tab)

The wizard provisions Purview but **cannot** upload a manifest or assign licenses. Those admin steps — create/upload manifest, create instance, assign **Frontier**, wire observability — are in **[AGENT365_SETUP.md](AGENT365_SETUP.md)** (the wizard also writes a copy next to your `.env`).

---

## Notes & limits

- **Block direction:** the Application enforcement plane blocks **UploadText** (the prompt), not the model's response. Govern by blocking the *question*.
- **Propagation:** new DLP policies can take up to ~1 hour to start enforcing.
- **Per-user scoping:** the managed-app plane doesn't accept user/group scoping via PowerShell; scope in the Purview portal if needed.
- **Billing:** Purview API calls for custom apps are metered (pay-as-you-go on the Azure subscription).
- **PowerShell:** the wizard pins ExchangeOnlineManagement `3.5.1` (newer 3.10.x throws on PowerShell 7.6).
- **Verified:** the Purview guard is live-tested against a real tenant in all three languages (credit-card + salary prompts blocked, benign allowed).
