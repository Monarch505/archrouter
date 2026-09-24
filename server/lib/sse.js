"use strict";
/*
 * sse.js — SSE parsing / streaming helpers.
 * Handles both \n and \r\n line endings, data: fields, [DONE].
 */

function createParser(onEvent, onDone) {
  let buffer = "";
  function feed(chunk) {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const trimmed = line.replace(/\r$/, "");
      if (!trimmed) continue;
      if (trimmed.startsWith("data:")) {
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") { if (onDone) onDone(); continue; }
        onEvent(payload);
      }
    }
  };
  return {
    feed,
    end() {
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data:")) {
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") { if (onDone) onDone(); }
          else onEvent(payload);
        }
      }
      buffer = "";
    },
  };
}

function writeSSE(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function writeDone(res) {
  res.write("data: [DONE]\n\n");
}

module.exports = { createParser, writeSSE, writeDone };
