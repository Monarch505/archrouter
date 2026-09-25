"use strict";
/*
 * routes/chatCompletions.js — POST /v1/chat/completions (OpenAI format).
 * Supports streaming (SSE passthrough) and non-streaming (JSON).
 */

const sse = require("../lib/sse.js");
const logger = require("../lib/logger.js");

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(Object.assign(new Error(`invalid JSON body: ${e.message}`), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

/*
 * REFERENCE v6.10 (honest-close): summarizeChunks menandai `complete` hanya
 * bila finish_reason benar-benar terlihat. Stream putus tanpa finish_reason
 * = abnormal end → wajib error/interrupt chunk, JANGAN mengarang finish.
 */
function summarizeChunks(events) {
  const s = { total: 0, chunks: 0, done: 0, finish: null, usage: null, id: null, model: null, complete: false };
  for (const e of events) {
    s.total += 1;
    if (e.kind === "done") { s.done += 1; continue; }
    if (e.kind === "chunk") {
      s.chunks += 1;
      if (e.json.id) s.id = e.json.id;
      if (e.json.model) s.model = e.json.model;
      if (e.json.usage) s.usage = e.json.usage;
      const fr = e.json.choices?.[0]?.finish_reason;
      if (fr) s.finish = fr;
    }
  }
  s.complete = s.finish !== null;
  return s;
}

function interruptPayload(message) {
  return JSON.stringify({ error: { message, type: "interrupt", code: "upstream_interrupt" } });
}

async function handleChatCompletions(router, req, res) {
  const logId = `req_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    const out = await router.forward({ body, isMessagesEndpoint: false });
    const meta = { id: logId, model: body.model, proxy: out.proxy, attempts: 1, rotated: !!out.rotated, latencyMs: out.latencyMs };

    if (isStream && out.stream) {
      res.writeHead(out.status, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });
      const events = [];
      const parser = sse.createParser(
        (payload) => {
          let j = null;
          try { j = JSON.parse(payload); } catch {}
          events.push({ kind: "chunk", json: j });
          res.write(`data: ${payload}\n\n`);
        },
        () => events.push({ kind: "done" })
      );
      const upstream = out.stream();
      let closed = false;
      const closeStream = () => { if (closed) return; closed = true; try { res.end(); } catch {} };
      upstream.on("data", (c) => parser.feed(c));
      upstream.on("end", () => {
        parser.end();
        const s = summarizeChunks(events);
        if (s.complete) {
          // Normal: finish_reason terlihat → [DONE] sekali, tutup bersih.
          res.write("data: [DONE]\n\n");
          closeStream();
          router.logs.push({ ...meta, status: out.status, chunks: s.chunks, finish: s.finish, usage: s.usage, stream: true });
          logger.info(`[${logId}] stream done: status=${out.status} chunks=${s.chunks} finish="${s.finish}" proxy=${meta.proxy || "direct"} usage=${s.usage ? JSON.stringify(s.usage) : "-"}`);
        } else {
          // Abnormal end (v6.10): putus TANPA finish_reason → interrupt chunk
          // dulu, baru [DONE] (kontrak: [DONE] selalu terkirim tepat 1×).
          res.write(`data: ${interruptPayload("upstream closed without completion")}\n\n`);
          res.write("data: [DONE]\n\n");
          closeStream();
          router.logs.push({ ...meta, status: out.status, chunks: s.chunks, finish: null, usage: s.usage, stream: true, interrupt: true });
          logger.warn(`[${logId}] stream interrupted: upstream ended without finish_reason chunks=${s.chunks} done=${s.done} proxy=${meta.proxy || "direct"} usage=${s.usage ? JSON.stringify(s.usage) : "-"}`);
        }
      });
      upstream.on("error", (err) => {
        parser.end();
        const s = summarizeChunks(events);
        // Error path: client HARUS melihat error, bukan close palsu bersih.
        res.write(`data: ${JSON.stringify({ error: { message: err.message, type: "api_error", code: "upstream_error" } })}\n\n`);
        res.write("data: [DONE]\n\n");
        closeStream();
        router.logs.push({ ...meta, status: out.status, chunks: s.chunks, finish: s.finish, usage: s.usage, stream: true, error: err.message.slice(0, 200) });
        logger.error(`[${logId}] upstream stream error: ${err.message} chunks=${s.chunks}`);
      });
      req.on("close", () => { try { upstream.destroy(); } catch {} });
      return;
    }

    // Non-streaming.
    if (out.json) {
      const s = summarizeChunks([{ kind: "chunk", json: out.json }]);
      router.logs.push({ ...meta, status: out.status, chunks: 1, finish: s.finish, usage: out.json.usage, stream: false });
      logger.info(`[${logId}] done: status=${out.status} model=${body.model} usage=${out.json.usage ? JSON.stringify(out.json.usage) : "-"} proxy=${meta.proxy || "direct"}`);
      return sendJson(res, out.status, out.json);
    }
    if (out.status >= 200 && out.status < 300) {
      // 2xx but unparsable JSON.
      router.logs.push({ ...meta, status: out.status, stream: false });
      return sendJson(res, out.status, { error: { message: "upstream returned non-JSON 2xx", type: "upstream_error" } });
    }
    // Error passthrough.
    let errMsg = "upstream error";
    try {
      const parsed = JSON.parse(out.raw || "{}");
      errMsg = parsed.error?.message || (out.raw || "").slice(0, 300) || errMsg;
    } catch {
      errMsg = (out.raw || "").slice(0, 300) || errMsg;
    }
    router.logs.push({ ...meta, status: out.status, stream: false, error: errMsg.slice(0, 200) });
    logger.warn(`[${logId}] upstream error: ${out.status} ${errMsg}`);
    return sendJson(res, out.status, { error: { message: errMsg, type: "upstream_error", code: "upstream_error" } });
  } catch (e) {
    router.logs.push({ id: logId, model: body.model, status: 502, error: e.message, stream: isStream });
    logger.error(`[${logId}] failed: ${e.message}`);
    return sendJson(res, e.status || 502, { error: { message: e.message, type: "upstream_error" } });
  }
}

module.exports = { handleChatCompletions, parseBody, sendJson, summarizeChunks, interruptPayload };
