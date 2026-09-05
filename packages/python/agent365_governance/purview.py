"""Microsoft Purview governance guard for any Python AI agent.

Wraps the two Microsoft Graph "Purview SDK" calls:
  1. protectionScopes/compute  - which policies apply to this user + activity.
  2. processContent            - submit the prompt/response for evaluation;
                                 returns policy actions (e.g. block) and captures
                                 the interaction for DSPM-for-AI / audit.

Drop into any agent: call guard.evaluate() on the inbound prompt before you call
the model, and on the model's reply before you return it. Channel-agnostic, no
Microsoft channel required. Zero dependencies (stdlib only).

Reliability contract:
  - Every HTTP call is bounded by config.timeout_s (no unbounded hangs).
  - 429 / 5xx / network errors are retried with backoff, honouring Retry-After.
  - When the guard cannot reach Purview it honours config.fail_closed
    (default True - block). It never silently allows.
"""
from __future__ import annotations

import json
import logging
import random
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone

from .config import PurviewConfig

Activity = str  # "uploadText" | "downloadText" | "uploadFile" | "downloadFile"

#: Scope the compute call to every activity we might submit.
_SCOPE_ACTIVITIES = "uploadText,downloadText,uploadFile,downloadFile"
_SCOPE_TTL_S = 55 * 60

log = logging.getLogger("agent365_governance.purview")

_SECRET_RE = re.compile(
    r'("?(?:client_secret|access_token|refresh_token|id_token)"?\s*[:=]\s*"?)[^"&,\s}]+',
    re.IGNORECASE,
)


def _redact(text: str, secret: str = "") -> str:
    """Strip anything secret-shaped out of text bound for a log."""
    out = text
    if secret and len(secret) > 4:
        out = out.replace(secret, "***REDACTED***")
    return _SECRET_RE.sub(r"\1***REDACTED***", out)


@dataclass
class EvalResult:
    blocked: bool
    evaluated: bool
    reason: str | None = None
    #: "disabled" | "misconfigured" | "error" whenever evaluated is False.
    degraded: str | None = None


def _retryable(status: int) -> bool:
    return status == 429 or status == 408 or 500 <= status <= 599


def _backoff(attempt: int, retry_after: str | None) -> float:
    if retry_after:
        try:
            return min(float(int(retry_after)), 30.0)
        except (TypeError, ValueError):
            pass
    return min(0.5 * (2 ** attempt), 8.0) + random.uniform(0, 0.25)


