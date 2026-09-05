namespace ZaatarLabs.Agent365.Governance;

/// <summary>Guard lifecycle state.</summary>
public enum GuardState
{
    /// <summary>Fully configured and enabled — evaluating live.</summary>
    Ready,
    /// <summary>Deliberately switched off (PURVIEW_ENABLED=false).</summary>
    Disabled,
    /// <summary>Enabled but missing required values. Treated as a failure, not as "off".</summary>
    Misconfigured,
}

/// <summary>
/// Configuration for the Purview guard. Loaded from the same env vars the wizard writes.
///
/// SAFE DEFAULTS (v0.2): the guard is ENABLED and FAIL-CLOSED unless you say
/// otherwise. Forgetting to set an env var can no longer silently disable
/// governance — it produces a loud, blocking misconfiguration instead.
/// </summary>
public sealed class PurviewConfig
{
    /// <summary>Defaults to true. Set PURVIEW_ENABLED=false to deliberately opt out.</summary>
    public bool Enabled { get; init; } = true;
    public string TenantId { get; init; } = "";
    public string ClientId { get; init; } = "";
    public string ClientSecret { get; init; } = "";
    public string AppLocation { get; init; } = "";
    /// <summary>
    /// Entra object id every interaction is attributed to. For a multi-user app,
    /// pass the real signed-in user per call — attributing everyone's traffic to
    /// one object id makes the DSPM/audit trail misleading.
    /// </summary>
    public string DefaultUserId { get; init; } = "";
    public string AppName { get; init; } = "Custom AI App";
    /// <summary>Defaults to TRUE. An unreachable governance plane must not mean "allow".</summary>
    public bool FailClosed { get; init; } = true;
    /// <summary>Per-HTTP-request timeout. Default 10s.</summary>
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(10);
    /// <summary>Retries for throttling (429) and transient 5xx. Default 3.</summary>
    public int MaxRetries { get; init; } = 3;
    public string DeviceType { get; init; } = "Unmanaged";
    /// <summary>
    /// Client IP reported to Purview. Empty => the field is OMITTED rather than
    /// sent as a fake 127.0.0.1. Pass the real caller IP per call instead.
    /// </summary>
    public string DeviceIp { get; init; } = "";

    private static readonly (string Env, Func<PurviewConfig, string> Get)[] RequiredFields =
    {
        ("PURVIEW_TENANT_ID",     c => c.TenantId),
        ("PURVIEW_CLIENT_ID",     c => c.ClientId),
        ("PURVIEW_CLIENT_SECRET", c => c.ClientSecret),
        ("PURVIEW_APP_LOCATION",  c => c.AppLocation),
        ("PURVIEW_USER_ID",       c => c.DefaultUserId),
    };

    /// <summary>Env var names that are required but empty. Empty = complete.</summary>
    public IReadOnlyList<string> Missing =>
        RequiredFields.Where(f => string.IsNullOrWhiteSpace(f.Get(this))).Select(f => f.Env).ToList();

    public bool Ready => Enabled && Missing.Count == 0;

    /// <summary>Lets callers tell a deliberate opt-out apart from a broken deployment.</summary>
    public GuardState State =>
        !Enabled ? GuardState.Disabled : (Missing.Count == 0 ? GuardState.Ready : GuardState.Misconfigured);

    private static readonly string[] TrueValues = { "true", "1", "yes", "on" };
    private static readonly string[] FalseValues = { "false", "0", "no", "off" };

    private static bool Bool(string? v, bool dflt)
    {
        if (string.IsNullOrWhiteSpace(v)) return dflt;
        var s = v.Trim().ToLowerInvariant();
        if (TrueValues.Contains(s)) return true;
        if (FalseValues.Contains(s)) return false;
        return dflt;
    }

    private static int Int(string? v, int dflt, int lo, int hi) =>
        int.TryParse(v, out var n) ? Math.Clamp(n, lo, hi) : dflt;

    /// <summary>Load configuration from environment variables.</summary>
    public static PurviewConfig FromEnvironment()
    {
        string? Get(string k) => Environment.GetEnvironmentVariable(k);
        return new PurviewConfig
        {
            // Default ON. Silence-is-governance is the failure mode we're designing out.
            Enabled = Bool(Get("PURVIEW_ENABLED"), true),
            TenantId = Get("PURVIEW_TENANT_ID") ?? "",
            ClientId = Get("PURVIEW_CLIENT_ID") ?? "",
            ClientSecret = Get("PURVIEW_CLIENT_SECRET") ?? "",
            AppLocation = string.IsNullOrWhiteSpace(Get("PURVIEW_APP_LOCATION"))
                ? Get("PURVIEW_CLIENT_ID") ?? ""
                : Get("PURVIEW_APP_LOCATION")!,
            DefaultUserId = Get("PURVIEW_USER_ID") ?? "",
            AppName = Get("PURVIEW_APP_NAME") ?? "Custom AI App",
            // Default CLOSED.
            FailClosed = Bool(Get("PURVIEW_FAIL_CLOSED"), true),
            Timeout = TimeSpan.FromMilliseconds(Int(Get("PURVIEW_TIMEOUT_MS"), 10_000, 1_000, 120_000)),
            MaxRetries = Int(Get("PURVIEW_MAX_RETRIES"), 3, 0, 10),
            DeviceType = Get("PURVIEW_DEVICE_TYPE") ?? "Unmanaged",
            DeviceIp = Get("PURVIEW_DEVICE_IP") ?? "",
        };
    }
}

/// <summary>Why an evaluation did not reach Purview.</summary>
public enum DegradedReason { None, Disabled, Misconfigured, Error }

/// <summary>Result of a single Purview evaluation.</summary>
public readonly record struct EvalResult(
    bool Blocked,
    bool Evaluated,
    string? Reason = null,
    DegradedReason Degraded = DegradedReason.None);
