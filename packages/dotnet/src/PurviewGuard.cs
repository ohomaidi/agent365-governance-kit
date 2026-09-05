using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ZaatarLabs.Agent365.Governance;

/// <summary>
/// Microsoft Purview governance guard for any .NET AI agent.
///
/// Wraps the two Microsoft Graph "Purview SDK" calls:
///   1. protectionScopes/compute — which policies apply to this user + activity.
///   2. processContent           — submit the prompt/response for evaluation;
///      returns policy actions (e.g. block) and captures the interaction for DSPM/audit.
///
/// Drop into any agent: call EvaluateAsync() on the inbound prompt before calling
/// the model, and on the reply before returning it. Channel-agnostic.
///
/// Reliability contract:
///   - Every HTTP call is bounded by config.Timeout (no unbounded hangs).
///   - 429 / 5xx / network errors are retried with backoff, honouring Retry-After.
///   - When the guard cannot reach Purview it honours config.FailClosed
///     (default TRUE — block). It never silently allows.
/// </summary>
public sealed class PurviewGuard
{
    private const string Graph = "https://graph.microsoft.com/v1.0";
    private const string Login = "https://login.microsoftonline.com";
    private static readonly TimeSpan ScopeTtl = TimeSpan.FromMinutes(55);

    /// <summary>Scope the compute call to every activity we might submit.</summary>
    private const string ScopeActivities = "uploadText,downloadText,uploadFile,downloadFile";

    /// <summary>
    /// Shared by default so callers that construct a guard per request don't
    /// exhaust sockets. Pass your own IHttpClientFactory-managed client to override.
    /// </summary>
    private static readonly HttpClient SharedHttp = new();

