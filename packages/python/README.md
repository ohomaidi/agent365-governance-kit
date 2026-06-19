# Agent 365 Governance Kit — Python

Drop-in Microsoft Purview governance for any Python AI agent. Zero dependencies (standard library only).

## Install

```bash
pip install ./packages/python        # from this repo
# (or, once published)  pip install agent365-governance-kit
```

## Configure

Run the wizard once (`npx agent365-govern` from the repo root) to provision the tenant and write the `PURVIEW_*` variables into a `.env`, then load them into your environment (e.g. with `python-dotenv` or your process manager).

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

`evaluate()` returns `EvalResult(blocked, evaluated, reason)`.

> The calls are synchronous (stdlib `urllib`). In an async agent, wrap with `asyncio.to_thread(guard.evaluate, ...)`.

## Notes
- **Agent 365 observability** (Activity tab) is **not** part of the Python package — Microsoft's Agents SDK + OpenTelemetry distro for Python are preview. Use the Node or .NET package for that, or see `../../AGENT365_SETUP.md`.
- Block fires on **UploadText** (the prompt). DLP policies take up to ~1h to propagate.
