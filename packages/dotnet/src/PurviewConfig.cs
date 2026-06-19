namespace ZaatarLabs.Agent365.Governance;

/// <summary>Configuration for the Purview guard. Loaded from the same env vars the wizard writes.</summary>
public sealed class PurviewConfig
{
    public bool Enabled { get; init; }
    public string TenantId { get; init; } = "";
    public string ClientId { get; init; } = "";
    public string ClientSecret { get; init; } = "";
    public string AppLocation { get; init; } = "";
    public string DefaultUserId { get; init; } = "";
    public string AppName { get; init; } = "Custom AI App";
    public bool FailClosed { get; init; }

    public bool Ready =>
        Enabled
        && !string.IsNullOrEmpty(TenantId)
        && !string.IsNullOrEmpty(ClientId)
        && !string.IsNullOrEmpty(ClientSecret)
        && !string.IsNullOrEmpty(AppLocation)
        && !string.IsNullOrEmpty(DefaultUserId);

    private static bool Bool(string? v) =>
        v is not null && (v.Equals("true", StringComparison.OrdinalIgnoreCase) || v == "1");

    /// <summary>Load configuration from environment variables.</summary>
    public static PurviewConfig FromEnvironment()
    {
        string? Get(string k) => Environment.GetEnvironmentVariable(k);
        return new PurviewConfig
        {
            Enabled = Bool(Get("PURVIEW_ENABLED")),
            TenantId = Get("PURVIEW_TENANT_ID") ?? "",
            ClientId = Get("PURVIEW_CLIENT_ID") ?? "",
            ClientSecret = Get("PURVIEW_CLIENT_SECRET") ?? "",
            AppLocation = Get("PURVIEW_APP_LOCATION") ?? Get("PURVIEW_CLIENT_ID") ?? "",
            DefaultUserId = Get("PURVIEW_USER_ID") ?? "",
            AppName = Get("PURVIEW_APP_NAME") ?? "Custom AI App",
            FailClosed = Bool(Get("PURVIEW_FAIL_CLOSED")),
        };
    }
}

/// <summary>Result of a single Purview evaluation.</summary>
public readonly record struct EvalResult(bool Blocked, bool Evaluated, string? Reason = null);
