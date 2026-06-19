"""Configuration for the Agent 365 Governance Kit (Python)."""
from __future__ import annotations

import os
from dataclasses import dataclass


def _bool(v: str | None, default: bool = False) -> bool:
    if v is None:
        return default
    return v.lower() in ("true", "1", "yes")


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

    def ready(self) -> bool:
        return self.enabled and all(
            [self.tenant_id, self.client_id, self.client_secret, self.app_location, self.default_user_id]
        )


def load_config(env: dict | None = None) -> PurviewConfig:
    """Load Purview config from environment variables (same names as the .env the wizard writes)."""
    e = env if env is not None else os.environ
    return PurviewConfig(
        enabled=_bool(e.get("PURVIEW_ENABLED")),
        tenant_id=e.get("PURVIEW_TENANT_ID", ""),
        client_id=e.get("PURVIEW_CLIENT_ID", ""),
        client_secret=e.get("PURVIEW_CLIENT_SECRET", ""),
        app_location=e.get("PURVIEW_APP_LOCATION", e.get("PURVIEW_CLIENT_ID", "")),
        default_user_id=e.get("PURVIEW_USER_ID", ""),
        app_name=e.get("PURVIEW_APP_NAME", "Custom AI App"),
        fail_closed=_bool(e.get("PURVIEW_FAIL_CLOSED")),
    )
