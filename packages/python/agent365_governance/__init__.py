"""
agent365-governance-kit (Python)

Drop-in Microsoft Purview governance for any Python AI agent.

    from agent365_governance import load_config, PurviewGuard

    guard = PurviewGuard(load_config())
    v = guard.evaluate(user_prompt, "uploadText", correlation_id=conversation_id)
    if v.blocked:
        return v.reason          # don't call the model
    reply = my_model(user_prompt)
    if guard.evaluate(reply, "downloadText", correlation_id=conversation_id, sequence_number=1).blocked:
        return "blocked"
    return reply
"""
from .config import PurviewConfig, load_config
from .purview import PurviewGuard, EvalResult

__all__ = ["PurviewConfig", "load_config", "PurviewGuard", "EvalResult"]
__version__ = "0.1.0"