class PurviewGuard:
    def __init__(self, config: PurviewConfig):
        self.config = config
        self.graph = config.graph_base_url or "https://graph.microsoft.com/v1.0"
        self.login = config.login_base_url or "https://login.microsoftonline.com"
        self.state = config.state()
        self.ready = self.state == "ready"
        self.missing = config.missing()
        self._token = ""
        self._token_exp = 0.0
        self._scopes: dict[str, tuple[str, float]] = {}  # userId -> (etag, fetched_at)
        self._lock = threading.Lock()  # guards _token/_token_exp/_scopes

        # Announce the guard's disposition once, at construction, so a broken
        # deployment is obvious at startup rather than invisible at request time.
        if self.state == "disabled":
            log.warning(
                "[purview] guard DISABLED (PURVIEW_ENABLED=false). "
                "No prompts or replies will be governed."
            )
        elif self.state == "misconfigured":
            log.error(
                "[purview] guard MISCONFIGURED - missing %s. %s",
                ", ".join(self.missing),
                "fail_closed=True, so every evaluate() will BLOCK until this is fixed."
                if config.fail_closed
                else "fail_closed=False, so every evaluate() will ALLOW ungoverned. Fix the config.",
            )

    # ---------------- HTTP ----------------

    def _request(self, url: str, headers: dict, body: bytes, label: str) -> tuple[int, dict, str]:
        """POST with a hard timeout and bounded retries. Returns (status, headers, text)."""
        last_exc: Exception | None = None
        retry_after: str | None = None
        for attempt in range(self.config.max_retries + 1):
            if attempt:
                time.sleep(_backoff(attempt - 1, retry_after))
                retry_after = None
            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=self.config.timeout_s) as resp:
                    return resp.status, dict(resp.headers), resp.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as e:
                text = e.read().decode("utf-8", "replace")
                if _retryable(e.code) and attempt < self.config.max_retries:
                    retry_after = e.headers.get("Retry-After") if e.headers else None
                    last_exc = RuntimeError(f"{label} {e.code}")
                    continue
                return e.code, dict(e.headers or {}), text
            except Exception as e:  # URLError, socket.timeout, ssl errors
                last_exc = e
                if attempt >= self.config.max_retries:
                    break
        raise last_exc if last_exc else RuntimeError(f"{label} failed")

    def _get_token(self) -> str:
        with self._lock:
            now = time.time()
            if self._token and now < self._token_exp - 60:
                return self._token
        c = self.config
        body = urllib.parse.urlencode(
            {
                "client_id": c.client_id,
                "client_secret": c.client_secret,
                "scope": "https://graph.microsoft.com/.default",
                "grant_type": "client_credentials",
            }
        ).encode()
        status, _, text = self._request(
            f"{self.login}/{urllib.parse.quote(c.tenant_id)}/oauth2/v2.0/token",
            {"Content-Type": "application/x-www-form-urlencoded"},
            body,
            "token",
        )
        if status >= 400:
            raise RuntimeError(f"token {status}: {_redact(text, c.client_secret)}")
        data = json.loads(text)
        token = data.get("access_token")
        if not token:
            raise RuntimeError("token response contained no access_token")
        with self._lock:
            self._token = token
            self._token_exp = time.time() + int(data.get("expires_in", 3600))
        return token

    def _ensure_scopes(self, token: str, user_id: str) -> str:
        # NOTE: the absence of an ETag is cached too. Previously a missing ETag
        # made this recompute on every single evaluate() call.
        with self._lock:
            cached = self._scopes.get(user_id)
            if cached and time.time() - cached[1] < _SCOPE_TTL_S:
                return cached[0]
        body = json.dumps(
            {
                "activities": _SCOPE_ACTIVITIES,
                "locations": [
                    {
                        "@odata.type": "microsoft.graph.policyLocationApplication",
                        "value": self.config.app_location,
                    }
                ],
            }
        ).encode()
        status, headers, text = self._request(
            f"{self.graph}/users/{urllib.parse.quote(user_id)}/dataSecurityAndGovernance/protectionScopes/compute",
            {"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            body,
            "computeScopes",
        )
        if status >= 400:
            raise RuntimeError(f"computeScopes {status}: {_redact(text, self.config.client_secret)}")
        etag = headers.get("ETag", "")
        with self._lock:
            self._scopes[user_id] = (etag, time.time())
        return etag

    # ---------------- public API ----------------

    def evaluate(
        self,
        text: str,
        activity: Activity,
        user_id: str | None = None,
        correlation_id: str = "default",
        sequence_number: int = 0,
        ip_address: str | None = None,
    ) -> EvalResult:
        c = self.config
        if self.state == "disabled":
            return EvalResult(blocked=False, evaluated=False, degraded="disabled")
        if self.state == "misconfigured":
            return EvalResult(
                blocked=c.fail_closed,
                evaluated=False,
                degraded="misconfigured",
                reason=(
                    "Governance unavailable: Purview guard is misconfigured "
                    f"(missing {', '.join(self.missing)})."
                    if c.fail_closed
                    else None
                ),
            )

        uid = user_id or c.default_user_id
        try:
            token = self._get_token()
            etag = self._ensure_scopes(token, uid)
            # Full RFC3339 UTC instant. The previous format dropped the "Z",
            # leaving the timestamp without a timezone designator.
            now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
            if etag:
                headers["If-None-Match"] = etag

            # Only send an IP when we actually know one - a hardcoded 127.0.0.1
            # makes every audit record look like it came from localhost.
            device: dict[str, str] = {"deviceType": c.device_type}
            ip = ip_address or c.device_ip
            if ip:
                device["ipAddress"] = ip

            body = json.dumps(
                {
                    "contentToProcess": {
                        "contentEntries": [
                            {
                                "@odata.type": "microsoft.graph.processConversationMetadata",
                                "identifier": f"{correlation_id}-{sequence_number}",
                                "content": {"@odata.type": "microsoft.graph.textContent", "data": text},
                                "name": f"{c.app_name} message",
                                "correlationId": correlation_id,
                                "sequenceNumber": sequence_number,
                                "isTruncated": False,
                                "createdDateTime": now_iso,
                                "modifiedDateTime": now_iso,
                            }
                        ],
                        "activityMetadata": {"activity": activity},
                        "deviceMetadata": device,
                        "protectedAppMetadata": {
                            "name": c.app_name,
                            "version": "1.0",
                            "applicationLocation": {
                                "@odata.type": "microsoft.graph.policyLocationApplication",
                                "value": c.app_location,
                            },
                        },
                        "integratedAppMetadata": {"name": c.app_name, "version": "1.0"},
                    }
                }
            ).encode()
            status, _, raw = self._request(
                f"{self.graph}/users/{urllib.parse.quote(uid)}/dataSecurityAndGovernance/processContent",
                headers,
                body,
                "processContent",
            )
            if status >= 400:
                raise RuntimeError(f"processContent {status}: {_redact(raw, c.client_secret)}")
            data = json.loads(raw) if raw else {}

            if data.get("protectionScopeState") == "modified":
                with self._lock:
                    self._scopes.pop(uid, None)

            actions = data.get("policyActions", []) or []
            for a in actions:
                if (a.get("action") or "").lower() == "restrictaccess" and (
                    a.get("restrictionAction") or ""
                ).lower() == "block":
                    return EvalResult(
                        blocked=True,
                        evaluated=True,
                        reason="Blocked by a Microsoft Purview data-loss-prevention policy.",
                    )
            # Surface restriction actions we don't recognise instead of silently allowing.
            for a in actions:
                if (a.get("action") or "").lower() == "restrictaccess":
                    log.warning(
                        '[purview] unhandled restrictionAction "%s" - allowing. Review policy mapping.',
                        a.get("restrictionAction"),
                    )
            return EvalResult(blocked=False, evaluated=True)
        except Exception as err:  # noqa: BLE001 - fail open/closed by policy
            log.error("[purview] evaluate(%s) failed: %s", activity, _redact(str(err), c.client_secret))
            return EvalResult(
                blocked=c.fail_closed,
                evaluated=False,
                degraded="error",
                reason="Governance check unavailable." if c.fail_closed else None,
            )
