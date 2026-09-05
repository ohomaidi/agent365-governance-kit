# Agent 365 Governance Kit — Governance Proxy

Microsoft Purview DLP for an agent **you cannot modify**.

The Purview guard is a library your agent calls. That works when you own the
source. For a third-party or vendor agent there is nowhere to put that call, so
this puts the guard in the network path instead:

```
caller → [ proxy: evaluate(prompt) → upstream agent → evaluate(reply) ] → caller
```

Register **the proxy's URL** as the agent's endpoint in Agent 365 and the
registry's own record points at a governed endpoint. The kit's installer does
that for you when you choose *third-party agent*; it writes this proxy's `.env`.

It also carries the half of Agent 365 a vendor agent cannot give you: a
**Teams bridge** on `/api/messages` (below).

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
--teams <on|off>        Teams bridge (default: on when the installer wrote agent_id
                        and connections__service_connection__* to .env).
--upstream-path <p>     Path the bridge posts a turn to (default per dialect).
--upstream-model <m>    Model name to send with the openai dialect.
```

`GOVERNANCE_UPSTREAM`, `GOVERNANCE_DIALECT`, `GOVERNANCE_PROXY_PORT` and
`GOVERNANCE_UPSTREAM_MODEL` are the environment equivalents.

## Teams bridge

Teams speaks Bot Framework activities to a messaging endpoint that must
authenticate as the agent's blueprint identity. A vendor API has no such
endpoint, so the proxy provides it:

```
Teams → /api/messages → verify JWT (Microsoft 365 Agents SDK)
                      → Purview uploadText   → refuse in chat if blocked
                      → vendor API, in its dialect (one turn = one call)
                      → Purview downloadText → refuse in chat if blocked
                      → reply as the agent; record the turn for the Agent 365 Activity tab
```

- Identity, endpoint and observability values come from the `.env` the
  installer writes (`agent_id`, `connections__service_connection__*`,
  `agent365Observability__*`). With no `agent_id` it runs in the SDK's
  anonymous mode — right for the Agents Playground and the test-suite, wrong
  for real Teams.
- The turn is sent upstream as: `a2a` → `message/send` JSON-RPC; `openai` →
  `POST /v1/chat/completions`; `generic` → `POST / {message, conversationId}`.
  Override the path with `--upstream-path`.
- A vendor error is reported in the chat, never swallowed.
- Each turn is attributed to the person who typed it (`from.aadObjectId`) and
  correlated by the Teams conversation id.

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
- **It is not an authentication boundary** for API traffic. Put it behind your
  existing authn/authz; it forwards credentials to the upstream unchanged. The
  Teams bridge *does* verify the Bot Framework JWT on `/api/messages`.
- **The bridge is one turn = one upstream call.** Conversation memory is the
  vendor's job (the conversation id is passed along); the proxy keeps none.

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
