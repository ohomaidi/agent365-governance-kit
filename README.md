# Agent 365 Governance Kit

## Download and run

Hand a customer **one file**. They unzip it and double-click. No cloning, no terminal.

| Platform | Download | Then double-click |
|---|---|---|
| **macOS** | [Agent365-Setup-macOS.zip](https://github.com/ohomaidi/agent365-governance-kit/releases/latest/download/Agent365-Setup-macOS.zip) | **Agent 365 Setup** |
| **Windows** | [Agent365-Setup-Windows.zip](https://github.com/ohomaidi/agent365-governance-kit/releases/latest/download/Agent365-Setup-Windows.zip) | **Agent 365 Setup.vbs** |

The browser opens onto the setup wizard. It asks for three things — where the agent
lives, what it's called, and its web address — and works the rest out itself.

**Requires** Node.js 18+, Azure CLI and PowerShell 7 on the machine running setup, plus a
tenant Global Administrator. All three have ordinary installers; anything missing is
named with a download link rather than a stack trace.

**No terminal at any point** — signing in to Azure is a button on the first screen, with
a tenant box and a device-code option for machines that can't pop a sign-in window.
**Rehearse** runs the whole thing and changes nothing.

> Not yet notarised for macOS: the first launch may need right-click → Open.

Everything below is for working on the kit itself.

---

Drop-in **Microsoft governance for any custom AI agent** — in **TypeScript/Node, Python, and .NET**. Three layers:

- **Purview guard** — runs every prompt and reply through Microsoft Purview (Graph `processContent`) so they're audited, classified, captured for DSPM-for-AI, and **blocked inline** by your DLP policies. Works on *any* channel, including non-Microsoft surfaces (web portals, APIs). Available in all three languages.
- **Agent 365 identity + registration** — creates the agent identity blueprint and registers the agent (and its A2A card) in the Agent 365 registry through Graph, so admins can see and govern it. Plus observability wiring so authenticated turns light up the admin-center **Activity tab**.
- **Governance proxy** — the same Purview checks applied to an agent **you cannot modify**. A third-party or vendor agent gets governed without touching its code; register the proxy's URL and the registry itself points at a governed endpoint.

A one-time **wizard** provisions the whole Microsoft side after a tenant admin signs in, writes your config, and registers the agent. It runs from a terminal or from a **browser form the customer double-clicks**.

```
agent365-governance-kit/
├── wizard/
│   ├── agent365-govern.mjs   # the setup wizard — provisions any tenant
│   └── lib/
│       ├── agent365.mjs      # Agent 365 blueprint + registry registration
│       └── capabilities.mjs  # tenant capability probe (--check)
├── installer/                # double-click launchers + browser wizard
│   ├── macos/                #   Agent 365 Setup.app
│   └── windows/              #   Agent 365 Setup.vbs
├── packages/
│   ├── typescript/           # @zaatarlabs/agent365-governance-kit  (Purview + Agent 365)
│   ├── python/               # agent365-governance-kit              (Purview)
│   ├── dotnet/               # ZaatarLabs.Agent365.Governance       (Purview)
│   └── proxy/                # @zaatarlabs/agent365-governance-proxy
├── AGENT365_SETUP.md         # the admin steps that genuinely still need a human
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
| New DLP policy scope | **a pilot group** (created for you when you name people) | Purview binds only to a tenant or a mail-enabled group; tenant-wide needs two explicit confirmations. |
| DSPM content ingestion | **off** | Storing prompt/response text is a privacy decision, not a default. |
| Provisioning privileges | **revoked after use** | The connector keeps only the two Graph roles it needs at runtime. |

Every HTTP call is bounded by a timeout and retries throttling (429) and transient
5xx with backoff. Client secrets are redacted from all log output.

## 0. Build the installer packages

```bash
./installer/package.sh          # -> dist-installer/*.zip
```

Produces the two files linked at the top of this README. Each zip carries the
launcher plus only the kit files the installer needs — the wizard and installer
use nothing but Node built-ins, so there is nothing to install on the far side.

To run it from a checkout without packaging:

```bash
node installer/server.mjs
```

The browser wizard drives the same CLI wizard underneath via `--answers`, so
there is no second implementation to drift. See
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

0. when you scope to specific people, creates (or reuses) a **Microsoft 365 pilot group**
   holding them — Purview's Applications-workload DLP binds to a tenant or a mail-enabled
   group only; there is no per-user binding,
1. creates a dedicated app registration + secret + certificate,
2. grants `Content.Process.All`, `ProtectionScopes.Compute.All`, `Exchange.ManageAsApp` —
   plus `AgentInstance.ReadWrite.All` and the blueprint roles when you ask for
   Agent 365 registration,
3. assigns the **Compliance Administrator** role (provisioning only — see step 8),
4. creates a DLP policy + rules (Credit Card and/or your custom keywords) and, if you
   ask for it, a DSPM collection policy,
5. **registers the agent in Agent 365** — identity blueprint → credential → blueprint
   principal → agent identity → `POST /beta/copilot/agentRegistrations` with the agent
   card, then reads it back to verify. Re-running finds and reuses each of these,
6. writes all `PURVIEW_*`, `agent365Observability__*` and `AGENT365_INSTANCE_ID` values
   into your app's `.env` — **replacing** any previous block it wrote, after a `.bak`,
7. validates end to end: **token → `protectionScopes/compute` → `processContent`**,
8. offers to **revoke** Compliance Administrator + `Exchange.ManageAsApp`, which are
   only needed to create policies, never at runtime,
9. prints the integration snippet for your language and writes `AGENT365_SETUP.md`.

Registration is performed **app-only, as the connector app** — not through `az rest`.
The Azure CLI is a first-party app whose token carries no agent scopes at all, so
registry calls made through it fail in every tenant, however well licensed.

**Requirements:** Azure CLI (`az`), PowerShell 7 (`pwsh`), a tenant **Global Admin**, and
PowerShell Gallery reachability (checked up front). On macOS/Linux `openssl` is also
needed; on Windows the certificate comes from `New-SelfSignedCertificate` instead.

> **Why a dedicated app, not your agent's identity?** Agentic identities can't mint app-only tokens (`AADSTS82001`). The guard uses a normal app registration with app-only client credentials.

## 2. Integrate (two calls)

Pick your language — full instructions in each package README:

| Language | Package | Integration |
|---|---|---|
| TypeScript / Node | [`packages/typescript`](packages/typescript/README.md) | `guard.evaluate(text, "uploadText", { correlationId })` |
| Python | [`packages/python`](packages/python/README.md) | `guard.evaluate(text, "uploadText", correlation_id=cid)` |
| .NET | [`packages/dotnet`](packages/dotnet/README.md) | `await guard.EvaluateAsync(text, "uploadText", correlationId: cid)` |
| **Can't change the code** | [`packages/proxy`](packages/proxy/README.md) | Run the guard in a reverse proxy — no integration at all |

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

## 3. Govern an agent you can't modify

The guard is a library your agent calls, which only works when you own the source.
For a third-party or vendor agent, run it in a proxy instead:

```bash
GOVERNANCE_UPSTREAM=https://vendor.example.com node packages/proxy/src/bin.mjs --port 8787
```

Then register **the proxy's URL** as the agent's endpoint, and the Agent 365
registry record points at a governed address. Full details, wire formats and
limits in [`packages/proxy`](packages/proxy/README.md).

## 4. What the wizard can't do for you

Agent registration itself is automated (blueprint, credential, instance and card,
all through Graph, then read back to verify). Two things still need a person:

- **Admin consent** for the blueprint's Graph permissions.
- **Licence assignment**, if your tenant requires one.

Both are written to **[AGENT365_SETUP.md](AGENT365_SETUP.md)** next to your `.env`.

> The legacy Entra agent registry API retired **15 June 2026**. Agents registered
> before then must be re-registered; re-running the wizard does that.

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

**128 tests total.** Registration and policy creation are also verified live against a licensed tenant.

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
- **Registration uses the Agent Registration API** (`/beta/copilot/agentRegistrations`), which Microsoft labels subject to change; the identity steps are on `v1.0`. It runs app-only under the connector app — the Azure CLI's own token carries no agent scopes, so `az rest` cannot make these calls. The older `/beta/agentRegistry/*` surface retired on 15 June 2026.
- **Scope is a tenant or a mail-enabled group.** Purview cannot bind an Applications-workload DLP policy to individual users, so "just me" / "specific people" become a Microsoft 365 pilot group the wizard creates and maintains.
- **The proxy only governs traffic that traverses it.** A vendor SaaS agent users hit directly in a browser bypasses it; use endpoint DLP or Agent 365's block control there.
- **Certificate:** used only for policy provisioning. The runtime authenticates with the client secret; remove the cert afterwards if you won't re-run the wizard.
- **Not published to npm/PyPI/NuGet.** Install from this repo (see each package README); `npx agent365-govern` will not resolve.
