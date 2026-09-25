"use strict";
/*
 * routes/responses.js — POST /v1/responses (OpenAI Responses API format).
 * P1-3 (light translator): muse-spark family. Client dan upstream SAMA-SAMA
 * Responses-API → request tinggal dinormalkan (normalizeResponses+primer,
 * di dalam forward kind="responses") dan SSE di-relay verbatim. Tidak ada
 * konversi chat↔responses (itu full work 2557, di luar scope).
 * Honest-close (P1-1) berlaku: putus tanpa terminal event → error event,
 * tanpa karangan response.completed.
 */

const sse = require("../lib/sse.js");
const logger = require("../lib/logger.js");
const { parseBody, sendJson } = require("./chatCompletions.js");

const TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed", "error"]);

async function handleResponses(router, req, res) {
  const logId = `res_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return sendJson(res, e.status || 400, { error: { message: e.message, type: "invalid_request_error" } });
  }

  let resolved;
  try {
    resolved = router.resolveModel(body.model);
  } catch (e) {
    return sendJson(res, 400, { error: { message: e.message, type: "invalid_request_error" } });
  }
  body.model = resolved.bare;

  const isStream = body.stream === true;
  try {
    const out = await router.forward({ body, kind: "responses" });
    const meta = { id: logId, model: body.model, proxy: out.proxy, attempts: 1, rotated: !!out.rotated, latencyMs: out.latencyMs, kind: "responses" };

    if (isStream && out.stream) {
      res.writeHead(out.status, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });
      let events = 0;
      let sawTerminal = false;
      let doneSent = false;
      let usage = null;
      let status = null;
      const parser = sse.createParser(
        (payload) => {
          events += 1;
          let j = null;
          try { j = JSON.parse(payload); } catch {}
          if (j) {
            if (TERMINAL.has(j.type)) sawTerminal = true;
            if (j.response?.usage) usage = j.response.usage;
            if (j.response?.status) status = j.response.status;
          }
          res.write(`data: ${payload}\n\n`);
        },
        () => { if (!doneSent) { doneSent = true; res.write("data: [DONE]\n\n"); } }
      );
      const sendDone = () => { if (!doneSent) { doneSent = true; res.write("data: [DONE]\n\n"); } };
      const upstream = out.stream();
      let closed = false;
      const closeStream = () => { if (closed) return; closed = true; try { res.end(); } catch {} };
      upstream.on("data", (c) => parser.feed(c));
      upstream.on("end", () => {
        parser.end();
        if (!sawTerminal) {
          // Honest-close: putus tanpa terminal event → error event, bukan
          // response.completed karangan.
          res.write(`data: ${JSON.stringify({ type: "error", code: "upstream_interrupt", message: "upstream closed without completion" })}\n\n`);
          sendDone();
          closeStream();
          router.logs.push({ ...meta, status: out.status, events, usage, stream: true, interrupt: true });
          logger.warn(`[${logId}] responses stream interrupted: no terminal event events=${events} proxy=${meta.proxy || "direct"}`);
          return;
        }
        sendDone();
        closeStream();
        router.logs.push({ ...meta, status: out.status, events, usage, stream: true });
        logger.info(`[${logId}] responses stream done: status=${out.status} events=${events} resp_status=${status || "-"} proxy=${meta.proxy || "direct"} usage=${usage ? JSON.stringify(usage) : "-"}`);
      });
      upstream.on("error", (err) => {
        parser.end();
        res.write(`data: ${JSON.stringify({ type: "error", code: "upstream_error", message: err.message })}\n\n`);
        sendDone();
        closeStream();
        router.logs.push({ ...meta, status: out.status, events, usage, stream: true, error: err.message.slice(0, 200) });
        logger.error(`[${logId}] responses upstream stream error: ${err.message}`);
      });
      req.on("close", () => { try { upstream.destroy(); } catch {} });
      return;
    }

    // Non-streaming (JSON as-is dari upstream / collapseResponsesSSE).
    if (out.json) {
      router.logs.push({ ...meta, status: out.status, stream: false, usage: out.json.usage });
      logger.info(`[${logId}] responses done: status=${out.status} usage=${out.json.usage ? JSON.stringify(out.json.usage) : "-"} proxy=${meta.proxy || "direct"}`);
      return sendJson(res, out.status, out.json);
    }
    if (out.status >= 200 && out.status < 300) {
      router.logs.push({ ...meta, status: out.status, stream: false });
      return sendJson(res, out.status, { error: { message: "upstream returned non-JSON 2xx", type: "upstream_error" } });
    }
    let errMsg = "upstream error";
    try {
      const parsed = JSON.parse(out.raw || "{}");
      errMsg = parsed.error?.message || (out.raw || "").slice(0, 300) || errMsg;
    } catch {
      errMsg = (out.raw || "").slice(0, 300) || errMsg;
    }
    router.logs.push({ ...meta, status: out.status, stream: false, error: errMsg.slice(0, 200) });
    logger.warn(`[${logId}] responses upstream error: ${out.status} ${errMsg}`);
    return sendJson(res, out.status, { error: { message: errMsg, type: "upstream_error", code: "upstream_error" } });
  } catch (e) {
    router.logs.push({ id: logId, model: body.model, status: 502, error: e.message, stream: isStream, kind: "responses" });
    logger.error(`[${logId}] responses failed: ${e.message}`);
    return sendJson(res, e.status || 502, { error: { message: e.message, type: "upstream_error" } });
  }
}

module.exports = { handleResponses };
