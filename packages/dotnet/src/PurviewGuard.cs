using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

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
/// </summary>
public sealed class PurviewGuard
{
    private const string Graph = "https://graph.microsoft.com/v1.0";
    private static readonly TimeSpan ScopeTtl = TimeSpan.FromMinutes(55);

    private readonly PurviewConfig _cfg;
    private readonly HttpClient _http;
    public bool Ready => _cfg.Ready;

    private string _token = "";
    private DateTimeOffset _tokenExp = DateTimeOffset.MinValue;
    private readonly ConcurrentDictionary<string, (string Etag, DateTimeOffset At)> _scopes = new();

    public PurviewGuard(PurviewConfig config, HttpClient? http = null)
    {
        _cfg = config;
        _http = http ?? new HttpClient();
    }

    private async Task<string> GetTokenAsync(CancellationToken ct)
    {
        if (!string.IsNullOrEmpty(_token) && DateTimeOffset.UtcNow < _tokenExp.AddMinutes(-1))
            return _token;

        var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = _cfg.ClientId,
            ["client_secret"] = _cfg.ClientSecret,
            ["scope"] = "https://graph.microsoft.com/.default",
            ["grant_type"] = "client_credentials",
        });
        var resp = await _http.PostAsync(
            $"https://login.microsoftonline.com/{_cfg.TenantId}/oauth2/v2.0/token", form, ct);
        var body = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode) throw new InvalidOperationException($"token {(int)resp.StatusCode}: {body}");
        using var doc = JsonDocument.Parse(body);
        _token = doc.RootElement.GetProperty("access_token").GetString()!;
        _tokenExp = DateTimeOffset.UtcNow.AddSeconds(doc.RootElement.GetProperty("expires_in").GetInt32());
        return _token;
    }

    private async Task<string> EnsureScopesAsync(string token, string userId, CancellationToken ct)
    {
        if (_scopes.TryGetValue(userId, out var c) && !string.IsNullOrEmpty(c.Etag)
            && DateTimeOffset.UtcNow - c.At < ScopeTtl)
            return c.Etag;

        var payload = JsonSerializer.Serialize(new
        {
            activities = "uploadText,downloadText",
            locations = new[] { new Dictionary<string, string>
            {
                ["@odata.type"] = "microsoft.graph.policyLocationApplication",
                ["value"] = _cfg.AppLocation,
            }},
        });
        using var req = new HttpRequestMessage(HttpMethod.Post,
            $"{Graph}/users/{userId}/dataSecurityAndGovernance/protectionScopes/compute")
        { Content = new StringContent(payload, Encoding.UTF8, "application/json") };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var resp = await _http.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"computeScopes {(int)resp.StatusCode}: {await resp.Content.ReadAsStringAsync(ct)}");
        var etag = resp.Headers.ETag?.Tag ?? "";
        _scopes[userId] = (etag, DateTimeOffset.UtcNow);
        return etag;
    }

    /// <param name="activity">"uploadText" (prompt) or "downloadText" (reply).</param>
    public async Task<EvalResult> EvaluateAsync(
        string text,
        string activity,
        string? userId = null,
        string correlationId = "default",
        int sequenceNumber = 0,
        CancellationToken ct = default)
    {
        if (!Ready) return new EvalResult(false, false);
        var uid = userId ?? _cfg.DefaultUserId;
        try
        {
            var token = await GetTokenAsync(ct);
            var etag = await EnsureScopesAsync(token, uid, ct);
            var nowIso = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss");

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
                    deviceMetadata = new { deviceType = "Unmanaged", ipAddress = "127.0.0.1" },
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

            using var req = new HttpRequestMessage(HttpMethod.Post,
                $"{Graph}/users/{uid}/dataSecurityAndGovernance/processContent")
            { Content = new StringContent(payload, Encoding.UTF8, "application/json") };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            if (!string.IsNullOrEmpty(etag)) req.Headers.TryAddWithoutValidation("If-None-Match", etag);

            var resp = await _http.SendAsync(req, ct);
            var raw = await resp.Content.ReadAsStringAsync(ct);
            if (!resp.IsSuccessStatusCode)
                throw new InvalidOperationException($"processContent {(int)resp.StatusCode}: {raw}");

            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            if (root.TryGetProperty("protectionScopeState", out var st) && st.GetString() == "modified")
                _scopes.TryRemove(uid, out _);

            if (root.TryGetProperty("policyActions", out var actions))
            {
                foreach (var a in actions.EnumerateArray())
                {
                    var action = a.TryGetProperty("action", out var ac) ? ac.GetString() : null;
                    var restrict = a.TryGetProperty("restrictionAction", out var ra) ? ra.GetString() : null;
                    if (action == "restrictAccess" && restrict == "block")
                        return new EvalResult(true, true, "Blocked by a Microsoft Purview data-loss-prevention policy.");
                }
            }
            return new EvalResult(false, true);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[purview] EvaluateAsync({activity}) failed: {ex.Message}");
            return new EvalResult(_cfg.FailClosed, false, _cfg.FailClosed ? "Governance check unavailable." : null);
        }
    }
}
