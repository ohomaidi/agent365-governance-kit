# Agent 365 Governance Kit — Python

Drop-in Microsoft Purview governance for any Python AI agent. Zero dependencies (standard library only).

## Install

```bash
pip install ./packages/python        # from this repo
# (or, once published)  pip install agent365-governance-kit
```

## Configure

Run the wizard once from the repo root to provision the tenant and write the `PURVIEW_*`
variables into a `.env`, then load them into your environment (e.g. with `python-dotenv`
or your process manager):

```bash
node wizard/agent365-govern.mjs --dry-run   # rehearse — changes nothing
node wizard/agent365-govern.mjs             # provision
```

**Defaults are fail-safe:** the guard is enabled unless `PURVIEW_ENABLED=false`, and it
**blocks** when Purview is unreachable unless `PURVIEW_FAIL_CLOSED=false`. See the
[configuration reference](../../README.md#configuration-reference).

## Use (two calls)

```python
from agent365_governance import load_config, PurviewGuard

guard = PurviewGuard(load_config())   # reads PURVIEW_* from os.environ

def handle_turn(prompt: str, conversation_id: str) -> str:
    # 1) govern the inbound prompt — block before the model sees it
    inbound = guard.evaluate(prompt, "uploadText", correlation_id=conversation_id, sequence_number=0)
    if inbound.blocked:
        return inbound.reason

    reply = my_model(prompt)          # Claude, OpenAI, anything

    # 2) govern the outbound reply
    outbound = guard.evaluate(reply, "downloadText", correlation_id=conversation_id, sequence_number=1)
    if outbound.blocked:
        return outbound.reason

    return reply
```

`evaluate()` returns `EvalResult(blocked, evaluated, reason, degraded)`.

### Don't rely on `blocked` alone

`blocked is False` can mean "Purview allowed it" *or* "the guard never ran". Check the
guard's state once at startup, and alert on degraded turns:

```python
guard = PurviewGuard(load_config())

if guard.state != "ready":
    # "disabled"      -> PURVIEW_ENABLED=false
    # "misconfigured" -> guard.missing lists the env vars to fix
    logger.error("Purview guard is %s: missing %s", guard.state, guard.missing)

v = guard.evaluate(prompt, "uploadText", correlation_id=cid)
if v.degraded == "error":
    metrics.increment("purview.unreachable")
```

The guard logs through the standard `logging` module (`agent365_governance.purview`),
so it participates in your app's logging config rather than printing to stdout.

### Per-call attribution

For a multi-user app, pass the real signed-in user and caller IP — otherwise every
interaction is attributed to `PURVIEW_USER_ID` and no IP is recorded:

```python
guard.evaluate(prompt, "uploadText", correlation_id=cid,
               user_id=signed_in_user_object_id, ip_address=request.remote_addr)
```

> The calls are synchronous (stdlib `urllib`). In an async agent, wrap with `asyncio.to_thread(guard.evaluate, ...)`.

## Test

```bash
cd packages/python && python3 -m unittest discover -s tests
```

19 behavioural tests against a mock Graph: defaults, misconfiguration, verdicts,
retries, timeouts, caching, payload shape, and secret redaction.

## Notes
- **Agent 365 observability** (Activity tab) is **not** part of the Python package — Microsoft's Agents SDK + OpenTelemetry distro for Python are preview. Use the Node or .NET package for that, or see `../../AGENT365_SETUP.md`.
- Block fires on **UploadText** (the prompt). DLP policies take up to ~1h to propagate,
  and a policy created in **test mode blocks nothing**.
- Every call is bounded by `PURVIEW_TIMEOUT_MS` and retries 429/5xx with backoff.
- The guard is thread-safe; its token and scope caches are lock-protected.
- Not published to PyPI — install from this repo.
