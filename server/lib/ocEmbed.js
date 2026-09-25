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

module.exports = { STUB_NAMES, STUB_DESC, stub14, unionWith, enrich, toolName };
