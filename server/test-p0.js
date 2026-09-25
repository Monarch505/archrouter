"use strict";
// test-p0.js — offline unit tests for P0 patches (run: node test-p0.js).
// No network needed. Exit non-zero on any failure.
const assert = require("assert");
const { Readable } = require("stream");

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}: ${e.message}`); process.exitCode = 1; }
}

const { OpenCodeProvider } = require("./lib/provider.js");
const oc = require("./lib/ocEmbed.js");
const { Router } = require("./lib/router.js");

// P0-1: exact headers
ok("headers: 8 keys + cli + project global + full UA", () => {
  const p = new OpenCodeProvider({ release: "1.18.31" });
  const h = p.buildHeaders();
  assert.strictEqual(Object.keys(h).length, 8, JSON.stringify(Object.keys(h)));
  assert.strictEqual(h["x-opencode-client"], "cli");
  assert.strictEqual(h["x-opencode-project"], "global");
  assert.strictEqual(h.Authorization, "Bearer public");
  assert.strictEqual(h["User-Agent"], "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14");
  assert.strictEqual(h.Accept, "text/event-stream");
  assert.match(h["x-opencode-session"], /^ses_/);
  assert.match(h["x-opencode-request"], /^usr_/);
});
ok("buildUrlFor: responses + systemone", () => {
  const p = new OpenCodeProvider({});
  assert.match(p.buildUrlFor("responses"), /\/zen\/v1\/responses$/);
  assert.match(p.buildUrlFor("systemone"), /\/zen\/v1\/systemone$/);
  assert.match(p.buildUrlFor("chat"), /\/zen\/v1\/chat\/completions$/);
});

// P0-4: 403 cooldown
ok("parseError 429+limit rotates identity", () => {
  const p = new OpenCodeProvider({});
  const before = p.ocSession;
  const r = p.parseError(429, JSON.stringify({ error: { message: "FreeUsageLimitError: rate limit" } }));
  assert.ok(r && r.poolScoped.reason === "ip-limit");
  assert.notStrictEqual(p.ocSession, before);
});
ok("parseError 403-no-limit #1: egress-refresh only, identity kept", () => {
  const p = new OpenCodeProvider({});
  const before = p.ocSession;
  const r = p.parseError(403, JSON.stringify({ error: { message: "inner OpenCode error" } }), { forbiddenCooldownMs: 60000, episodeWindowMs: 180000 });
  assert.ok(r && r.poolScoped.reason === "forbidden-egress");
  assert.strictEqual(p.ocSession, before);
  assert.ok(!p.inCooldown());
});
ok("parseError 403-no-limit #2: identity-refresh + cooldown", () => {
  const p = new OpenCodeProvider({});
  const before = p.ocSession;
  p.parseError(403, JSON.stringify({ error: { message: "inner OpenCode error" } }), { forbiddenCooldownMs: 60000, episodeWindowMs: 180000 });
  const r = p.parseError(403, JSON.stringify({ error: { message: "inner OpenCode error" } }), { forbiddenCooldownMs: 60000, episodeWindowMs: 180000 });
  assert.ok(r && r.poolScoped.reason === "forbidden-identity");
  assert.notStrictEqual(p.ocSession, before);
  assert.ok(p.inCooldown());
  assert.ok(p.cooldownRemainingMs() > 50000);
});
ok("parseError 403 in-cooldown: noRetry, no spin", () => {
  const p = new OpenCodeProvider({});
  p.parseError(403, JSON.stringify({ error: { message: "inner OpenCode error" } }), { forbiddenCooldownMs: 60000, episodeWindowMs: 180000 });
  p.parseError(403, JSON.stringify({ error: { message: "inner OpenCode error" } }), { forbiddenCooldownMs: 60000, episodeWindowMs: 180000 });
  const before = p.ocSession;
  const r = p.parseError(403, JSON.stringify({ error: { message: "inner OpenCode error" } }), { forbiddenCooldownMs: 60000, episodeWindowMs: 180000 });
  assert.ok(r && r.noRetry === true && !r.poolScoped);
  assert.strictEqual(p.ocSession, before);
});

// P0-3: stub14 + union
ok("stub14: 14 names, do-not-call", () => {
  assert.strictEqual(oc.STUB_NAMES.length, 14);
  const s = oc.stub14();
  assert.strictEqual(s.length, 14);
  assert.ok(s.every((t) => t.function.description === oc.STUB_DESC));
});
ok("unionWith: stubs alone when no client tools; client wins on conflict", () => {
  assert.strictEqual(oc.unionWith(undefined).length, 14);
  assert.strictEqual(oc.unionWith([]).length, 14);
  const mine = [{ type: "function", function: { name: "read", description: "MY read", parameters: {} } },
                { type: "function", function: { name: "custom", description: "mine", parameters: {} } }];
  const u = oc.unionWith(mine);
  assert.strictEqual(u.length, 15);
  assert.strictEqual(u.find((t) => t.function.name === "read").function.description, "MY read");
  assert.ok(u.find((t) => t.function.name === "custom"));
});

// REFERENCE-SYNC v6.6: enrich defaults (absent-only)
ok("enrich: thin body → union 14 + max_tokens 32000 + tool_choice auto", () => {
  const b = oc.enrich({ messages: [] });
  assert.strictEqual(b.tools.length, 14);
  assert.strictEqual(b.max_tokens, 32000);
  assert.strictEqual(b.tool_choice, "auto");
  assert.strictEqual(b.stream_options, undefined); // stream bukan true
});
ok("enrich: stream:true → stream_options include_usage; existing values untouched", () => {
  const b = oc.enrich({ stream: true, max_tokens: 100, tool_choice: "none", tools: [] });
  assert.deepStrictEqual(b.stream_options, { include_usage: true });
  assert.strictEqual(b.max_tokens, 100);    // absent-only, jangan timpa
  assert.strictEqual(b.tool_choice, "none");
  assert.strictEqual(b.tools.length, 14);    // tetap di-union
});
ok("enrich: null/array passthrough + input tidak dimutasi", () => {
  assert.strictEqual(oc.enrich(null), null);
  assert.deepStrictEqual(oc.enrich([1]), [1]);
  const orig = { messages: [] };
  oc.enrich(orig);
  assert.strictEqual(orig.max_tokens, undefined);
});

// P0-2: collapseSSE
ok("collapseSSE assembles content + finish_reason + usage", async () => {
  const chunks = [
    'data: {"id":"c1","model":"m","choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"id":"c1","model":"m","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ];
  const rs = Readable.from(chunks);
  const j = await Router.collapseSSE(rs, "m");
  assert.strictEqual(j.object, "chat.completion");
  assert.strictEqual(j.choices[0].message.content, "Hello");
  assert.strictEqual(j.choices[0].finish_reason, "stop");
  assert.deepStrictEqual(j.usage, { prompt_tokens: 3, completion_tokens: 2 });
});
ok("collapseSSE rejects empty stream (no fake completion)", async () => {
  await assert.rejects(Router.collapseSSE(Readable.from(["data: [DONE]\n\n"]), "m"), /empty/);
});

// P1-1: honest-close — summarizeChunks.complete + interrupt payload
const { summarizeChunks, interruptPayload } = require("./routes/chatCompletions.js");
ok("honest-close: finish_reason terlihat → complete=true, usage tertangkap", () => {
  const s = summarizeChunks([
    { kind: "chunk", json: { id: "c1", model: "m", choices: [{ delta: { content: "x" }, finish_reason: "stop" }], usage: { completion_tokens: 5 } } },
    { kind: "done" },
  ]);
  assert.strictEqual(s.complete, true);
  assert.strictEqual(s.finish, "stop");
  assert.deepStrictEqual(s.usage, { completion_tokens: 5 });
});
ok("honest-close: putus tanpa finish_reason → complete=false (wajib interrupt)", () => {
  const s = summarizeChunks([
    { kind: "chunk", json: { id: "c1", model: "m", choices: [{ delta: { content: "partial" } }] } },
    { kind: "done" },
  ]);
  assert.strictEqual(s.complete, false);
  assert.strictEqual(s.finish, null);
});
ok("honest-close: stream kosong → complete=false", () => {
  assert.strictEqual(summarizeChunks([]).complete, false);
});
ok("honest-close: interruptPayload = error type interrupt, bukan finish palsu", () => {
  const p = JSON.parse(interruptPayload("upstream closed without completion"));
  assert.strictEqual(p.error.type, "interrupt");
  assert.strictEqual(p.error.code, "upstream_interrupt");
  assert.strictEqual(p.choices, undefined);
});

// P1-2: primer reasoning (v6.11 scope B — chat + responses, absent-only)
ok("primer chat: effort absen → reasoning_effort high", () => {
  const b = oc.primer({ messages: [] }, "chat");
  assert.strictEqual(b.reasoning_effort, "high");
});
ok("primer chat: effort eksplisit klien dihormati (termasuk none)", () => {
  assert.strictEqual(oc.primer({ reasoning_effort: "none" }, "chat").reasoning_effort, "none");
  assert.strictEqual(oc.primer({ reasoning_effort: "low" }, "chat").reasoning_effort, "low");
});
ok("primer chat: xhigh|max di-clip ke high (pola reference)", () => {
  assert.strictEqual(oc.primer({ reasoning_effort: "xhigh" }, "chat").reasoning_effort, "high");
  assert.strictEqual(oc.primer({ reasoning_effort: "max" }, "chat").reasoning_effort, "high");
});
ok("primer responses: reasoning absen → {effort:high, summary:auto}", () => {
  const b = oc.primer({ input: [] }, "responses");
  assert.deepStrictEqual(b.reasoning, { effort: "high", summary: "auto" });
});
ok("primer responses: reasoning+effort klien utuh, summary diisi bila kosong", () => {
  const b1 = oc.primer({ reasoning: { effort: "low" } }, "responses");
  assert.deepStrictEqual(b1.reasoning, { effort: "low" });
  const b2 = oc.primer({ reasoning: { summary: "detailed" } }, "responses");
  assert.deepStrictEqual(b2.reasoning, { effort: "high", summary: "detailed" });
});
ok("primer: input tidak dimutasi + non-object passthrough", () => {
  const orig = { messages: [] };
  oc.primer(orig, "chat");
  assert.strictEqual(orig.reasoning_effort, undefined);
  assert.strictEqual(oc.primer(null, "chat"), null);
  assert.deepStrictEqual(oc.primer([1], "responses"), [1]);
});

// P1-3: normalizeResponses (light translator, pola u() reference)
ok("normalizeResponses: max_tokens/max_completion_tokens → max_output_tokens", () => {
  const b = oc.normalizeResponses({ max_tokens: 500, input: [] });
  assert.strictEqual(b.max_output_tokens, 500);
  assert.strictEqual(b.max_tokens, undefined);
  const b2 = oc.normalizeResponses({ max_output_tokens: 900, max_tokens: 500 });
  assert.strictEqual(b2.max_output_tokens, 900); // sudah ada → menang
  assert.strictEqual(b2.max_tokens, undefined);
});
ok("normalizeResponses: reasoning_effort → reasoning obj + summary auto; xhigh clip", () => {
  const b = oc.normalizeResponses({ reasoning_effort: "xhigh", input: [] });
  assert.deepStrictEqual(b.reasoning, { effort: "high", summary: "auto" });
  assert.strictEqual(b.reasoning_effort, undefined);
});
ok("normalizeResponses: effort none → reasoning dihapus (jangan mikir)", () => {
  const b = oc.normalizeResponses({ reasoning_effort: "none", input: [] });
  assert.strictEqual(b.reasoning, undefined);
  assert.strictEqual(b.reasoning_effort, undefined);
});
ok("normalizeResponses: effort klien utuh + summary diisi bila kosong", () => {
  const b = oc.normalizeResponses({ reasoning: { effort: "low" }, input: [] });
  assert.deepStrictEqual(b.reasoning, { effort: "low", summary: "auto" });
});
ok("normalizeResponses: tanpa effort → tidak disentuh (primer yang isi nanti)", () => {
  const b = oc.normalizeResponses({ input: [] });
  assert.strictEqual(b.reasoning, undefined);
  assert.strictEqual(b.reasoning_effort, undefined);
});

// P1-3: collapseResponsesSSE (honest: terminal event wajib ada)
ok("collapseResponsesSSE: deltas + response.completed → output_text + usage", async () => {
  const chunks = [
    'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
    'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output_text":"Hello","usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
    "data: [DONE]\n\n",
  ];
  const out = await Router.collapseResponsesSSE(Readable.from(chunks));
  assert.strictEqual(out.id, "resp_1");
  assert.strictEqual(out.output_text, "Hello");
  assert.deepStrictEqual(out.usage, { input_tokens: 3, output_tokens: 2 });
});
ok("collapseResponsesSSE: putus tanpa terminal → reject (no karangan)", async () => {
  const chunks = [
    'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    "data: [DONE]\n\n",
  ];
  await assert.rejects(Router.collapseResponsesSSE(Readable.from(chunks)), /without completion/);
});
ok("collapseResponsesSSE: response.failed → reject dengan pesan upstream", async () => {
  const chunks = [
    'data: {"type":"response.failed","response":{"error":{"message":"quota blown"}}}\n\n',
    "data: [DONE]\n\n",
  ];
  await assert.rejects(Router.collapseResponsesSSE(Readable.from(chunks)), /quota blown/);
});
ok("collapseResponsesSSE: stream kosong → reject", async () => {
  await assert.rejects(Router.collapseResponsesSSE(Readable.from(["data: [DONE]\n\n"])), /empty|without completion/);
});

console.log(`\n${pass} passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
