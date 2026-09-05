import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolveDialect, customDialect } from "./dialects.mjs";

/**
 * Governance proxy — Purview DLP for an agent you cannot modify.
 *
 * The Purview guard is a library the agent calls, which is fine when you own
 * the source. For a third-party or vendor agent there is nowhere to put that
 * call, so instead we put the guard in the network path:
 *
 *     caller -> [ proxy: evaluate(prompt) -> upstream -> evaluate(reply) ] -> caller
 *
 * Register the PROXY's URL as the agentInstance url in Agent 365 and the
 * registry's own record points at a governed endpoint.
 *
 * Limits worth stating plainly:
 *   - It only governs traffic that actually traverses it. A vendor SaaS agent
 *     users hit directly in the browser is not covered; force traffic through
 *     the proxy with DNS/network policy, or use endpoint DLP instead.
 *   - Streaming responses must be buffered to be evaluated. That is the default
 *     and it costs incremental delivery. `streaming: "passthrough"` restores
 *     streaming but leaves the response ungoverned — it warns loudly.
 */

/** Headers that belong to a single hop and must not be forwarded. */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
]);

const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      fn(arg);
    };
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        // Stop accumulating but keep the socket alive — the caller still has to
        // receive the 413. Destroying here would leave the client hanging.
        req.resume();
        finish(reject, new Error(`request body exceeded ${limit} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => finish(resolve, Buffer.concat(chunks)));
    req.on("aborted", () => finish(reject, new Error("request aborted")));
    req.on("error", (e) => finish(reject, e));
  });

/**
 * @param {object} opts
 * @param {string} opts.upstream        Base URL of the agent being fronted.
 * @param {object} opts.guard           A PurviewGuard from the governance kit.
 * @param {string} [opts.dialect]       "a2a" | "openai" | "generic" | "auto"
 * @param {string[]} [opts.requestPaths]  Custom dot-paths for request text.
 * @param {string[]} [opts.responsePaths] Custom dot-paths for response text.
 * @param {string} [opts.streaming]     "buffer" (default) | "passthrough"
 * @param {number} [opts.maxBodyBytes]  Default 5 MiB.
 * @param {string} [opts.userHeader]    Header carrying the end-user's Entra object id.
 * @param {Function} [opts.teams]       Express handler from createTeamsBridge(); mounted at /api/messages.
 */
export function createGovernanceProxy(opts) {
  const {
    upstream, guard,
    dialect: dialectName = "auto",
    requestPaths, responsePaths,
    streaming = "buffer",
    maxBodyBytes = 5 * 1024 * 1024,
    userHeader = "x-agent-user-id",
    teams = null,
    log = console,
  } = opts;

  if (!upstream) throw new Error("governance proxy requires an upstream URL");
  if (!guard) throw new Error("governance proxy requires a Purview guard");
  const upstreamBase = upstream.replace(/\/+$/, "");
  const custom = (requestPaths?.length || responsePaths?.length)
    ? customDialect({ requestPaths, responsePaths })
    : null;

  if (streaming === "passthrough") {
    log.warn("[proxy] streaming=passthrough — streamed responses are NOT evaluated by Purview.");
  }

  const stats = { requests: 0, blockedIn: 0, blockedOut: 0, errors: 0 };

  const server = createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(payload);
    };

    // Operational endpoint: is this proxy actually governing anything?
    if (req.method === "GET" && req.url === "/_governance/health") {
      return send(guard.state === "ready" ? 200 : 503, {
        proxy: "ok",
        upstream: upstreamBase,
        guard: guard.state,
        missing: guard.missing ?? [],
        governing: guard.state === "ready",
        streaming,
        teams: Boolean(teams),
        stats,
      });
    }

    // Teams talks Bot Framework to /api/messages; that path is the bridge's,
    // not a passthrough to the vendor.
    if (teams && (req.url === "/api/messages" || req.url?.startsWith("/api/messages?"))) {
      stats.teamsTurns = (stats.teamsTurns ?? 0) + 1;
      return teams(req, res);
    }

    stats.requests++;
    let raw;
    try {
      raw = await readBody(req, maxBodyBytes);
    } catch (e) {
      stats.errors++;
      return send(413, { error: String(e.message) });
    }

    let parsed = null;
    const ct = String(req.headers["content-type"] ?? "");
    if (ct.includes("json") && raw.length) {
      try { parsed = JSON.parse(raw.toString("utf8")); } catch { parsed = null; }
    }

    const d = custom ?? resolveDialect(dialectName, parsed);
    const correlationId =
      String(req.headers["x-correlation-id"] ?? "") ||
      (parsed ? d.correlationId?.(parsed) : undefined) ||
      randomUUID();
    const userId = String(req.headers[userHeader] ?? "") || undefined;
    const ipAddress =
      String(req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"] ?? "")
        .split(",")[0].trim() || req.socket.remoteAddress || undefined;

    // ---- 1. govern the inbound prompt ----
    if (parsed) {
      const texts = d.extractRequest(parsed).filter(Boolean);
      for (const [i, text] of texts.entries()) {
        const v = await guard.evaluate(text, "uploadText", {
          correlationId, sequenceNumber: i, userId, ipAddress,
        });
        if (v.blocked) {
          stats.blockedIn++;
          log.warn?.(`[proxy] inbound BLOCKED (${correlationId}) — ${v.reason}`);
          const r = d.refusal(v.reason ?? "Blocked by policy.", parsed);
          return send(r.status, r.json);
        }
      }
    } else if (raw.length) {
      // Unparseable body: we can't find the text, so we can't govern it.
      log.warn?.(`[proxy] body is not JSON (${ct || "no content-type"}) — forwarding UNGOVERNED.`);
    }

    // ---- 2. forward upstream ----
    const target = upstreamBase + (req.url ?? "/");
    const fwdHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) fwdHeaders[k] = v;
    }
    let upRes;
    try {
      upRes = await fetch(target, {
        method: req.method,
        headers: fwdHeaders,
        body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : raw,
        redirect: "manual",
      });
    } catch (e) {
      stats.errors++;
      log.error?.(`[proxy] upstream ${target} unreachable: ${e.message}`);
      return send(502, { error: `upstream unreachable: ${e.message}` });
    }

    const upCt = upRes.headers.get("content-type") ?? "";
    const isStream = upCt.includes("event-stream");
    const outHeaders = {};
    upRes.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v; });

    // Streaming that we've been told not to govern: pipe it through untouched.
    if (isStream && streaming === "passthrough") {
      res.writeHead(upRes.status, outHeaders);
      if (upRes.body) {
        const reader = upRes.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      return res.end();
    }

    const upRaw = Buffer.from(await upRes.arrayBuffer());

    // ---- 3. govern the outbound reply ----
    let upParsed = null;
    if (upCt.includes("json") && upRaw.length) {
      try { upParsed = JSON.parse(upRaw.toString("utf8")); } catch { upParsed = null; }
    }
    if (upParsed) {
      const texts = d.extractResponse(upParsed).filter(Boolean);
      for (const [i, text] of texts.entries()) {
        const v = await guard.evaluate(text, "downloadText", {
          correlationId, sequenceNumber: 1000 + i, userId, ipAddress,
        });
        if (v.blocked) {
          stats.blockedOut++;
          log.warn?.(`[proxy] outbound BLOCKED (${correlationId}) — ${v.reason}`);
          const r = d.refusal(v.reason ?? "Blocked by policy.", upParsed);
          return send(r.status, r.json);
        }
      }
    }

    delete outHeaders["content-length"];
    res.writeHead(upRes.status, outHeaders);
    res.end(upRaw);
  });

  return { server, stats, listen: (port, host = "0.0.0.0") => new Promise((r) => server.listen(port, host, r)) };
}
