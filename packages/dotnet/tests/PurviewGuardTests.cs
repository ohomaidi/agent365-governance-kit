using System.Net;
using System.Text;
using System.Text.Json;
using Xunit;

namespace ZaatarLabs.Agent365.Governance.Tests;

/// <summary>
/// Behavioural tests for the .NET Purview guard against a stub transport.
/// Mirrors the TypeScript/Python suites: silent no-ops, fail-open on error,
/// throttling, hangs, and audit-payload shape.
/// </summary>
public class PurviewGuardTests
{
    /// <summary>Scriptable HttpMessageHandler standing in for Graph.</summary>
    private sealed class StubHandler : HttpMessageHandler
    {
        public int TokenCalls, ScopeCalls, ProcessCalls;
        public readonly List<JsonDocument> Bodies = new();
        public HttpStatusCode ProcessStatus = HttpStatusCode.OK;
        public object ProcessBody = new { };
        public string? ScopeEtag = "\"etag-1\"";
        public int FailTimes;
        public bool Hang;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
        {
            var url = req.RequestUri!.ToString();
            if (Hang)
            {
                await Task.Delay(TimeSpan.FromSeconds(30), ct); // cancelled by the guard's timeout
                throw new InvalidOperationException("unreachable");
            }

            HttpResponseMessage Json(HttpStatusCode code, object body)
            {
                var r = new HttpResponseMessage(code)
                {
                    Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
                };
                return r;
            }

            if (url.Contains("/oauth2/v2.0/token"))
            {
                Interlocked.Increment(ref TokenCalls);
                return Json(HttpStatusCode.OK, new { access_token = "mock-token", expires_in = 3600 });
            }
            if (url.Contains("/protectionScopes/compute"))
            {
                Interlocked.Increment(ref ScopeCalls);
                var r = Json(HttpStatusCode.OK, new { });
                if (ScopeEtag is not null) r.Headers.TryAddWithoutValidation("ETag", ScopeEtag);
                return r;
            }
            if (url.Contains("/processContent"))
            {
                Interlocked.Increment(ref ProcessCalls);
                Bodies.Add(JsonDocument.Parse(await req.Content!.ReadAsStringAsync(ct)));
                if (FailTimes > 0)
                {
                    FailTimes--;
                    var throttled = Json((HttpStatusCode)429, new { error = "throttled" });
                    throttled.Headers.TryAddWithoutValidation("Retry-After", "0");
                    return throttled;
                }
                return Json(ProcessStatus, ProcessBody);
            }
            return Json(HttpStatusCode.NotFound, new { });
        }
    }

    private static PurviewConfig Cfg(Action<PurviewConfigBuilder>? tweak = null)
    {
        var b = new PurviewConfigBuilder();
        tweak?.Invoke(b);
        return new PurviewConfig
        {
            Enabled = true,
            TenantId = "tenant",
            ClientId = "client",
            ClientSecret = "super-secret-value",
            AppLocation = "client",
            DefaultUserId = "user-1",
            FailClosed = b.FailClosed,
            MaxRetries = b.MaxRetries,
            Timeout = b.Timeout,
        };
    }

    private sealed class PurviewConfigBuilder
    {
        public bool FailClosed = true;
        public int MaxRetries = 3;
        public TimeSpan Timeout = TimeSpan.FromSeconds(10);
    }

    private static (PurviewGuard Guard, StubHandler Stub, List<string> Logs) Build(
        PurviewConfig cfg, StubHandler? stub = null)
    {
        stub ??= new StubHandler();
        var logs = new List<string>();
        var guard = new PurviewGuard(cfg, new HttpClient(stub), logs.Add, logs.Add);
        return (guard, stub, logs);
    }

    // ---------------- safe defaults ----------------
    [Fact]
    public void Enabled_And_FailClosed_By_Default()
    {
        var c = new PurviewConfig();
        Assert.True(c.Enabled);
        Assert.True(c.FailClosed);
    }

