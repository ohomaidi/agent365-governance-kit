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

## Safety model (read this first)

This kit changes **tenant-wide compliance configuration** and sits in the request path of a
production agent. Its defaults are chosen so that a mistake fails safe:

| Behaviour | Default | Why |
|---|---|---|
| Guard enabled | **on** (`PURVIEW_ENABLED=false` to opt out) | A missing env var must not silently disable governance. |
| Unreachable Purview | **blocks** (`PURVIEW_FAIL_CLOSED=false` to opt out) | An outage must not become an ungoverned window. |
| Incomplete config | **blocks**, logs which vars are missing | "Misconfigured" is a failure, not "off". |
| New DLP policy mode | **TestWithNotifications** | Audits and alerts; blocks nothing until you review results. |
| New DLP policy scope | **a pilot group you name** | Tenant-wide needs two explicit confirmations. |
| DSPM content ingestion | **off** | Storing prompt/response text is a privacy decision, not a default. |
| Provisioning privileges | **revoked after use** | The connector keeps only the two Graph roles it needs at runtime. |

Every HTTP call is bounded by a timeout and retries throttling (429) and transient
5xx with backoff. Client secrets are redacted from all log output.

## 0. No terminal? Double-click instead

| Platform | Double-click |
|---|---|
| macOS | `installer/macos/Agent 365 Setup.app` |
| Windows | `installer/windows/Agent 365 Setup.vbs` |

Checks prerequisites, signs you in, and runs the whole thing from a browser
form with a live log. It drives the same CLI wizard underneath via `--answers`,
so there is no second implementation to drift. See
[`installer/README.md`](installer/README.md).

## 0b. Check the tenant can actually do it

```bash
node wizard/agent365-govern.mjs --check
```

Tooling readiness ("is `az` installed?") says nothing about whether the *tenant*
supports any of this. An unlicensed tenant passes every tooling check and then
fails ten minutes later at `Connect-IPPSSession`, in front of the customer.

This asks the tenant directly — licences, `.onmicrosoft.com` domain, Exchange
Online, the Purview Graph app roles, the Agent 365 registry, and the directory
roles you actually hold — and prints what to fix. The wizard also runs it before
the interview, and the installer shows it on the first screen.

## 0c. Rehearse (recommended before any customer run)

```bash
node wizard/agent365-govern.mjs --dry-run     # or: npm run plan
```

Walks the full interview and prints exactly what **would** be created. Mutates nothing.

For a reproducible run, supply every answer up front:

```bash
node wizard/agent365-govern.mjs --answers answers.json --dry-run
```

## 1. Provision (one time, tenant admin)

From the repo root:

```bash
node wizard/agent365-govern.mjs      # or: npm run init
```

The wizard signs you in (`az login` as Global Admin), asks for your variables, your
agent's language, **who the policy applies to**, and **whether it enforces**, then:

1. creates a dedicated app registration + secret + certificate,
2. grants `Content.Process.All`, `ProtectionScopes.Compute.All`, `Exchange.ManageAsApp`,
3. assigns the **Compliance Administrator** role (provisioning only — see step 7),
4. creates a DLP policy + rules (Credit Card and/or your custom keywords) and, if you
   ask for it, a DSPM collection policy,
5. writes all `PURVIEW_*` (and optional `agent365Observability__*`) values into your
   app's `.env` — **replacing** any previous block it wrote, after taking a `.bak`,
6. validates end to end: **token → `protectionScopes/compute` → `processContent`**,
7. offers to **revoke** Compliance Administrator + `Exchange.ManageAsApp`, which are
   only needed to create policies, never at runtime,
8. prints the integration snippet for your language **and the manual Agent 365 steps**
   (also saved to `AGENT365_SETUP.md`).

