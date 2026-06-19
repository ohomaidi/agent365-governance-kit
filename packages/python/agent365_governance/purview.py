"""
Microsoft Purview governance guard for any Python AI agent.

Wraps the two Microsoft Graph "Purview SDK" calls:
  1. protectionScopes/compute  - which policies apply to this user + activity.
  2. processContent            - submit the prompt/response for evaluation;
                                 returns policy actions (e.g. block) and captures
                                 the interaction for DSPM-for-AI / audit.

Drop into any agent: call guard.evaluate() on the inbound prompt before you call
the model, and on the model's reply before you return it. Channel-agnostic, no
Microsoft channel required. Zero dependencies (stdlib only).
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone

from .config import PurviewConfig

GRAPH = "https://graph.microsoft.com/v1.0"
Activity = str  # "uploadText" | "downloadText" | "uploadFile" | "downloadFile"


@dataclass
class EvalResult:
    blocked: bool
    evaluated: bool
    reason: str | None = None


def _post(url: str, headers: dict, body: bytes) -> tuple[int, dict, dict]:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, dict(resp.headers), (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "ignore")
        raise RuntimeError(f"{e.code}: {raw}") from None


class PurviewGuard:
    def __init__(self, config: PurviewConfig):
        self.config = config
        self.ready = config.ready()
        self._token = ""
        self._token_exp = 0.0
        self._scopes: dict[str, tuple[str, float]] = {}  # userId -> (etag, fetched_at)
        self._scope_ttl = 55 * 60

    def _get_token(self) -> str:
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
        status, _, data = _post(
            f"https://login.microsoftonline.com/{c.tenant_id}/oauth2/v2.0/token",
            {"Content-Type": "application/x-www-form-urlencoded"},
            body,
        )
        self._token = data["access_token"]
        self._token_exp = now + int(data["expires_in"])
        return self._token

    def _ensure_scopes(self, token: str, user_id: str) -> str:
        cached = self._scopes.get(user_id)
        if cached and cached[0] and time.time() - cached[1] < self._scope_ttl:
            return cached[0]
        body = json.dumps(
            {
                "activities": "uploadText,downloadText",
                "locations": [
                    {"@odata.type": "microsoft.graph.policyLocationApplication", "value": self.config.app_location}
                ],
            }
        ).encode()
        _, headers, _ = _post(
            f"{GRAPH}/users/{user_id}/dataSecurityAndGovernance/protectionScopes/compute",
            {"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            body,
        )
        etag = headers.get("ETag", "")
        self._scopes[user_id] = (etag, time.time())
        return etag

    def evaluate(
        self,
        text: str,
        activity: Activity,
        user_id: str | None = None,
        correlation_id: str = "default",
        sequence_number: int = 0,
    ) -> EvalResult:
        if not self.ready:
            return EvalResult(blocked=False, evaluated=False)
        c = self.config
        uid = user_id or c.default_user_id
        try:
            token = self._get_token()
            etag = self._ensure_scopes(token, uid)
            now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
            headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
            if etag:
                headers["If-None-Match"] = etag
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
                        "deviceMetadata": {"deviceType": "Unmanaged", "ipAddress": "127.0.0.1"},
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
            _, _, data = _post(
                f"{GRAPH}/users/{uid}/dataSecurityAndGovernance/processContent", headers, body
            )
            if data.get("protectionScopeState") == "modified":
                self._scopes.pop(uid, None)
            for a in data.get("policyActions", []):
                if a.get("action") == "restrictAccess" and a.get("restrictionAction") == "block":
                    return EvalResult(
                        blocked=True,
                        evaluated=True,
                        reason="Blocked by a Microsoft Purview data-loss-prevention policy.",
                    )
            return EvalResult(blocked=False, evaluated=True)
        except Exception as err:  # noqa: BLE001 - fail open/closed by policy
            print(f"[purview] evaluate({activity}) failed: {err}")
            return EvalResult(
                blocked=c.fail_closed,
                evaluated=False,
                reason="Governance check unavailable." if c.fail_closed else None,
            )
