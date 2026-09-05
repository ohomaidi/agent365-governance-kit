# Agent 365 Governance Kit — .NET

Drop-in Microsoft Purview governance for any .NET AI agent (Semantic Kernel, M365 Agents SDK, or custom). Uses only `System.Net.Http` + `System.Text.Json`.

## Add to your project

```bash
dotnet add reference ../agent365-governance-kit/packages/dotnet/Agent365.Governance.csproj
# (or, once published)  dotnet add package ZaatarLabs.Agent365.Governance
```

## Configure

Run the wizard once from the repo root to provision the tenant and write the `PURVIEW_*`
environment variables:

```bash
node wizard/agent365-govern.mjs --dry-run   # rehearse — changes nothing
node wizard/agent365-govern.mjs             # provision
```

**Defaults are fail-safe:** the guard is enabled unless `PURVIEW_ENABLED=false`, and it
**blocks** when Purview is unreachable unless `PURVIEW_FAIL_CLOSED=false`. See the
[configuration reference](../../README.md#configuration-reference).

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

`EvaluateAsync()` returns `EvalResult(Blocked, Evaluated, Reason, Degraded)`.

### Don't rely on `Blocked` alone

`Blocked == false` can mean "Purview allowed it" *or* "the guard never ran". Check the
guard's state once at startup, and alert on degraded turns:

```csharp
var guard = new PurviewGuard(PurviewConfig.FromEnvironment(),
    http: httpClientFactory.CreateClient("purview"),
    logError: logger.LogError, logWarn: logger.LogWarning);

if (guard.State != GuardState.Ready)
    logger.LogError("Purview guard is {State}; missing {Missing}",
        guard.State, string.Join(", ", guard.Missing));

var v = await guard.EvaluateAsync(prompt, "uploadText", correlationId: cid, ct: ct);
if (v.Degraded == DegradedReason.Error) metrics.Increment("purview.unreachable");
```

Pass your own `HttpClient` (ideally from `IHttpClientFactory`) and logging delegates so
the guard participates in your app's HTTP handler lifetime and logging pipeline. Without
one it uses a shared static `HttpClient`, which is safe but not DI-managed.

### Per-call attribution

For a multi-user app, pass the real signed-in user and caller IP — otherwise every
interaction is attributed to `PURVIEW_USER_ID` and no IP is recorded:

```csharp
await guard.EvaluateAsync(prompt, "uploadText", userId: signedInUserObjectId,
    correlationId: cid, ipAddress: httpContext.Connection.RemoteIpAddress?.ToString(), ct: ct);
```

## Test

```bash
cd packages/dotnet/tests && dotnet test
```

18 behavioural tests against a stub transport: defaults, misconfiguration, verdicts,
retries, timeouts, caching, payload shape, and secret redaction.

## Notes
- **Agent 365 observability** (Activity tab) for .NET ships in the Microsoft Agents SDK for .NET; this package covers the Purview layer. See `../../AGENT365_SETUP.md` for the identity/observability + onboarding steps.
- Block fires on **UploadText** (the prompt). DLP policies take up to ~1h to propagate,
  and a policy created in **test mode blocks nothing**.
- Every call is bounded by `PurviewConfig.Timeout` and retries 429/5xx with backoff.
- `EvaluateAsync` honours your `CancellationToken`; caller cancellation is never retried.
- Not published to NuGet — add a project reference from this repo.
