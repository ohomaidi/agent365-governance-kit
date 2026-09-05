"""Behavioural tests for the Python Purview guard, against a local mock Graph.

Mirrors the TypeScript suite: silent no-ops, fail-open on error, throttling,
hangs, and audit-payload shape.
"""
import json
import logging
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from agent365_governance import PurviewGuard, load_config
from agent365_governance.config import PurviewConfig

# Mutable test script shared with the handler thread.
STATE = {}


def reset():
    STATE.clear()
    STATE.update(
        token=0, scopes=0, process=0, bodies=[],
        process_status=200, process_body={}, scope_etag='W/"etag-1"',
        hang=False, fail_times=0,
    )


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # silence access logs
        pass

    def do_POST(self):  # noqa: N802
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
        if STATE["hang"]:
            # Outlive the client's timeout without stalling the whole suite.
            threading.Event().wait(3)
            return

        def send(code, body, headers=None):
            payload = json.dumps(body).encode()
            try:
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass  # client already timed out — expected in the hang tests

        if "/oauth2/v2.0/token" in self.path:
            STATE["token"] += 1
            return send(200, {"access_token": "mock-token", "expires_in": 3600})
        if "/protectionScopes/compute" in self.path:
            STATE["scopes"] += 1
            hdrs = {"ETag": STATE["scope_etag"]} if STATE["scope_etag"] else {}
            return send(200, {}, hdrs)
        if "/processContent" in self.path:
            STATE["process"] += 1
            STATE["bodies"].append(json.loads(raw or b"{}"))
            if STATE["fail_times"] > 0:
                STATE["fail_times"] -= 1
                return send(429, {"error": "throttled"}, {"Retry-After": "0"})
            return send(STATE["process_status"], STATE["process_body"])
        send(404, {})


class GuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        reset()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.daemon_threads = True
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        logging.disable(logging.CRITICAL)  # keep expected error logs out of test output

    @classmethod
    def tearDownClass(cls):
        logging.disable(logging.NOTSET)
        cls.server.shutdown()

    def setUp(self):
        reset()

    def cfg(self, **over) -> PurviewConfig:
        env = {
            "PURVIEW_TENANT_ID": "tenant", "PURVIEW_CLIENT_ID": "client",
            "PURVIEW_CLIENT_SECRET": "super-secret-value", "PURVIEW_USER_ID": "user-1",
            "PURVIEW_GRAPH_BASE_URL": f"{self.base}/v1.0", "PURVIEW_LOGIN_BASE_URL": self.base,
        }
        env.update(over)
        return load_config(env)

    # ---------------- safe defaults ----------------
    def test_enabled_by_default(self):
        self.assertTrue(load_config({}).enabled)
        self.assertFalse(load_config({"PURVIEW_ENABLED": "false"}).enabled)

    def test_fail_closed_by_default(self):
        self.assertTrue(load_config({}).fail_closed)
        self.assertFalse(load_config({"PURVIEW_FAIL_CLOSED": "false"}).fail_closed)

    def test_empty_env_is_misconfigured_not_disabled(self):
        self.assertEqual(load_config({}).state(), "misconfigured")

    # ---------------- the silent no-op regression ----------------
    def test_misconfigured_blocks_and_names_missing_vars(self):
        g = PurviewGuard(load_config({}))
        v = g.evaluate("credit card 4111111111111111", "uploadText")
        self.assertTrue(v.blocked)
        self.assertFalse(v.evaluated)
        self.assertEqual(v.degraded, "misconfigured")
        self.assertIn("PURVIEW_TENANT_ID", v.reason)

    def test_disabled_allows_but_reports_why(self):
        v = PurviewGuard(load_config({"PURVIEW_ENABLED": "false"})).evaluate("x", "uploadText")
        self.assertFalse(v.blocked)
        self.assertEqual(v.degraded, "disabled")

    # ---------------- verdicts ----------------
    def test_benign_content_allowed(self):
        v = PurviewGuard(self.cfg()).evaluate("hello", "uploadText")
        self.assertFalse(v.blocked)
        self.assertTrue(v.evaluated)

    def test_block_action_blocks(self):
        STATE["process_body"] = {"policyActions": [{"action": "restrictAccess", "restrictionAction": "block"}]}
        v = PurviewGuard(self.cfg()).evaluate("4111111111111111", "uploadText")
        self.assertTrue(v.blocked)
        self.assertTrue(v.evaluated)

    def test_block_detection_is_case_insensitive(self):
        STATE["process_body"] = {"policyActions": [{"action": "RestrictAccess", "restrictionAction": "Block"}]}
        self.assertTrue(PurviewGuard(self.cfg()).evaluate("x", "uploadText").blocked)

    # ---------------- resilience ----------------
    def test_429_is_retried_then_succeeds(self):
        STATE["fail_times"] = 2
        v = PurviewGuard(self.cfg(PURVIEW_MAX_RETRIES="3")).evaluate("hi", "uploadText")
        self.assertTrue(v.evaluated)
        self.assertEqual(STATE["process"], 3)

    def test_hang_times_out_and_fails_closed(self):
        STATE["hang"] = True
        try:
            v = PurviewGuard(self.cfg(PURVIEW_TIMEOUT_MS="1000", PURVIEW_MAX_RETRIES="0")).evaluate("hi", "uploadText")
        finally:
            STATE["hang"] = False
        self.assertTrue(v.blocked, "an unreachable governance plane must not allow")
        self.assertEqual(v.degraded, "error")

    def test_fail_open_still_available_when_chosen(self):
        STATE["hang"] = True
        try:
            v = PurviewGuard(self.cfg(
                PURVIEW_TIMEOUT_MS="1000", PURVIEW_MAX_RETRIES="0", PURVIEW_FAIL_CLOSED="false",
            )).evaluate("hi", "uploadText")
        finally:
            STATE["hang"] = False
        self.assertFalse(v.blocked)
        self.assertEqual(v.degraded, "error")

    def test_5xx_exhausts_retries_and_fails_closed(self):
        STATE["process_status"] = 500
        v = PurviewGuard(self.cfg(PURVIEW_MAX_RETRIES="1")).evaluate("hi", "uploadText")
        self.assertTrue(v.blocked)
        self.assertEqual(STATE["process"], 2)

    # ---------------- caching ----------------
    def test_token_and_scopes_are_cached(self):
        g = PurviewGuard(self.cfg())
        g.evaluate("one", "uploadText")
        g.evaluate("two", "downloadText")
        g.evaluate("three", "uploadText")
        self.assertEqual(STATE["scopes"], 1)
        self.assertEqual(STATE["token"], 1)

    def test_missing_etag_is_cached_too(self):
        STATE["scope_etag"] = None
        g = PurviewGuard(self.cfg())
        g.evaluate("one", "uploadText")
        g.evaluate("two", "uploadText")
        self.assertEqual(STATE["scopes"], 1, "absence of an ETag must be cached")

    def test_modified_scope_state_invalidates_cache(self):
        STATE["process_body"] = {"protectionScopeState": "modified"}
        g = PurviewGuard(self.cfg())
        g.evaluate("one", "uploadText")
        g.evaluate("two", "uploadText")
        self.assertEqual(STATE["scopes"], 2)

    # ---------------- audit payload ----------------
    def test_no_fabricated_ip(self):
        PurviewGuard(self.cfg()).evaluate("hi", "uploadText")
        dm = STATE["bodies"][0]["contentToProcess"]["deviceMetadata"]
        self.assertNotIn("ipAddress", dm, "must not invent 127.0.0.1")

    def test_real_ip_is_forwarded(self):
        PurviewGuard(self.cfg()).evaluate("hi", "uploadText", ip_address="203.0.113.7")
        self.assertEqual(STATE["bodies"][0]["contentToProcess"]["deviceMetadata"]["ipAddress"], "203.0.113.7")

    def test_timestamp_has_utc_designator(self):
        PurviewGuard(self.cfg()).evaluate("hi", "uploadText")
        entry = STATE["bodies"][0]["contentToProcess"]["contentEntries"][0]
        self.assertRegex(entry["createdDateTime"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

    # ---------------- secret hygiene ----------------
    def test_secret_never_reaches_the_log(self):
        STATE["process_status"] = 400
        STATE["process_body"] = {"error": "bad", "client_secret": "super-secret-value"}
        logging.disable(logging.NOTSET)
        with self.assertLogs("agent365_governance.purview", level="ERROR") as cm:
            PurviewGuard(self.cfg(PURVIEW_MAX_RETRIES="0")).evaluate("hi", "uploadText")
        logging.disable(logging.CRITICAL)
        joined = "\n".join(cm.output)
        self.assertNotIn("super-secret-value", joined, "secret leaked into logs")
        self.assertIn("REDACTED", joined)


if __name__ == "__main__":
    unittest.main()