**Requirements:** Azure CLI (`az`), PowerShell 7 (`pwsh`), `openssl`, a tenant **Global Admin**,
and PowerShell Gallery reachability (the wizard checks this up front and tells you if it's blocked).

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

### Checking `blocked` is not the whole story

`evaluate()` also returns `evaluated` and `degraded`. `blocked === false` can mean
"Purview allowed it" *or* "the guard is switched off" — tell them apart at startup:

```ts
if (guard.state !== "ready") {
  // "disabled"      → someone set PURVIEW_ENABLED=false
  // "misconfigured" → guard.missing lists the env vars to fix
  console.error(`Purview guard is ${guard.state}`, guard.missing);
}
```

Alert on `degraded === "error"` in production: it means the governance plane was
unreachable for that turn.

## 3. Finish Agent 365 onboarding (if you want the Activity tab)

The wizard provisions Purview but **cannot** upload a manifest or assign licenses. Those admin steps — create/upload manifest, create instance, assign **Frontier**, wire observability — are in **[AGENT365_SETUP.md](AGENT365_SETUP.md)** (the wizard also writes a copy next to your `.env`).

---

## Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `PURVIEW_ENABLED` | `true` | `false` disables the guard entirely (allows everything). |
| `PURVIEW_TENANT_ID` | — | Entra tenant id. **Required.** |
| `PURVIEW_CLIENT_ID` | — | Connector app registration. **Required.** |
| `PURVIEW_CLIENT_SECRET` | — | Its client secret. **Required.** |
| `PURVIEW_APP_LOCATION` | `PURVIEW_CLIENT_ID` | App id the DLP policy is scoped to. |
| `PURVIEW_USER_ID` | — | Entra **object id** interactions are attributed to. **Required.** |
| `PURVIEW_APP_NAME` | `Custom AI App` | Name shown in Purview audit/DSPM. |
| `PURVIEW_FAIL_CLOSED` | `true` | `false` allows traffic when Purview is unreachable. |
| `PURVIEW_TIMEOUT_MS` | `10000` | Per-request timeout (1000–120000). |
| `PURVIEW_MAX_RETRIES` | `3` | Retries for 429/5xx (0–10). |
| `PURVIEW_DEVICE_TYPE` | `Unmanaged` | Device type reported to Purview. |
| `PURVIEW_DEVICE_IP` | *(unset)* | Client IP. **Omitted when unset** rather than faked. |

## Tests

```bash
npm run test:all       # TypeScript + wizard + Python + .NET
```

| Suite | Count | Covers |
|---|---|---|
| TypeScript | 20 | defaults, misconfiguration, verdicts, retries, timeouts, caching, payload, redaction |
| Python | 19 | same behaviours, mirrored |
| .NET | 18 | same behaviours, mirrored |
| Wizard | 51 | quoting/injection, `.env` replacement, policy mode + scope, cross-platform certs, Agent 365 payloads and call ordering |
| Proxy | 20 | enforcement, protocol-shaped refusals, attribution, health |

CI runs all of them on every push ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Notes & limits

- **Block direction:** the Application enforcement plane blocks **UploadText** (the prompt), not the model's response. Govern by blocking the *question*.
- **Propagation:** new DLP policies can take up to ~1 hour to start enforcing.
- **Test mode blocks nothing.** A policy created in `TestWithNotifications` audits and alerts only. Re-run the wizard and choose *Enable* once you've reviewed the results.
- **Attribution:** every interaction is attributed to `PURVIEW_USER_ID` unless you pass the real signed-in user per call. For a multi-user app, pass it — otherwise the DSPM/audit trail shows one identity for everyone.
- **DSPM ingestion stores prompt and response text** in Purview. Off by default; clear it with the customer's privacy owner before turning it on.
- **Per-user scoping:** the managed-app plane doesn't accept user/group scoping via PowerShell for *all* policy types; the wizard sets it in the policy `Locations`, and you can refine it in the Purview portal.
- **Billing:** Purview API calls for custom apps are metered (pay-as-you-go on the Azure subscription).
- **PowerShell:** the wizard pins ExchangeOnlineManagement `3.5.1` (newer 3.10.x throws on PowerShell 7.6).
- **Certificate:** used only for policy provisioning. The runtime authenticates with the client secret; remove the cert afterwards if you won't re-run the wizard.
- **Not published to npm/PyPI/NuGet.** Install from this repo (see each package README); `npx agent365-govern` will not resolve.
