# Completing Agent 365 setup (manual steps)

The wizard fully provisions the **Purview** side (app registration, permissions, DLP policies, DSPM collection). It cannot do the **Agent 365 onboarding** for you — that requires a manifest upload and licensing through the admin center. This is the checklist for those steps.

> You only need this if you want **Agent 365 identity + the admin-center Activity tab**. The Purview governance works without any of it.

## Prerequisites
- A tenant **Global / Teams admin**.
- **Agent 365 Frontier** enabled on the tenant, and a Frontier license assigned to the agent's owner/user.

## 1. Create the manifest
Your agent needs a Teams/M365 app package (`manifest.json` + a 192×192 color icon + a 32×32 outline icon, zipped).

- **a365 CLI (recommended):**
  ```bash
  dotnet tool install -g Microsoft.Agents.A365.DevTools.Cli
  a365 publish --aiteammate --agent-name "<Your Agent>"
  ```
  Produces `manifest/manifest.json` + `manifest.zip`. Keep `description.short` ≤ 80 chars.
- **Or** the **Microsoft 365 Agents Toolkit** (VS Code extension) — form-driven, with a "Zip Teams App Package" button.

## 2. Upload the manifest (admin)
Microsoft 365 admin center → **Integrated apps → Upload custom apps** (or Teams admin center) → upload `manifest.zip` → assign users → finish deployment.

> If upload fails for an AI teammate, the tenant/user is missing **Frontier** — assign the license first (step 4).

## 3. Create the agent instance
After upload, the agent appears in the admin center. Create/confirm the **instance** (the identity people chat with). Note its **live instance id** — observability authorizes by the *instance* id, not the blueprint id.

## 4. Assign the Frontier license
Admin center → the agent's owner/user → assign the **Agent 365 Frontier** license. (Required for instance creation and AI-teammate upload.)

## 5. Wire observability in your agent code
Only for agents on the **Microsoft 365 Agents SDK** (Node or .NET):

- Set the `agent365Observability__*` env vars (the wizard writes these if you provided a blueprint app id/secret).
- Node: call `initObservability(loadConfig().observability)` at startup; in the turn handler call `refreshTurnObservability(...)` and wrap the turn in `withAgentScope(...)`. See the TypeScript package README.
- The observability OBO token is minted **per authenticated turn** — only Teams/Copilot turns light up the Activity tab. Off-channel surfaces (a web portal) are governed by Purview but won't appear in the Activity tab.

## 6. Verify
Send a message to the agent in Teams, then check **admin center → the agent → Activity** tab. If you run multiple instances, each has its own Activity tab — consolidate to one instance to keep history in one place.