    [Fact]
    public void Empty_Config_Is_Misconfigured_Not_Disabled()
    {
        Assert.Equal(GuardState.Misconfigured, new PurviewConfig().State);
    }

    // ---------------- the silent no-op regression ----------------
    [Fact]
    public async Task Misconfigured_Blocks_And_Names_Missing_Vars()
    {
        var (guard, _, _) = Build(new PurviewConfig());
        var v = await guard.EvaluateAsync("credit card 4111111111111111", "uploadText");
        Assert.True(v.Blocked);
        Assert.False(v.Evaluated);
        Assert.Equal(DegradedReason.Misconfigured, v.Degraded);
        Assert.Contains("PURVIEW_TENANT_ID", v.Reason);
    }

    [Fact]
    public async Task Disabled_Allows_But_Reports_Why()
    {
        var (guard, _, _) = Build(new PurviewConfig { Enabled = false });
        var v = await guard.EvaluateAsync("x", "uploadText");
        Assert.False(v.Blocked);
        Assert.Equal(DegradedReason.Disabled, v.Degraded);
    }

    // ---------------- verdicts ----------------
    [Fact]
    public async Task Benign_Content_Is_Allowed()
    {
        var (guard, _, _) = Build(Cfg());
        var v = await guard.EvaluateAsync("hello", "uploadText");
        Assert.False(v.Blocked);
        Assert.True(v.Evaluated);
    }

    [Fact]
    public async Task Block_Action_Blocks()
    {
        var stub = new StubHandler
        {
            ProcessBody = new { policyActions = new[] { new { action = "restrictAccess", restrictionAction = "block" } } },
        };
        var (guard, _, _) = Build(Cfg(), stub);
        var v = await guard.EvaluateAsync("4111111111111111", "uploadText");
        Assert.True(v.Blocked);
        Assert.True(v.Evaluated);
    }

    [Fact]
    public async Task Block_Detection_Is_Case_Insensitive()
    {
        var stub = new StubHandler
        {
            ProcessBody = new { policyActions = new[] { new { action = "RestrictAccess", restrictionAction = "Block" } } },
        };
        var (guard, _, _) = Build(Cfg(), stub);
        Assert.True((await guard.EvaluateAsync("x", "uploadText")).Blocked);
    }

    // ---------------- resilience ----------------
    [Fact]
    public async Task Throttling_Is_Retried_Then_Succeeds()
    {
        var stub = new StubHandler { FailTimes = 2 };
        var (guard, _, _) = Build(Cfg(), stub);
        var v = await guard.EvaluateAsync("hi", "uploadText");
        Assert.True(v.Evaluated);
        Assert.Equal(3, stub.ProcessCalls);
    }

    [Fact]
    public async Task Hang_Times_Out_And_Fails_Closed()
    {
        var stub = new StubHandler { Hang = true };
        var (guard, _, _) = Build(Cfg(b => { b.Timeout = TimeSpan.FromSeconds(1); b.MaxRetries = 0; }), stub);
        var v = await guard.EvaluateAsync("hi", "uploadText");
        Assert.True(v.Blocked); // an unreachable governance plane must not allow
        Assert.Equal(DegradedReason.Error, v.Degraded);
    }

    [Fact]
    public async Task Fail_Open_Still_Available_When_Chosen()
    {
        var stub = new StubHandler { Hang = true };
        var (guard, _, _) = Build(
            Cfg(b => { b.Timeout = TimeSpan.FromSeconds(1); b.MaxRetries = 0; b.FailClosed = false; }), stub);
        var v = await guard.EvaluateAsync("hi", "uploadText");
        Assert.False(v.Blocked);
        Assert.Equal(DegradedReason.Error, v.Degraded);
    }

