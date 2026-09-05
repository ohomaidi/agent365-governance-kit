# Agent 365 Governance Kit

One installer that puts a custom AI agent under **Microsoft Agent 365** and
**Microsoft Purview** — identity, registry, DLP, DSPM, Teams — for agents you
built *and* for vendor agents you cannot modify.

Hand the customer **one file**. They double-click it, sign in as a Global
Administrator, answer four questions, and their agent is registered, governed,
and waiting for them in Teams.

## Download and run

| Platform | Download | Then double-click |
|---|---|---|
| **macOS** | [Agent365-Setup-macOS.zip](https://github.com/ohomaidi/agent365-governance-kit/releases/latest/download/Agent365-Setup-macOS.zip) | **Agent 365 Setup** |
| **Windows** | [Agent365-Setup-Windows.zip](https://github.com/ohomaidi/agent365-governance-kit/releases/latest/download/Agent365-Setup-Windows.zip) | **Agent 365 Setup.vbs** |

**Nothing to install first.** No Azure CLI, no PowerShell modules, no terminal.
If Node.js or PowerShell 7 are missing, the launcher and the page offer to
download an official copy into the user's own folder (`~/.agent365`); nothing
system-wide changes and no admin password is asked for.

**Sign-in is built in.** Two short device-code sign-ins (the page shows a code,
Microsoft's page takes the password): one for Microsoft 365, one for the Teams
Developer Portal. They appear in the tenant's sign-in log as *Microsoft Graph
Command Line Tools* and *Teams Toolkit*. The first asks for a one-time
"consent on behalf of your organization".

**Rehearse** runs the whole thing and changes nothing. **Provision** names the
tenant, mode and scope, asks once, then does it all and streams the log.

> Not notarised for macOS: the first launch may need right-click → Open.

---

## What it does — all of it

Everything below is performed by the installer, in this order, and read back
to verify. Nothing on this list is a manual step.

### In the tenant (Entra + Purview)

1. **Checks the tenant can do it** before touching it: licences, Exchange
   Online, the Purview and Agent 365 Graph permissions, and the admin's roles.
2. **Pilot group.** "Just me" / "specific people" become a Microsoft 365 group
   the installer creates and maintains — Purview binds a policy to a tenant or
   a mail-enabled group, never to individual users.
3. **Connector app registration** (the Purview daemon): secret, certificate,
   `Content.Process.All`, `ProtectionScopes.Compute.All`, `Exchange.ManageAsApp`,
   and the Agent 365 app roles it needs to register agents on the admin's behalf.
4. **Compliance Administrator** on the connector — provisioning only, revoked
   at the end (default on).
5. **DLP policy** for the Applications workload, in **test mode** by default,
   scoped to the pilot group: credit-card rule, optional custom keyword
   sensitive-information type, notifications.
6. **DSPM for AI collection policy** (one per tenant). A second agent is added by
   recreating the policy with both locations — verified live that Microsoft's
   `Set-FeatureConfiguration -Locations` returns OK and changes nothing, so the
   installer removes and recreates it, retrying while the name is released
   (the policy is absent for a couple of minutes and the log says so).
   Prompt/response ingestion is **off** unless the data owner turns it on.
7. **Validation**: connector token → `protectionScopes/compute` →
   `processContent`, live.
8. **Revoke** Compliance Administrator and `Exchange.ManageAsApp`.

### In Agent 365

9. **Agent identity blueprint** (`applications/microsoft.graph.agentIdentityBlueprint`)
   with a sponsor, a secret, and the identifier URI `api://botid-<appId>` with
   an `access_as_user` scope — what Microsoft's own `a365` CLI configures.
10. **Blueprint service principal** and **agent identity**.
11. **Inheritable permissions** for the Messaging Bot API, the Observability
    API and Agent 365 Tools, polled until they read back.
12. **Tenant-wide admin consent** from the blueprint to those three resources.
13. **Registration** in the Agent 365 registry (`copilot/agentRegistrations`)
    with an A2A agent card, verified by reading it back. The agent appears in
    **Microsoft 365 admin center → Agents → All agents**.

### In Teams

14. **App package** built from the blueprint (manifest id = bot id = blueprint
    appId, `webApplicationInfo.resource = api://botid-<appId>`, generated icons)
    and **published to the organisation's app catalog** — a new version is
    added if the app already exists.
15. **Messaging endpoint registered** in the Teams Developer Portal (bot id =
    blueprint appId, endpoint `https://<agent>/api/messages`) — before the
    install, because Teams opens the chat with the bot when it installs the app.
16. **Installed** in the personal scope of the admin, the attributed user and
    every member of the pilot group, so it is in their Teams app bar; retried
    while the bot registration propagates.
17. **Proof attempt**: the installer mints a token *as the agent identity* (the
    SDK's two-step agentic flow) and tries to send a hello into the admin's
    Teams. Teams' generic connector currently refuses proactive messages from
    an agent identity, so the installer says so and points the admin at the
    app, already in their Teams app bar: the first message is theirs, and the
    reply proves the path. Each step is an individual checkbox.

### On the agent

18. **Writes the agent's `.env`** (backing up the old one) with everything the
    runtime needs: `PURVIEW_*` for the guard; `agent365Observability__*` for the
    Activity tab; `agent_id` and `connections__service_connection__*` for
    Teams; the registry, identity, Teams app and endpoint ids for reference.
19. For a **vendor agent**: the same `.env` plus `GOVERNANCE_UPSTREAM` and the
    wire format, ready for the governance proxy (below).

**Licences:** blueprint-based agents (this kind) need no per-agent licence.
Microsoft's `a365` CLI assigns licences only to AI-teammate agent *users*.

---

## Two kinds of agent

### An agent you built

Point the installer at the folder. It detects the language (Node, Python, .NET),
writes the `.env`, and prints the two lines to add:

```
inbound = guard.evaluate(prompt, "uploadText")   # block before the model sees it
if inbound.blocked: return inbound.reason
reply = yourModel(prompt)
outbound = guard.evaluate(reply, "downloadText")  # block before returning
if outbound.blocked: return outbound.reason
```

For Teams, the agent must accept Bot Framework activities on `/api/messages`
and authenticate with the connection the installer wrote. The Microsoft 365
Agents SDK does this out of the box; the sample agent in this kit's history
(`abbas`) shows the wiring, including per-turn observability for the Activity
tab.

| Language | Package | Call |
|---|---|---|
| TypeScript / Node | [`packages/typescript`](packages/typescript/README.md) | `guard.evaluate(text, "uploadText", { correlationId })` |
| Python | [`packages/python`](packages/python/README.md) | `guard.evaluate(text, "uploadText", correlation_id=cid)` |
| .NET | [`packages/dotnet`](packages/dotnet/README.md) | `await guard.EvaluateAsync(text, "uploadText", correlationId: cid)` |

`evaluate()` also returns `evaluated` and `degraded`; `guard.state` is
`ready`, `disabled` or `misconfigured` (with `guard.missing`). Alert on
`degraded === "error"` in production.

### A vendor agent you cannot modify

Choose *third-party agent* in the installer and give it the vendor's API
address. The **governance proxy** becomes the agent as far as Purview,
Agent 365 and Teams are concerned:

```
users / Teams --> [ proxy: Purview(prompt) -> vendor API -> Purview(reply) ] --> reply
```

- **API traffic** through the proxy is governed in the vendor's own wire format:
  Agent2Agent JSON-RPC, OpenAI chat completions, or configurable JSON paths.
  Refusals come back in the caller's protocol.
- **Teams bridge** on `/api/messages`: the proxy authenticates as the agent's
  blueprint (Microsoft 365 Agents SDK), runs the same two Purview checks, calls
  the vendor, replies in the chat, and records each turn for the Agent 365
  Activity tab. A blocked message is refused in Teams with the reason.

```bash
cd ~/.agent365/proxy-<name>           # where the installer wrote the .env
npx --package @zaatarlabs/agent365-governance-proxy agent365-govern-proxy
# expose http://localhost:8787 at the public https address you gave the installer
```

`/_governance/health` returns 503 until the guard is actually governing.
The proxy only governs traffic that traverses it: a SaaS agent users open
directly in a browser must be forced through it (DNS/network policy) or
covered by endpoint DLP.

---

## Safety model

- **Test mode by default.** The DLP policy is created in `TestWithNotifications`
  (audits and alerts, blocks nothing). Active blocking needs an explicit choice
  and a typed `ENFORCE`.
- **Pilot scope by default.** Tenant-wide needs an explicit choice and a typed
  `TENANT-WIDE`.
- **Fail closed by default.** If Purview is unreachable the guard blocks
  (`PURVIEW_FAIL_CLOSED=true`).
- **Least privilege, briefly.** Compliance Administrator and Exchange access are
  granted for provisioning and revoked at the end; the runtime keeps only the two
  Purview permissions.
- **Credentials.** The PFX password travels through the environment, never a
  command line or a script. Generated files are shredded on exit. Tokens and
  answers live in a `0600` temp folder and are removed when setup closes. The
  installer page binds 127.0.0.1 only.
- **Rehearsal first.** `--dry-run` / *Rehearse* validates users and groups but
  creates nothing.
- **Honest reporting.** Every write is read back; anything that could not be
  verified is printed as a warning, not hidden behind a green tick. A stopped
  run lists exactly what was created so it can be undone.

---

## For engineers

```
agent365-governance-kit/
├── installer/                 # double-click launchers + browser page + loopback server
│   ├── macos/Agent 365 Setup.app
│   ├── windows/Agent 365 Setup.vbs
│   ├── server.mjs, ui.html
│   └── package.sh             # builds the two customer zips
├── wizard/
│   ├── agent365-govern.mjs    # the setup wizard the page drives (--answers, --dry-run, --check)
│   └── lib/
│       ├── auth.mjs           # device-code sign-in, token cache, delegated Graph + Dev Portal clients
│       ├── agent365.mjs       # blueprint → identity → inheritable permissions → registration
│       ├── teams.mjs          # app package, org catalog, per-user install, messaging endpoint, hello
│       └── capabilities.mjs   # tenant capability probe
├── packages/
│   ├── typescript/            # @zaatarlabs/agent365-governance-kit   (Purview guard, Node)
│   ├── python/                # agent365-governance-kit                (Purview guard)
│   ├── dotnet/                # ZaatarLabs.Agent365.Governance         (Purview guard)
│   └── proxy/                 # @zaatarlabs/agent365-governance-proxy  (reverse proxy + Teams bridge)
└── .github/workflows/ci.yml
```

### Running the wizard from a terminal

```bash
node wizard/agent365-govern.mjs --check                       # can this tenant do it?
node wizard/agent365-govern.mjs --dry-run                     # rehearse
node wizard/agent365-govern.mjs                               # interactive
node wizard/agent365-govern.mjs --answers answers.json        # scripted (what the page does)
```

The page never re-implements provisioning: it writes an answers file and runs
the wizard with `--answers`, then streams its output. One code path.

Environment knobs: `A365_TOKEN_CACHE` (reuse a sign-in), `A365_TENANT` (tenant
for the device-code prompt), `A365_PWSH` (path to a PowerShell 7), `A365_INSTALLER_PORT`.

### Why no Azure CLI

The Azure CLI's Graph token cannot carry `AppCatalog.*` (Microsoft pre-authorises
first-party apps per scope; AADSTS65002 refuses the rest) and the Teams
Developer Portal rejects it outright. Both were verified live. The kit's own
sign-in requests exactly the delegated scopes it needs under public client ids
Microsoft ships for this purpose.

### Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `PURVIEW_ENABLED` | `true` | `false` disables the guard entirely (allows everything). |
| `PURVIEW_TENANT_ID` / `PURVIEW_CLIENT_ID` / `PURVIEW_CLIENT_SECRET` | — | Connector identity. **Required.** |
| `PURVIEW_APP_LOCATION` | `PURVIEW_CLIENT_ID` | App id the DLP policy is scoped to. |
| `PURVIEW_USER_ID` | — | Entra **object id** interactions are attributed to when no per-call user is given. **Required.** |
| `PURVIEW_APP_NAME` | `Custom AI App` | Name shown in Purview audit/DSPM. |
| `PURVIEW_FAIL_CLOSED` | `true` | `false` allows traffic when Purview is unreachable. |
| `PURVIEW_TIMEOUT_MS` / `PURVIEW_MAX_RETRIES` | `10000` / `3` | Per-request timeout; retries for 429/5xx. |
| `PURVIEW_DEVICE_TYPE` / `PURVIEW_DEVICE_IP` | `Unmanaged` / unset | Device metadata; IP is omitted when unset rather than faked. |
| `agent365Observability__*` | written | Blueprint id/secret, agent identity id, tenant, name — for the Activity tab. |
| `agent_id`, `connections__service_connection__settings__*` | written | Agents SDK connection: Teams replies as the blueprint. |
| `AGENT365_REGISTRATION_ID`, `AGENT365_AGENT_IDENTITY_ID`, `AGENT365_TEAMS_APP_ID`, `AGENT365_MESSAGING_ENDPOINT`, … | written | Reference ids for the registry, identity, Teams app and endpoint. |
| `GOVERNANCE_UPSTREAM`, `GOVERNANCE_DIALECT`, `GOVERNANCE_PROXY_PORT` | written (proxy) | Vendor API, wire format (`a2a`/`openai`/`generic`/`auto`), listen port. |

### Tests

```bash
npm run test:all       # TypeScript + wizard + Python + .NET + proxy
```

| Suite | Count | Covers |
|---|---|---|
| TypeScript guard | 20 | defaults, misconfiguration, verdicts, retries, timeouts, caching, payload, redaction |
| Python guard | 19 | same behaviours, mirrored |
| .NET guard | 18 | same behaviours, mirrored |
| Wizard | 78 | quoting/injection, `.env` replacement, policy mode + scope, cross-platform certs, Agent 365 call order + replication, inheritable permissions, consent, Teams package/catalog/install/endpoint, tenant probe |
| Proxy | 29 | enforcement, protocol-shaped refusals, attribution, health, Teams bridge through the real Agents SDK adapter |

**164 tests.** CI runs all of them on every push. The tenant-side flow
(Purview policies, DSPM recreate, blueprint, identity, consent, registration,
Teams catalog, installs, endpoint) was exercised live against a licensed
tenant with two agents before this release.

### Cleaning a tenant up

Reverse order: Teams app (Teams admin center → Manage apps) and the Developer
Portal bot; the registration (`DELETE /beta/copilot/agentRegistrations/{id}`,
with the connector's token — it owns the record); the agent identity, then the
blueprint (Entra → Agent identities), each purged from the recycle bin; Purview
rules → policies → sensitive-information type → DSPM policy (re-grant Compliance
Administrator to the connector first); the pilot group; the connector app.

---

## Notes & limits

- **Block direction:** the Applications enforcement plane blocks **UploadText** (the prompt), not the model's response. Govern by blocking the *question*; the reply check is belt and braces.
- **Propagation:** a new DLP policy can take up to ~1 hour to start enforcing. A freshly created pilot group takes a minute or two to become visible to Exchange; the installer waits for it.
- **Test mode blocks nothing.** Re-run and choose *Enable* once the audit results look right.
- **Attribution:** pass the real signed-in user per call in a multi-user app; the Teams bridge and the sample agent do (`from.aadObjectId`).
- **DSPM ingestion stores prompt and response text** in Purview. Off by default.
- **Billing:** Purview API calls for custom apps are metered (pay-as-you-go on the Azure subscription).
- **PowerShell:** ExchangeOnlineManagement `3.5.1` is pinned (3.10.x throws on PowerShell 7.6); the downloaded portable PowerShell is 7.4.6.
- **Registration** uses `/beta/copilot/agentRegistrations`, which Microsoft labels subject to change; identity steps are on `v1.0`. The older `/beta/agentRegistry/*` surface retired on 15 June 2026 — re-running the wizard re-registers.
- **The messaging endpoint** is registered through the Teams Developer Portal API (the same call Teams Toolkit makes). Microsoft's `a365` CLI still prints a manual step here for tenants without its automated path; the kit does not need that path.
- **Not published to npm/PyPI/NuGet.** Install from this repo (see each package README).
