"use strict";
/*
 * ocEmbed.js — OC_EMBED canonical-14 stub tools (port of 9router-fix oc-stub14.json).
 *
 * Upstream gate: canonical-names MUST be a subset of request tool-names AND
 * stream:true. Thin clients (no tools) get 403. Sending the 14 stubs satisfies
 * the gate with zero fake-call risk: "Internal compatibility entry. Do not call."
 * unionWith(clientTools): stubs ∪ client tools, deduped by name (stubs never
 * override real client tools).
 */

const STUB_DESC = "Internal compatibility entry. Do not call.";

const STUB_NAMES = [
  "bash",
  "edit",
  "glob",
  "grep",
  "list_mcp_resource_templates",
  "list_mcp_resources",
  "read",
  "read_mcp_resource",
  "skill",
  "task",
  "todowrite",
  "webfetch",
  "websearch",
  "write",
];

function stubTool(name) {
  return {
    type: "function",
    function: {
      name,
      description: STUB_DESC,
      parameters: { type: "object", properties: {} },
    },
  };
}

function stub14() {
  return STUB_NAMES.map(stubTool);
}

function toolName(t) {
  if (!t || typeof t !== "object") return null;
  if (t.type === "function" && t.function && typeof t.function.name === "string") return t.function.name;
  if (typeof t.name === "string") return t.name; // {name, ...} shape
  return null;
}

/**
 * Union stubs with client tools. Client tools win on name conflict.
 * Returns a NEW array; input untouched. Non-array input → stubs alone.
 */
function unionWith(clientTools) {
  const byName = new Map(STUB_NAMES.map((n) => [n, stubTool(n)]));
  if (Array.isArray(clientTools)) {
    for (const t of clientTools) {
      const n = toolName(t);
      if (!n) continue;
      byName.set(n, t); // client tool wins on name conflict
    }
  }
  return [...byName.values()];
}

/**
 * REFERENCE-SYNC v6.6 (78223 ocEnrich, absent-only defaults) + v6.8 union:
 * - tools: union canonical ∪ client (client-wins, tanpa gerbang <75)
 * - max_tokens 32000 bila absen
 * - stream_options {include_usage:true} bila stream:true & absen
 * - tool_choice "auto" bila ada tools & absen
 * Input tidak dimutasi; non-object/array/null → dikembalikan apa adanya.
 */
function enrich(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  let b = body;
  const tools = unionWith(b.tools);
  if (tools.length && tools !== b.tools) b = { ...b, tools };
  if (b.max_tokens === undefined) b = { ...b, max_tokens: 32000 };
  if (b.stream === true && b.stream_options === undefined) b = { ...b, stream_options: { include_usage: true } };
  if (b.tools && b.tool_choice === undefined) b = { ...b, tool_choice: "auto" };
  return b;
}

/*
 * REFERENCE v6.11 (primer reasoning), scope B (chat + responses):
 * client tidak mengirim setelan effort → router isi default "high" supaya
 * model tidak pernah males mikir. Aturan:
 * - Effort eksplisit klien DIHORMATI (termasuk "none") → tidak disentuh.
 * - xhigh|max di-clip ke high SEBELUM primer (pola reference rb()).
 * - responses: reasoning absen total → {effort:"high", summary:"auto"};
 *   reasoning ada tanpa effort → isi effort, pertahankan summary klien
 *   (perbaikan atas bug reference yang menimpa summary klien).
 * - chat: reasoning_effort absen → "high".
 */
const EFFORT_CLAMP = { xhigh: "high", max: "high" };

function clampEffort(v) {
  return typeof v === "string" && EFFORT_CLAMP[v] ? EFFORT_CLAMP[v] : v;
}

function primer(body, kind = "chat") {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  let b = body;
  if (typeof b.reasoning_effort === "string") {
    const c = clampEffort(b.reasoning_effort);
    if (c !== b.reasoning_effort) b = { ...b, reasoning_effort: c };
    return b; // pilihan eksplisit klien (termasuk "none") → hormati
  }
  if (b.reasoning !== undefined) {
    if (kind === "responses" && b.reasoning && typeof b.reasoning === "object" && b.reasoning.effort === undefined) {
      b = { ...b, reasoning: { ...b.reasoning, effort: "high", summary: b.reasoning.summary ?? "auto" } };
    }
    return b; // klien sudah set reasoning → hormati
  }
  if (kind === "responses") {
    return { ...b, reasoning: { effort: "high", summary: "auto" } };
  }
  return { ...b, reasoning_effort: "high" };
}

/**
 * REFERENCE v5-v6 (u() inline normalization, light): body Responses-API
 * dinormalkan sebelum forward ke /zen/v1/responses:
 * - max_tokens/max_completion_tokens → max_output_tokens (lalu dihapus)
 * - reasoning_effort (string) → reasoning {effort, summary:"auto"};
 *   xhigh|max di-clip; effort "none" → reasoning DIHAPUS (client bilang
 *   jangan mikir → kirim field-nya saja, sama seperti pola reference rb()).
 * Input tidak dimutasi; non-object/array/null → passthrough.
 */
function normalizeResponses(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  let b = body;
  if (b.max_output_tokens === undefined) {
    if (b.max_completion_tokens !== undefined) b = { ...b, max_output_tokens: b.max_completion_tokens };
    else if (b.max_tokens !== undefined) b = { ...b, max_output_tokens: b.max_tokens };
  }
  if (b.max_tokens !== undefined || b.max_completion_tokens !== undefined) {
    b = { ...b };
    delete b.max_tokens;
    delete b.max_completion_tokens;
  }
  const effortRaw = typeof b.reasoning_effort === "string" ? b.reasoning_effort
    : (b.reasoning && typeof b.reasoning === "object" && !Array.isArray(b.reasoning) ? b.reasoning.effort : undefined);
  if (typeof effortRaw === "string") {
    const eff = clampEffort(effortRaw.toLowerCase().trim());
    b = { ...b };
    delete b.reasoning_effort;
    if (eff === "none") {
      delete b.reasoning;
    } else {
      const d = b.reasoning && typeof b.reasoning === "object" && !Array.isArray(b.reasoning) ? b.reasoning : {};
      b.reasoning = { ...d, effort: eff };
      if (!b.reasoning.summary) b.reasoning.summary = "auto";
    }
  }
  return b;
}

module.exports = { STUB_NAMES, STUB_DESC, stub14, unionWith, enrich, primer, normalizeResponses, toolName };
