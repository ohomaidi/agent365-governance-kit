# Setup without a terminal

The customer double-clicks one file. It finds Node, starts a loopback-only
server, and opens their browser to a form-based wizard.

| Platform | Double-click |
|---|---|
| macOS | `installer/macos/Agent 365 Setup.app` |
| Windows | `installer/windows/Agent 365 Setup.vbs` |

Keep the launcher inside the kit folder — it locates the wizard relative to
itself and says so plainly if it can't.

## What it does

1. **Checks prerequisites** — Node 18+, Azure CLI, PowerShell 7, and OpenSSL on
   macOS/Linux (Windows uses `New-SelfSignedCertificate` instead). Anything
   missing is listed with a download link rather than a stack trace.
2. **Signs in** — a button runs `az login`. No terminal: the customer can name a
   tenant (leave blank for their default), and if the machine can't open a
   sign-in window — remote desktop, a server console — they tick a box and the
   page shows the device code in large type. Sign-in is streamed, not awaited,
   so the page stays responsive throughout.
3. **Collects the same decisions the CLI asks for**, with the safe option
   preselected and the risky ones behind visible warnings.
4. **Rehearse** runs a full dry run and changes nothing. **Provision** asks for
   confirmation naming the tenant, mode and scope before it does anything.
5. **Streams the live log** into the page, so there's nothing to go and read
   afterwards.

## Why there's no second implementation

The browser wizard doesn't reimplement provisioning. It writes the operator's
answers to a temporary JSON file and runs the CLI wizard with `--answers`, then
streams its output back. One code path, one set of tests, no drift.

That flag is useful on its own:

```bash
node wizard/agent365-govern.mjs --answers answers.json --dry-run
```

Repeat runs become reproducible instead of depending on prompt order — handy for
rehearsing against a test agent before a customer visit.

## Security notes

- The server binds **127.0.0.1 only**. It can provision a tenant; it must not be
  reachable from the network.
- The answers file is written `0600` into a temp directory and deleted when the
  run finishes.
- No credential is ever rendered into the page. Secrets go straight into the
  `.env` the wizard writes.
- The macOS bundle is unsigned. Gatekeeper will ask on first launch —
  right-click → Open, or sign it with your own Developer ID before distributing.
