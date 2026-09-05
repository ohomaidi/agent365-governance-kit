/**
 * Zero-code Purview guard for agents built on the Microsoft 365 Agents SDK.
 *
 * Loaded with `node --import ./agent365-guard.preload.mjs …` (the installer
 * writes the file and updates the start script). It patches the SDK so that:
 *
 *   AgentApplication.run     → the inbound message text is evaluated
 *                               (uploadText) BEFORE the agent's own handlers
 *                               see it; a blocked prompt is refused in chat.
 *   TurnContext.sendActivity → every outbound text is evaluated (downloadText)
 *                               and withheld if a policy blocks it.
 *
 * Nothing in the agent's source changes. Configuration is the PURVIEW_* block
 * the installer wrote to .env; the guard is created lazily on the first turn so
 * the agent's own dotenv load has happened. Attribution uses the sender's Entra
 * object id and the conversation id, so the audit trail names the human.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const BLOCK_PREFIX = "🛡️";
const require = createRequire(pathToFileURL(process.cwd() + "/").href);

let hosting = null, kit = null;
try { hosting = require("@microsoft/agents-hosting"); } catch { /* not an Agents SDK app */ }
try { kit = require("@zaatarlabs/agent365-governance-kit"); } catch { /* kit not installed */ }

if (!hosting || !kit) {
  console.warn(`[agent365-guard] inactive: ${!hosting ? "@microsoft/agents-hosting" : "@zaatarlabs/agent365-governance-kit"} not found from ${process.cwd()}`);
} else {
  console.log("[agent365-guard] loaded — Microsoft 365 Agents SDK turns will be checked by Purview (guard starts on the first message).");
  let guard = null;
  const getGuard = () => {
    if (guard) return guard;
    try { require("dotenv/config"); } catch { /* the agent may load env another way */ }
    guard = kit.createPurviewGuard(kit.loadConfig().purview);
    if (guard.state === "ready") console.log("[agent365-guard] Purview guard ACTIVE — prompts and replies are evaluated (auto-wired).");
    else if (guard.state === "disabled") console.warn("[agent365-guard] Purview guard OFF (PURVIEW_ENABLED=false).");
    else console.error(`[agent365-guard] Purview guard MISCONFIGURED — missing ${guard.missing.join(", ")}.`);
    return guard;
  };
  const opts = (ctx, seq) => ({
    correlationId: ctx.activity?.conversation?.id || undefined,
    userId: ctx.activity?.from?.aadObjectId || undefined,
    sequenceNumber: seq,
  });

  const { AgentApplication, TurnContext } = hosting;
  if (AgentApplication?.prototype?.run) {
    const run = AgentApplication.prototype.run;
    AgentApplication.prototype.run = async function (context, ...rest) {
      const a = context?.activity;
      const text = a?.type === "message" && typeof a.text === "string" ? a.text.trim() : "";
      if (text) {
        const v = await getGuard().evaluate(text, "uploadText", opts(context, 0));
        if (v.blocked) { await context.sendActivity(`${BLOCK_PREFIX} ${v.reason ?? "Blocked by policy."}`); return; }
      }
      return run.call(this, context, ...rest);
    };
  }
  if (TurnContext?.prototype?.sendActivity) {
    const send = TurnContext.prototype.sendActivity;
    TurnContext.prototype.sendActivity = async function (activityOrText, ...rest) {
      const text = typeof activityOrText === "string" ? activityOrText : activityOrText?.text;
      if (typeof text === "string" && text.trim() && !text.startsWith(BLOCK_PREFIX)) {
        const v = await getGuard().evaluate(text, "downloadText", opts(this, 1));
        if (v.blocked) return send.call(this, `${BLOCK_PREFIX} ${v.reason ?? "Blocked by policy."}`);
      }
      return send.call(this, activityOrText, ...rest);
    };
  }
}
