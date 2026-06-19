# Agent 365 Governance Kit — .NET

Drop-in Microsoft Purview governance for any .NET AI agent (Semantic Kernel, M365 Agents SDK, or custom). Uses only `System.Net.Http` + `System.Text.Json`.

## Add to your project

```bash
dotnet add reference ../agent365-governance-kit/packages/dotnet/Agent365.Governance.csproj
# (or, once published)  dotnet add package ZaatarLabs.Agent365.Governance
```

## Configure

Run the wizard once (`npx agent365-govern` from the repo root) to provision the tenant and write the `PURVIEW_*` environment variables.

## Use (two calls)

```csharp
using ZaatarLabs.Agent365.Governance;

var guard = new PurviewGuard(PurviewConfig.FromEnvironment());

async Task<string> HandleTurnAsync(string prompt, string conversationId)
{
    // 1) govern the inbound prompt — block before the model sees it
    var inbound = await guard.EvaluateAsync(prompt, "uploadText", correlationId: conversationId, sequenceNumber: 0);
    if (inbound.Blocked) return inbound.Reason!;

    var reply = await MyModelAsync(prompt);   // Claude, Azure OpenAI, anything

    // 2) govern the outbound reply
    var outbound = await guard.EvaluateAsync(reply, "downloadText", correlationId: conversationId, sequenceNumber: 1);
    if (outbound.Blocked) return outbound.Reason!;

    return reply;
}
```

`EvaluateAsync()` returns `EvalResult(Blocked, Evaluated, Reason)`.

## Notes
- **Agent 365 observability** (Activity tab) for .NET ships in the Microsoft Agents SDK for .NET; this package covers the Purview layer. See `../../AGENT365_SETUP.md` for the identity/observability + onboarding steps.
- Block fires on **UploadText** (the prompt). DLP policies take up to ~1h to propagate.