    private static readonly Regex SecretRe = new(
        @"(""?(?:client_secret|access_token|refresh_token|id_token)""?\s*[:=]\s*""?)[^""&,\s}]+",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private readonly PurviewConfig _cfg;
    private readonly HttpClient _http;
    private readonly Action<string> _logError;
    private readonly Action<string> _logWarn;

    public bool Ready => _cfg.Ready;
    public GuardState State => _cfg.State;
    public IReadOnlyList<string> Missing => _cfg.Missing;

    private string _token = "";
    private DateTimeOffset _tokenExp = DateTimeOffset.MinValue;
    private readonly SemaphoreSlim _tokenLock = new(1, 1);
    private readonly ConcurrentDictionary<string, (string Etag, DateTimeOffset At)> _scopes = new();

    public PurviewGuard(
        PurviewConfig config,
        HttpClient? http = null,
        Action<string>? logError = null,
        Action<string>? logWarn = null)
    {
        _cfg = config;
        _http = http ?? SharedHttp;
        _logError = logError ?? Console.Error.WriteLine;
        _logWarn = logWarn ?? Console.Error.WriteLine;

        // Announce the guard's disposition once, at construction, so a broken
        // deployment is obvious at startup rather than invisible at request time.
        if (State == GuardState.Disabled)
        {
            _logWarn("[purview] guard DISABLED (PURVIEW_ENABLED=false). No prompts or replies will be governed.");
        }
        else if (State == GuardState.Misconfigured)
        {
            _logError($"[purview] guard MISCONFIGURED — missing {string.Join(", ", Missing)}. " +
                (_cfg.FailClosed
                    ? "FailClosed=true, so every EvaluateAsync() will BLOCK until this is fixed."
                    : "FailClosed=false, so every EvaluateAsync() will ALLOW ungoverned. Fix the config."));
        }
    }

    /// <summary>Strip anything secret-shaped out of text bound for a log.</summary>
    private string Redact(string text)
    {
        var outText = text;
        if (!string.IsNullOrEmpty(_cfg.ClientSecret) && _cfg.ClientSecret.Length > 4)
            outText = outText.Replace(_cfg.ClientSecret, "***REDACTED***");
        return SecretRe.Replace(outText, "$1***REDACTED***");
    }

    private static bool Retryable(HttpStatusCode s) =>
        (int)s == 429 || (int)s == 408 || ((int)s >= 500 && (int)s <= 599);

    private static TimeSpan Backoff(int attempt, RetryConditionHeaderValue? retryAfter)
    {
        if (retryAfter?.Delta is { } d && d > TimeSpan.Zero)
            return d > TimeSpan.FromSeconds(30) ? TimeSpan.FromSeconds(30) : d;
        var ms = Math.Min(500 * Math.Pow(2, attempt), 8_000);
        return TimeSpan.FromMilliseconds(ms + Random.Shared.Next(0, 250));
    }

    /// <summary>
    /// POST with a hard timeout and bounded retries. Returns (status, headers, body).
    /// Takes a content FACTORY, not an instance: HttpContent is disposed together
    /// with its HttpRequestMessage, so each retry needs a freshly built body.
    /// </summary>
    private async Task<(HttpStatusCode Status, HttpResponseHeaders Headers, string Body)> RequestAsync(
        string url, Func<HttpContent> contentFactory, string? bearer, string? ifNoneMatch, string label, CancellationToken ct)
    {
        Exception? lastExc = null;
        RetryConditionHeaderValue? retryAfter = null;

        for (var attempt = 0; attempt <= _cfg.MaxRetries; attempt++)
        {
            if (attempt > 0)
            {
                await Task.Delay(Backoff(attempt - 1, retryAfter), ct);
                retryAfter = null;
            }

            using var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = contentFactory() };
            if (bearer is not null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
            if (!string.IsNullOrEmpty(ifNoneMatch)) req.Headers.TryAddWithoutValidation("If-None-Match", ifNoneMatch);

            // Bound each attempt by _cfg.Timeout without cancelling the caller's token.
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(_cfg.Timeout);
            try
            {
                var resp = await _http.SendAsync(req, timeoutCts.Token);
                var body = await resp.Content.ReadAsStringAsync(timeoutCts.Token);
                if (Retryable(resp.StatusCode) && attempt < _cfg.MaxRetries)
                {
                    retryAfter = resp.Headers.RetryAfter;
                    lastExc = new HttpRequestException($"{label} {(int)resp.StatusCode}");
                    resp.Dispose();
                    continue;
                }
                return (resp.StatusCode, resp.Headers, body);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw; // caller cancelled — don't retry
            }
            catch (Exception ex) // timeout (OperationCanceled from our CTS), socket, DNS, TLS
            {
                lastExc = ex is OperationCanceledException
                    ? new TimeoutException($"{label} timed out after {_cfg.Timeout.TotalMilliseconds}ms", ex)
                    : ex;
                if (attempt >= _cfg.MaxRetries) break;
            }
        }
        throw lastExc ?? new HttpRequestException($"{label} failed");
    }

    private async Task<string> GetTokenAsync(CancellationToken ct)
    {
        if (!string.IsNullOrEmpty(_token) && DateTimeOffset.UtcNow < _tokenExp.AddMinutes(-1))
            return _token;

        // Single-flight: concurrent turns share one refresh.
        await _tokenLock.WaitAsync(ct);
        try
        {
            if (!string.IsNullOrEmpty(_token) && DateTimeOffset.UtcNow < _tokenExp.AddMinutes(-1))
                return _token;

            var (status, _, body) = await RequestAsync(
                $"{Login}/{Uri.EscapeDataString(_cfg.TenantId)}/oauth2/v2.0/token",
                () => new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["client_id"] = _cfg.ClientId,
                    ["client_secret"] = _cfg.ClientSecret,
                    ["scope"] = "https://graph.microsoft.com/.default",
                    ["grant_type"] = "client_credentials",
                }),
                bearer: null, ifNoneMatch: null, "token", ct);
            if ((int)status >= 400) throw new InvalidOperationException($"token {(int)status}: {Redact(body)}");

            using var doc = JsonDocument.Parse(body);
            var token = doc.RootElement.TryGetProperty("access_token", out var at) ? at.GetString() : null;
            if (string.IsNullOrEmpty(token))
                throw new InvalidOperationException("token response contained no access_token");
            var expires = doc.RootElement.TryGetProperty("expires_in", out var ei) ? ei.GetInt32() : 3600;
            _token = token!;
            _tokenExp = DateTimeOffset.UtcNow.AddSeconds(expires);
            return _token;
        }
        finally { _tokenLock.Release(); }
    }

    private async Task<string> EnsureScopesAsync(string token, string userId, CancellationToken ct)
    {
        // NOTE: the absence of an ETag is cached too. Previously a missing ETag
        // made this recompute on every single EvaluateAsync() call.
        if (_scopes.TryGetValue(userId, out var c) && DateTimeOffset.UtcNow - c.At < ScopeTtl)
            return c.Etag;

        var payload = JsonSerializer.Serialize(new
        {
            activities = ScopeActivities,
            locations = new[] { new Dictionary<string, string>
            {
                ["@odata.type"] = "microsoft.graph.policyLocationApplication",
                ["value"] = _cfg.AppLocation,
            }},
        });
        var (status, headers, body) = await RequestAsync(
            $"{Graph}/users/{Uri.EscapeDataString(userId)}/dataSecurityAndGovernance/protectionScopes/compute",
            () => new StringContent(payload, Encoding.UTF8, "application/json"),
            token, ifNoneMatch: null, "computeScopes", ct);
        if ((int)status >= 400)
            throw new InvalidOperationException($"computeScopes {(int)status}: {Redact(body)}");

        var etag = headers.ETag?.Tag ?? "";
        _scopes[userId] = (etag, DateTimeOffset.UtcNow);
        return etag;
    }

    /// <param name="activity">"uploadText" (prompt) or "downloadText" (reply).</param>
    /// <param name="ipAddress">Real client IP. Omitted from the payload when null/empty.</param>
    public async Task<EvalResult> EvaluateAsync(
        string text,
        string activity,
        string? userId = null,
        string correlationId = "default",
        int sequenceNumber = 0,
        string? ipAddress = null,
        CancellationToken ct = default)
    {
        if (State == GuardState.Disabled)
            return new EvalResult(false, false, null, DegradedReason.Disabled);

        if (State == GuardState.Misconfigured)
            return new EvalResult(
                _cfg.FailClosed, false,
                _cfg.FailClosed
                    ? $"Governance unavailable: Purview guard is misconfigured (missing {string.Join(", ", Missing)})."
                    : null,
                DegradedReason.Misconfigured);

        var uid = userId ?? _cfg.DefaultUserId;
        try
        {
            var token = await GetTokenAsync(ct);
            var etag = await EnsureScopesAsync(token, uid, ct);
            // Full RFC3339 UTC instant. The previous format dropped the "Z",
            // leaving the timestamp without a timezone designator.
            var nowIso = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss'Z'");

            // Only send an IP when we actually know one — a hardcoded 127.0.0.1
            // makes every audit record look like it came from localhost.
            var device = new Dictionary<string, string> { ["deviceType"] = _cfg.DeviceType };
            var ip = string.IsNullOrWhiteSpace(ipAddress) ? _cfg.DeviceIp : ipAddress;
            if (!string.IsNullOrWhiteSpace(ip)) device["ipAddress"] = ip!;

            var payload = JsonSerializer.Serialize(new
            {
                contentToProcess = new
                {
                    contentEntries = new object[]
                    {
                        new Dictionary<string, object>
                        {
                            ["@odata.type"] = "microsoft.graph.processConversationMetadata",
                            ["identifier"] = $"{correlationId}-{sequenceNumber}",
                            ["content"] = new Dictionary<string, string>
                            {
                                ["@odata.type"] = "microsoft.graph.textContent",
                                ["data"] = text,
                            },
                            ["name"] = $"{_cfg.AppName} message",
                            ["correlationId"] = correlationId,
                            ["sequenceNumber"] = sequenceNumber,
                            ["isTruncated"] = false,
                            ["createdDateTime"] = nowIso,
                            ["modifiedDateTime"] = nowIso,
                        },
                    },
                    activityMetadata = new { activity },
                    deviceMetadata = device,
                    protectedAppMetadata = new
                    {
                        name = _cfg.AppName,
                        version = "1.0",
                        applicationLocation = new Dictionary<string, string>
                        {
                            ["@odata.type"] = "microsoft.graph.policyLocationApplication",
                            ["value"] = _cfg.AppLocation,
                        },
                    },
                    integratedAppMetadata = new { name = _cfg.AppName, version = "1.0" },
                },
            });

            var (status, _, raw) = await RequestAsync(
                $"{Graph}/users/{Uri.EscapeDataString(uid)}/dataSecurityAndGovernance/processContent",
                () => new StringContent(payload, Encoding.UTF8, "application/json"),
                token, etag, "processContent", ct);
            if ((int)status >= 400)
                throw new InvalidOperationException($"processContent {(int)status}: {Redact(raw)}");

            if (string.IsNullOrWhiteSpace(raw)) return new EvalResult(false, true);

            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            if (root.TryGetProperty("protectionScopeState", out var st) && st.GetString() == "modified")
                _scopes.TryRemove(uid, out _);

            if (root.TryGetProperty("policyActions", out var actions) && actions.ValueKind == JsonValueKind.Array)
            {
                foreach (var a in actions.EnumerateArray())
                {
                    var action = a.TryGetProperty("action", out var ac) ? ac.GetString() : null;
                    var restrict = a.TryGetProperty("restrictionAction", out var ra) ? ra.GetString() : null;
                    if (!string.Equals(action, "restrictAccess", StringComparison.OrdinalIgnoreCase)) continue;

                    if (string.Equals(restrict, "block", StringComparison.OrdinalIgnoreCase))
                        return new EvalResult(true, true, "Blocked by a Microsoft Purview data-loss-prevention policy.");

                    // Surface restriction actions we don't recognise instead of silently allowing.
                    _logWarn($"[purview] unhandled restrictionAction \"{restrict}\" — allowing. Review policy mapping.");
                }
            }
            return new EvalResult(false, true);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logError($"[purview] EvaluateAsync({activity}) failed: {Redact(ex.Message)}");
            return new EvalResult(
                _cfg.FailClosed, false,
                _cfg.FailClosed ? "Governance check unavailable." : null,
                DegradedReason.Error);
        }
    }
}