    [Fact]
    public async Task ServerError_Exhausts_Retries_And_Fails_Closed()
    {
        var stub = new StubHandler { ProcessStatus = HttpStatusCode.InternalServerError };
        var (guard, _, _) = Build(Cfg(b => b.MaxRetries = 1), stub);
        var v = await guard.EvaluateAsync("hi", "uploadText");
        Assert.True(v.Blocked);
        Assert.Equal(2, stub.ProcessCalls);
    }

    // ---------------- caching ----------------
    [Fact]
    public async Task Token_And_Scopes_Are_Cached()
    {
        var stub = new StubHandler();
        var (guard, _, _) = Build(Cfg(), stub);
        await guard.EvaluateAsync("one", "uploadText");
        await guard.EvaluateAsync("two", "downloadText");
        await guard.EvaluateAsync("three", "uploadText");
        Assert.Equal(1, stub.ScopeCalls);
        Assert.Equal(1, stub.TokenCalls);
    }

    [Fact]
    public async Task Missing_Etag_Is_Cached_Too()
    {
        var stub = new StubHandler { ScopeEtag = null };
        var (guard, _, _) = Build(Cfg(), stub);
        await guard.EvaluateAsync("one", "uploadText");
        await guard.EvaluateAsync("two", "uploadText");
        Assert.Equal(1, stub.ScopeCalls); // absence of an ETag must be cached
    }

    [Fact]
    public async Task Modified_Scope_State_Invalidates_Cache()
    {
        var stub = new StubHandler { ProcessBody = new { protectionScopeState = "modified" } };
        var (guard, _, _) = Build(Cfg(), stub);
        await guard.EvaluateAsync("one", "uploadText");
        await guard.EvaluateAsync("two", "uploadText");
        Assert.Equal(2, stub.ScopeCalls);
    }

    // ---------------- audit payload ----------------
    [Fact]
    public async Task No_Fabricated_Ip_Is_Sent()
    {
        var stub = new StubHandler();
        var (guard, _, _) = Build(Cfg(), stub);
        await guard.EvaluateAsync("hi", "uploadText");
        var dm = stub.Bodies[0].RootElement.GetProperty("contentToProcess").GetProperty("deviceMetadata");
        Assert.False(dm.TryGetProperty("ipAddress", out _)); // must not invent 127.0.0.1
    }

    [Fact]
    public async Task Real_Ip_Is_Forwarded()
    {
        var stub = new StubHandler();
        var (guard, _, _) = Build(Cfg(), stub);
        await guard.EvaluateAsync("hi", "uploadText", ipAddress: "203.0.113.7");
        var dm = stub.Bodies[0].RootElement.GetProperty("contentToProcess").GetProperty("deviceMetadata");
        Assert.Equal("203.0.113.7", dm.GetProperty("ipAddress").GetString());
    }

    [Fact]
    public async Task Timestamp_Has_Utc_Designator()
    {
        var stub = new StubHandler();
        var (guard, _, _) = Build(Cfg(), stub);
        await guard.EvaluateAsync("hi", "uploadText");
        var entry = stub.Bodies[0].RootElement
            .GetProperty("contentToProcess").GetProperty("contentEntries")[0];
        Assert.Matches(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", entry.GetProperty("createdDateTime").GetString());
    }

    // ---------------- secret hygiene ----------------
    [Fact]
    public async Task Secret_Never_Reaches_The_Log()
    {
        var stub = new StubHandler
        {
            ProcessStatus = HttpStatusCode.BadRequest,
            ProcessBody = new { error = "bad", client_secret = "super-secret-value" },
        };
        var (guard, _, logs) = Build(Cfg(b => b.MaxRetries = 0), stub);
        await guard.EvaluateAsync("hi", "uploadText");
        var joined = string.Join("\n", logs);
        Assert.NotEmpty(joined);
        Assert.DoesNotContain("super-secret-value", joined); // secret leaked into logs
        Assert.Contains("REDACTED", joined);
    }
}
