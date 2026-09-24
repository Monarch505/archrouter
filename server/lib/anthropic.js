"use strict";
/*
 * anthropic.js — converters between Anthropic /v1/messages format and the
 * OpenAI chat/completions format used by the opencode endpoint.
 *
 * Request  (Anthropic -> OpenAI):
 *   system, messages[{role,content(string|blocks)}], max_tokens, temperature,
 *   top_p, stream, stop_sequences, tools, tool_choice
 *
 * Response (OpenAI SSE -> Anthropic SSE):
 *   role block   -> message_start + content_block_start(content_block)
 *   delta block  -> content_block_delta(text_delta)
 *   finish       -> message_delta(stop_reason) + content_block_stop + message_stop
 */

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b.type === "text") return b.text || "";
        if (b.type === "image" || b.type === "image_url") return "[image]";
        return "";
      })
      .join("");
  }
  return String(content ?? "");
}

function toOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = Array.isArray(body.system) ? body.system.map((s) => (typeof s === "string" ? s : s.text || "")).join("\n") : body.system;
    messages.push({ role: "system", content: sys });
  }
  for (const m of body.messages || []) {
    const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : "user";
    messages.push({ role, content: normalizeContent(m.content) });
  }
  const out = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens ?? 1024,
    stream: !!body.stream,
  };
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.tools != null) out.tools = body.tools;
  if (body.tool_choice != null) out.tool_choice = body.tool_choice;
  if (body.stream_options != null) out.stream_options = body.stream_options;
  return out;
}

function openAIMessageToAnthropic(msg) {
  const role = msg.role === "assistant" ? "assistant" : "user";
  const content = Array.isArray(msg.content)
    ? msg.content.map((p) => {
        if (p.type === "text") return { type: "text", text: p.text || "" };
        if (p.type === "image_url") return { type: "text", text: "[image]" };
        return { type: "text", text: "" };
      })
    : [{ type: "text", text: String(msg.content ?? "") }];
  return { role, content };
}

function openAIChatToAnthropic(json) {
  const messages = [];
  for (const c of json.choices || []) {
    if (c.message) messages.push(openAIMessageToAnthropic(c.message));
    if (c.delta) messages.push(openAIMessageToAnthropic(c.delta));
  }
  return {
    id: json.id,
    type: "message",
    role: "assistant",
    content: messages.flatMap((m) => m.content),
    model: json.model,
    stop_reason: json.choices?.[0]?.finish_reason || null,
    stop_sequence: null,
    usage: json.usage ? {
      input_tokens: json.usage.prompt_tokens ?? 0,
      output_tokens: json.usage.completion_tokens ?? 0,
    } : null,
  };
}

module.exports = { toOpenAI, openAIChatToAnthropic, openAIMessageToAnthropic };
