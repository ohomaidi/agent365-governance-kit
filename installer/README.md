# Agent 365 Setup — what's in this folder

Double-click the launcher for your platform. It starts a small local page in
your browser and walks you through the setup. Nothing to install first,
nothing to type in a terminal.

| Platform | Double-click |
|---|---|
| macOS | `Agent 365 Setup.app` |
| Windows | `Agent 365 Setup.vbs` |

Keep the launcher next to the `kit` folder — it finds the setup files relative
to itself.

## What happens when you run it

1. **Checks the machine.** Node.js runs the page; PowerShell 7 creates the
   Purview policies. If either is missing, the launcher or the page offers to
   download an official copy into your user folder (`~/.agent365`). Nothing
   system-wide is changed and no admin password is asked for.
2. **Signs you in, twice, as a Global Administrator.** Both are short device-code
   sign-ins: the page shows a code, opens Microsoft's sign-in page, and you type
   the code there. Your password never touches this tool.
   - Microsoft 365 — appears in your sign-in log as *Microsoft Graph Command
     Line Tools*. Tick **Consent on behalf of your organization** the first
     time; it is a one-time consent for the permissions the setup needs.
   - Teams Developer Portal — appears as *Teams Toolkit*. This is what registers
     the agent's messaging endpoint so Teams can reach it.
3. **Checks the tenant** — licences, Exchange Online, the Purview and Agent 365
   permissions, your roles — before anything is created.
4. **Asks a few plain questions.** Which agent (a folder on this machine, or a
   third-party agent's API to front with the governance proxy), its name and
   public address, who the policy applies to, and how strictly. The safe
   answers are preselected.
5. **Rehearse** runs the whole thing without changing anything. **Provision**
   asks for confirmation naming the tenant, mode and scope, then does it all and
   streams the log into the page.

When it finishes, a message from your agent is waiting in your Teams.

## Security notes

- The local page binds **127.0.0.1 only**. It can provision a tenant; it must
  not be reachable from the network, and it isn't.
- Sign-in tokens and your answers live in a temp folder with `0600`
  permissions and are removed when the setup closes.
- No credential is ever rendered into the page. Secrets go straight into the
  agent's `.env`.
- The macOS bundle is not notarised. On first launch macOS says
  *"Agent 365 Setup" Not Opened*: click **Done**, open **System Settings →
  Privacy & Security**, scroll to *"Agent 365 Setup" was blocked* → **Open
  Anyway**, confirm, and double-click the app again. Once. (Sign and notarise
  it with a Developer ID to remove this step for customers.)
- Windows SmartScreen may show *Windows protected your PC* for the launcher:
  **More info → Run anyway**.
