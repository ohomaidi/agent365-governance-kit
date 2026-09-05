"""Configuration for the Agent 365 Governance Kit (Python).

SAFE DEFAULTS (v0.2): the guard is ENABLED and FAIL-CLOSED unless you say
otherwise. Forgetting to set an env var can no longer silently disable
governance — it produces a loud, blocking misconfiguration instead.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

# Required env vars for live calls, in the order we report them.
_REQUIRED = (
    ("tenant_id", "PURVIEW_TENANT_ID"),
    ("client_id", "PURVIEW_CLIENT_ID"),
    ("client_secret", "PURVIEW_CLIENT_SECRET"),
    ("app_location", "PURVIEW_APP_LOCATION"),
    ("default_user_id", "PURVIEW_USER_ID"),
)

_TRUE = ("true", "1", "yes", "on")
_FALSE = ("false", "0", "no", "off")


def _bool(v: str | None, default: bool) -> bool:
    if v is None or v.strip() == "":
        return default
    s = v.strip().lower()
    if s in _TRUE:
        return True
    if s in _FALSE:
        return False
    return default


def _int(v: str | None, default: int, lo: int, hi: int) -> int:
    if v is None or v.strip() == "":
        return default
    try:
        return max(lo, min(hi, int(v)))
    except ValueError:
        return default


@dataclass
class PurviewConfig:
    enabled: bool
    tenant_id: str
    client_id: str
    client_secret: str
    app_location: str
    default_user_id: str
    app_name: str
    fail_closed: bool
    timeout_s: float = 10.0
    max_retries: int = 3
    device_type: str = "Unmanaged"
    #: Client IP reported to Purview. Empty => the field is OMITTED rather than
    #: sent as a fake 127.0.0.1. Pass the real caller IP per call instead.
    device_ip: str = ""
    #: Override only for testing against a mock.
    graph_base_url: str = "https://graph.microsoft.com/v1.0"
    login_base_url: str = "https://login.microsoftonline.com"

    def missing(self) -> list[str]:
        """Env var names that are required but empty. Empty list = complete."""
        return [env for attr, env in _REQUIRED if not str(getattr(self, attr) or "").strip()]

    def ready(self) -> bool:
        return self.enabled and not self.missing()

    def state(self) -> str:
        """'ready' | 'disabled' | 'misconfigured' — lets callers tell off from broken."""
        if not self.enabled:
            return "disabled"
        return "ready" if not self.missing() else "misconfigured"


def load_config(env: dict | None = None) -> PurviewConfig:
    """Load Purview config from environment variables (same names as the .env the wizard writes)."""
    e = env if env is not None else os.environ
    return PurviewConfig(
        # Default ON. Silence-is-governance is the failure mode we're designing out.
        enabled=_bool(e.get("PURVIEW_ENABLED"), True),
        tenant_id=e.get("PURVIEW_TENANT_ID", ""),
        client_id=e.get("PURVIEW_CLIENT_ID", ""),
        client_secret=e.get("PURVIEW_CLIENT_SECRET", ""),
        app_location=e.get("PURVIEW_APP_LOCATION", "") or e.get("PURVIEW_CLIENT_ID", ""),
        default_user_id=e.get("PURVIEW_USER_ID", ""),
        app_name=e.get("PURVIEW_APP_NAME", "Custom AI App"),
        # Default CLOSED. An unreachable governance plane must not mean "allow".
        fail_closed=_bool(e.get("PURVIEW_FAIL_CLOSED"), True),
        timeout_s=_int(e.get("PURVIEW_TIMEOUT_MS"), 10_000, 1_000, 120_000) / 1000.0,
        max_retries=_int(e.get("PURVIEW_MAX_RETRIES"), 3, 0, 10),
        device_type=e.get("PURVIEW_DEVICE_TYPE", "Unmanaged"),
        device_ip=e.get("PURVIEW_DEVICE_IP", ""),
        graph_base_url=e.get("PURVIEW_GRAPH_BASE_URL", "https://graph.microsoft.com/v1.0"),
        login_base_url=e.get("PURVIEW_LOGIN_BASE_URL", "https://login.microsoftonline.com"),
    )
