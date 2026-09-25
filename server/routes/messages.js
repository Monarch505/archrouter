"use strict";
/*
 * routes/messages.js — POST /v1/messages (Anthropic format).
 * Converts Anthropic <-> OpenAI, forwards, and emits Anthropic SSE for streams.
 */

const anthropic = require("../lib/anthropic.js");
const sse = require("../lib/sse.js");
const logger = require("../lib/logger.js");
const { parseBody, sendJson } = require("./chatCompletions.js");

function sendJsonAnthropic(res, status, obj) {
  return sendJson(res, status, obj);
}

async function handleMessages(router, req, res) {
  const logId = `msg_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return sendJsonAnthropic(res, e.status || 400, { type: "error", error: { type: "invalid_request_error", message: e.message } });
  }

  let resolved;
  try {
    resolved = router.resolveModel(body.model);
  } catch (e) {
    return sendJsonAnthropic(res, 400, { type: "error", error: { type: "invalid_request_error", message: e.message } });
  }

  const oai = anthropic.toOpenAI({ ...body, model: resolved.bare });
  const isStream = body.stream === true;

  try {
    const out = await router.forward({ body: oai, isMessagesEndpoint: false });
    const meta = { id: logId, model: oai.model, proxy: out.proxy, rotated: !!out.rotated, latencyMs: out.latencyMs, kind: "anthropic" };

    if (isStream && out.stream) {
      res.writeHead(out.status, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      let chunkCount = 0;
      let contentChunks = 0;
      let finish = null;
      let usageUpstream = null;
      let msgId = `msg_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;

      const startPayload = { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: oai.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } };
      res.write(`event: message_start\ndata: ${JSON.stringify(startPayload)}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);

      const parser = sse.createParser(
        (payload) => {
          let j = null;
          try { j = JSON.parse(payload); } catch {}
          if (!j) return;
          chunkCount += 1;
          const delta = j.choices?.[0]?.delta;
          if (delta?.content) {
            contentChunks += 1;
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.content } })}\n\n`);
          }
          const fr = j.choices?.[0]?.finish_reason;
          if (fr) finish = fr;
          if (j.usage) usageUpstream = j.usage;
        },
        () => {}
      );
      const upstream = out.stream();
      let closed = false;
      const closeStream = () => { if (closed) return; closed = true; try { res.end(); } catch {} };
      upstream.on("data", (c) => parser.feed(c));
      upstream.on("end", () => {
        parser.end();
        if (!finish) {
          // Honest-close (v6.10): putus tanpa finish_reason → JANGAN mengarang
          // end_turn; kirim error event, hentikan stream.
          router.logs.push({ ...meta, status: out.status, chunks: chunkCount, finish: null, stream: true, interrupt: true });
          logger.warn(`[${logId}] anthropic stream interrupted: no finish_reason chunks=${chunkCount}`);
          res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream closed without completion" } })}\n\n`);
          closeStream();
          return;
        }
        const stopReason = finish === "stop" ? "end_turn" : finish;
        const outputTokens = usageUpstream?.completion_tokens ?? contentChunks;
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } })}\n\n`);
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        closeStream();
        router.logs.push({ ...meta, status: out.status, chunks: chunkCount, finish, stream: true });
        logger.info(`[${logId}] anthropic stream done: status=${out.status} chunks=${chunkCount} finish=${finish}`);
      });
      upstream.on("error", (err) => {
        logger.error(`[${logId}] upstream stream error: ${err.message}`);
        router.logs.push({ ...meta, status: out.status, chunks: chunkCount, finish, stream: true, error: err.message.slice(0, 200) });
        res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } })}\n\n`);
        closeStream();
      });
      req.on("close", () => { try { upstream.destroy(); } catch {} });
      return;
    }

    if (out.json) {
      if (out.json.error) {
        const errMsg = out.json.error.message || "upstream error";
        router.logs.push({ ...meta, status: out.status, error: errMsg.slice(0, 200), stream: false });
        return sendJsonAnthropic(res, out.status, { type: "error", error: { type: "api_error", message: errMsg } });
      }
      const aMsg = anthropic.openAIChatToAnthropic(out.json);
      router.logs.push({ ...meta, status: out.status, chunks: 1, finish: aMsg.stop_reason, stream: false });
      logger.info(`[${logId}] anthropic done: status=${out.status} finish=${aMsg.stop_reason}`);
      return sendJsonAnthropic(res, out.status, aMsg);
    }
    let errMsg = "upstream error";
    try {
      const parsed = JSON.parse(out.raw || "{}");
      errMsg = parsed.error?.message || (out.raw || "").slice(0, 300) || errMsg;
    } catch {
      errMsg = (out.raw || "").slice(0, 300) || errMsg;
    }
    router.logs.push({ ...meta, status: out.status, error: errMsg.slice(0, 200), stream: false });
    return sendJsonAnthropic(res, out.status, { type: "error", error: { type: "api_error", message: errMsg } });
  } catch (e) {
    router.logs.push({ id: logId, model: oai.model, status: 502, error: e.message, stream: isStream });
    logger.error(`[${logId}] failed: ${e.message}`);
    return sendJsonAnthropic(res, e.status || 502, { type: "error", error: { type: "api_error", message: e.message } });
  }
}

module.exports = { handleMessages };
