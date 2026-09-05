/**
 * Wire-format adapters for the governance proxy.
 *
 * The proxy has to find the human-readable text inside somebody else's request
 * and response bodies without knowing anything about their implementation.
 * Each dialect knows how to pull text out of a payload and how to build a
 * refusal the caller's client will render correctly.
 *
 * Supported out of the box:
 *   a2a     — JSON-RPC 2.0 as used by Agent2Agent (what Agent 365 registers)
 *   openai  — /v1/chat/completions request and response shapes
 *   generic — configurable dot-paths, for anything else
 *
 * If none of these fit a particular vendor, add a dialect here rather than
 * teaching the proxy core about a new payload shape.
 */

/** Walk a dot-path with [*] wildcards, collecting every string it reaches. */
export function collect(obj, path) {
  const parts = path.split(".");
  const out = [];
  const walk = (node, i) => {
    if (node === undefined || node === null) return;
    if (i === parts.length) {
      if (typeof node === "string") out.push(node);
      return;
    }
    const key = parts[i];
    if (key === "[*]") {
      if (Array.isArray(node)) for (const el of node) walk(el, i + 1);
      return;
    }
    walk(node[key], i + 1);
  };
  walk(obj, 0);
  return out;
}

const A2A_REQUEST_PATHS = [
  "params.message.parts.[*].text",
  "params.messages.[*].parts.[*].text",
];
const A2A_RESPONSE_PATHS = [
  "result.parts.[*].text",
  "result.message.parts.[*].text",
  "result.status.message.parts.[*].text",
  "result.artifacts.[*].parts.[*].text",
];

export const dialects = {
  /** Agent2Agent JSON-RPC — the transport Agent 365 registers by default. */
  a2a: {
    name: "a2a",
    extractRequest: (b) => A2A_REQUEST_PATHS.flatMap((p) => collect(b, p)),
    extractResponse: (b) => A2A_RESPONSE_PATHS.flatMap((p) => collect(b, p)),
    correlationId: (b) =>
      b?.params?.message?.contextId ?? b?.params?.message?.taskId ?? b?.params?.contextId ?? undefined,
    /** JSON-RPC carries errors in the envelope, so refuse with a proper error object. */
    refusal: (reason, body) => ({
      status: 200,
      json: {
        jsonrpc: "2.0",
        id: body?.id ?? null,
        error: { code: -32001, message: reason, data: { blockedBy: "microsoft-purview" } },
      },
    }),
  },

  /** OpenAI-compatible chat completions — very common for vendor agents. */
  openai: {
    name: "openai",
    extractRequest: (b) => [
      ...collect(b, "messages.[*].content"),
      ...collect(b, "messages.[*].content.[*].text"),
      ...collect(b, "input"),
    ],
    extractResponse: (b) => [
      ...collect(b, "choices.[*].message.content"),
      ...collect(b, "choices.[*].delta.content"),
      ...collect(b, "output_text"),
    ],
    correlationId: (b) => b?.conversation_id ?? b?.user ?? undefined,
    refusal: (reason) => ({
      status: 403,
      json: { error: { message: reason, type: "policy_violation", code: "content_blocked_by_purview" } },
    }),
  },

  /** Anything else: point it at the right fields with dot-paths. */
  generic: {
    name: "generic",
    requestPaths: ["message", "prompt", "input", "text"],
    responsePaths: ["reply", "response", "output", "text", "content"],
    extractRequest(b) { return this.requestPaths.flatMap((p) => collect(b, p)); },
    extractResponse(b) { return this.responsePaths.flatMap((p) => collect(b, p)); },
    correlationId: (b) => b?.conversationId ?? b?.conversation_id ?? b?.sessionId ?? undefined,
    refusal: (reason) => ({ status: 403, json: { error: reason, blocked: true } }),
  },
};

/**
 * Pick a dialect. An explicit choice always wins; otherwise sniff the payload,
 * because a proxy fronting several vendors shouldn't need one instance each.
 */
export function resolveDialect(name, body) {
  if (name && name !== "auto") {
    const d = dialects[name];
    if (!d) throw new Error(`unknown dialect "${name}" (have: ${Object.keys(dialects).join(", ")})`);
    return d;
  }
  if (body && typeof body === "object") {
    if (body.jsonrpc === "2.0" || body.method?.startsWith?.("message/")) return dialects.a2a;
    if (Array.isArray(body.messages) || typeof body.model === "string") return dialects.openai;
  }
  return dialects.generic;
}

/** Build a generic dialect bound to caller-supplied paths. */
export function customDialect({ requestPaths, responsePaths }) {
  return {
    ...dialects.generic,
    name: "custom",
    requestPaths: requestPaths?.length ? requestPaths : dialects.generic.requestPaths,
    responsePaths: responsePaths?.length ? responsePaths : dialects.generic.responsePaths,
  };
}
