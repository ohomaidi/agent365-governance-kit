# Agent 365 Governance Kit — Governance Proxy

Microsoft Purview DLP for an agent **you cannot modify**.

The Purview guard is a library your agent calls. That works when you own the
source. For a third-party or vendor agent there is nowhere to put that call, so
this puts the guard in the network path instead:

```
caller → [ proxy: evaluate(prompt) → upstream agent → evaluate(reply) ] → caller
```

Register **the proxy's URL** as the `agentInstance.url` in Agent 365 and the
registry's own record points at a governed endpoint.

## Run it

```bash
npm install
GOVERNANCE_UPSTREAM=https://vendor.example.com node src/bin.mjs --port 8787
```

It reads the same `PURVIEW_*` environment the rest of the kit uses, so the
wizard configures it exactly as it would configure an agent you wrote.

```
--upstream <url>        REQUIRED. The agent to front.
--port <n>              Listen port (default 8787).
--dialect <name>        a2a | openai | generic | auto   (default auto)
--request-paths  <a,b>  Custom dot-paths to the prompt text.
--response-paths <a,b>  Custom dot-paths to the reply text.
--streaming <mode>      buffer (default, governed) | passthrough (NOT governed)
--max-body <bytes>      Request body cap (default 5 MiB).
```

## Wire formats

The proxy has to find human-readable text in someone else's payloads. Three
dialects ship, and it sniffs by default:

| Dialect | Detects | Request text | Refusal |
|---|---|---|---|
| `a2a` | `jsonrpc: "2.0"` | `params.message.parts[].text` | JSON-RPC error `-32001`, HTTP 200 |
| `openai` | `messages[]` or `model` | `messages[].content` | HTTP 403 `policy_violation` |
| `generic` | fallback | `message` / `prompt` / `input` / `text` | HTTP 403 |

Refusals are shaped like the protocol the caller is already speaking, so the
vendor's own client renders them instead of choking. For anything else, use
`--request-paths` / `--response-paths` rather than teaching the core a new shape.

## Is it actually governing?

```bash
curl localhost:8787/_governance/health
```

Returns **503** and `"governing": false` whenever the guard is disabled or
misconfigured, so a monitor catches an ungoverned proxy instead of it looking
healthy. It also reports how much it has blocked.

## Limits — read these before you rely on it

- **It only governs traffic that traverses it.** A vendor SaaS agent that users
  hit directly in a browser is not covered. Force traffic through the proxy with
  DNS or network policy, or use Purview endpoint/browser DLP instead.
- **Streaming is buffered to be evaluated.** That is the default and it costs
  incremental delivery. `--streaming passthrough` restores streaming but leaves
  the response **ungoverned**; it warns loudly at startup.
- **Non-JSON bodies are forwarded ungoverned**, with a warning — the proxy
  cannot find text it cannot parse.
- **It is not an authentication boundary.** Put it behind your existing
  authn/authz; it forwards credentials to the upstream unchanged.

## Attribution

Pass the end user through so the audit trail isn't a single service account:

| Header | Purpose |
|---|---|
| `x-agent-user-id` | End user's Entra object id (override with `--user-header`) |
| `x-correlation-id` | Thread id, so Purview groups a conversation |
| `x-forwarded-for` / `cf-connecting-ip` | Real client IP |

Without them the proxy falls back to `PURVIEW_USER_ID` and derives a
correlation id from the payload or a fresh UUID.

## Test

```bash
npm test     # 20 tests: enforcement, refusal shapes, attribution, health
```

The tests assert the thing that matters most: **a blocked prompt never reaches
the upstream**, and a blocked reply never reaches the caller.
