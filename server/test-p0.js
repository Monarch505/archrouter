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
ok("parseError 429 WITHOUT any limit marker still rotates (status alone is the signal)", () => {
  const p = new OpenCodeProvider({});
  const before = p.ocSession;
  const r = p.parseError(429, JSON.stringify({ error: { message: "Upstream request failed: Endpoint is unavailable" } }));
  assert.ok(r, "429 must never fall through to the pass-through path");
  assert.strictEqual(r.poolScoped.reason, "ip-limit");
  assert.notStrictEqual(p.ocSession, before);
});
ok("parseError 429 with an empty body still rotates", () => {
  const p = new OpenCodeProvider({});
  const before = p.ocSession;
  const r = p.parseError(429, "");
  assert.ok(r && r.poolScoped.reason === "ip-limit");
  assert.notStrictEqual(p.ocSession, before);
});
ok("requestLog keeps session + egress so the log can be analysed", () => {
  const { RequestLog } = require("./lib/requestLog.js");
  const rl = new RequestLog();
  const e = rl.push({ status: 429, rotated: true, session: "ses_test", egress: "203.0.113.7" });
  assert.strictEqual(e.session, "ses_test");
  assert.strictEqual(e.egress, "203.0.113.7");
  assert.strictEqual(rl.recent(1)[0].session, "ses_test");
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

// Auth: key extraction and verification. The DB lookup is injected, so these
// stay offline and never touch ~/.archrouter.
const auth = require("./lib/auth.js");
ok("auth: key format + prefix", () => {
  const k = auth.newKey();
  assert.match(k, /^sk-arch-[A-Za-z0-9_-]{32}$/);
  assert.ok(auth.displayPrefix(k).startsWith("sk-arch-"));
  assert.ok(!auth.displayPrefix(k).includes(k.slice(10, 20)), "display prefix must not leak the secret");
});
ok("auth: extractKey from Bearer / raw / x-archrouter-key, ignores ?key=", () => {
  assert.strictEqual(auth.extractKey({ headers: { authorization: "Bearer abc123" } }), "abc123");
  assert.strictEqual(auth.extractKey({ headers: { authorization: "bearer  abc123 " } }), "abc123");
  assert.strictEqual(auth.extractKey({ headers: { authorization: "abc123" } }), "abc123");
  assert.strictEqual(auth.extractKey({ headers: { "x-archrouter-key": "abc123" } }), "abc123");
  assert.strictEqual(auth.extractKey({ headers: {} }), "");
  assert.strictEqual(auth.extractKey({ headers: {}, url: "/v1/models?key=abc123" }), "");
});
ok("auth: no credential configured = everything open", () => {
  const v = auth.makeVerifier({});
  assert.strictEqual(v("").ok, true);
  assert.strictEqual(v("anything").ok, true);
});
ok("auth: static ARCHROUTER_KEY only", () => {
  const v = auth.makeVerifier({ staticKey: "sk-arch-static" });
  assert.strictEqual(v("sk-arch-static").ok, true);
  assert.strictEqual(v("sk-arch-wrong").ok, false);
  assert.strictEqual(v("").ok, false);
  assert.strictEqual(v("").reason, "missing-key");
});
ok("auth: dashboard keys — hash lookup, revoked rejected, unknown rejected", () => {
  const good = auth.newKey();
  const revoked = auth.newKey();
  const db = new Map([
    [auth.sha256hex(good), { id: "k1", revoked: false }],
    [auth.sha256hex(revoked), { id: "k2", revoked: true }],
  ]);
  const v = auth.makeVerifier({ lookup: (hash) => db.get(hash) || null });
  assert.strictEqual(v(good).ok, true);
  assert.strictEqual(v(good).id, "k1");
  assert.strictEqual(v(revoked).ok, false);
  assert.strictEqual(v(revoked).reason, "revoked");
  assert.strictEqual(v(auth.newKey()).reason, "unknown-key");
  assert.strictEqual(v("").reason, "missing-key");
});
ok("auth: static key wins over db, db still usable", () => {
  const dbKey = auth.newKey();
  const db = new Map([[auth.sha256hex(dbKey), { id: "k1", revoked: false }]]);
  const v = auth.makeVerifier({ staticKey: "sk-arch-env", lookup: (h) => db.get(h) || null });
  assert.strictEqual(v("sk-arch-env").reason, "static");
  assert.strictEqual(v(dbKey).reason, "db");
});
ok("auth: constant-time compare rejects prefix truncation", () => {
  assert.strictEqual(auth.equalConstantTime("sk-arch-abcdef", "sk-arch-abcdef"), true);
  assert.strictEqual(auth.equalConstantTime("sk-arch-abcdef", "sk-arch-abcdeg"), false);
  assert.strictEqual(auth.equalConstantTime("sk-arch-abc", "sk-arch-abcdef"), false);
});
ok("auth: disabled key is refused but keeps its identity", () => {
  const k = auth.newKey();
  const db = new Map([[auth.sha256hex(k), { id: "k9", active: false, revoked: false }]]);
  const v = auth.makeVerifier({ lookup: (h) => db.get(h) || null });
  assert.strictEqual(v(k).ok, false);
  assert.strictEqual(v(k).reason, "inactive");
  assert.strictEqual(v(k).id, "k9");
});
ok("auth mode: --no-auth beats env, env beats config, config beats auto", () => {
  const R = auth.resolveAuthRequired;
  assert.deepStrictEqual(R({ mode: "on", noAuthFlag: true, envFlag: "1" }), { required: false, source: "--no-auth" });
  assert.deepStrictEqual(R({ mode: "on", envFlag: "0" }), { required: false, source: "ARCHROUTER_REQUIRE_AUTH" });
  assert.deepStrictEqual(R({ mode: "off", envFlag: "1" }), { required: true, source: "ARCHROUTER_REQUIRE_AUTH" });
  assert.deepStrictEqual(R({ mode: "on" }), { required: true, source: "config" });
  assert.deepStrictEqual(R({ mode: "off", activeKeys: 5 }), { required: false, source: "config" });
});
ok("auth mode: auto stays open until a usable key exists", () => {
  const R = auth.resolveAuthRequired;
  assert.deepStrictEqual(R({ mode: "auto", activeKeys: 0 }), { required: false, source: "auto" });
  assert.deepStrictEqual(R({ mode: "auto", activeKeys: 1 }), { required: true, source: "auto" });
  assert.deepStrictEqual(R({ mode: "auto", staticKey: "sk-arch-x" }), { required: true, source: "auto" });
  assert.strictEqual(auth.normalizeMode("nonsense"), "auto");
  assert.strictEqual(auth.normalizeMode(undefined), "auto");
  assert.strictEqual(auth.normalizeMode("on"), "on");
});

// Free-only: paid ids must not be catalogued and must not run.
const { isFreeModel, freeOnlyEnabled } = require("./lib/modelCaps.js");
ok("free-only: -free suffix decides, prefix is irrelevant", () => {
  assert.strictEqual(isFreeModel("space-bunny-free"), true);
  assert.strictEqual(isFreeModel("oc/space-bunny-free"), true);
  assert.strictEqual(isFreeModel("combo/Jev"), false);
  assert.strictEqual(isFreeModel("claude-opus-5-5"), false);
  assert.strictEqual(isFreeModel("muse-spark-1.3"), false, "the paid sibling of a -free model");
  assert.strictEqual(isFreeModel("muse-spark-1.3-contributor-free"), true);
  assert.strictEqual(isFreeModel(""), false);
  assert.strictEqual(freeOnlyEnabled({}), true, "on unless told otherwise");
  assert.strictEqual(freeOnlyEnabled({ models: { freeOnly: false } }), false);
});
ok("free-only: resolveModel rejects a paid id, accepts a free one", () => {
  const cfg = { models: { freeOnly: true } };
  const r = Object.create(Router.prototype);
  r.config = cfg;
  assert.strictEqual(r.resolveModel("oc/space-bunny-free").bare, "space-bunny-free");
  assert.throws(() => r.resolveModel("oc/claude-opus-5-5"), (e) => e.status === 400 && e.code === "model_not_free");
  assert.throws(() => r.resolveModel("claude-sonnet-5"), /only free models/);
  // a combo is resolved first, so its target is what gets judged
  r.config = { ...cfg, combos: { Paid: "claude-opus-5-5", Free: "space-bunny-free" } };
  assert.throws(() => r.resolveModel("Paid"), (e) => e.code === "model_not_free");
  assert.strictEqual(r.resolveModel("combo/Free").bare, "space-bunny-free");
});

// opencode.json fragment: models come from the live list, variants from
// modelCaps, and a merge must not disturb other providers.
const opencodeConfig = require("./lib/opencodeConfig.js");
const { capsFor, variantsFor } = require("./lib/modelCaps.js");
ok("caps: curated table + free/paid alias", () => {
  assert.deepStrictEqual(capsFor("oc/mimo-v2.5-free").efforts, ["low", "medium", "high"]);
  assert.strictEqual(capsFor("oc/mimo-v2.5-free").kind, "chat");
  assert.strictEqual(capsFor("mimo-v2.5").kind, "chat", "paid id must resolve from the -free entry");
  assert.strictEqual(capsFor("oc/muse-spark-1.3-contributor-free").kind, "responses");
  assert.deepStrictEqual(capsFor("oc/jev-1.13-free").efforts, []);
  assert.strictEqual(capsFor("oc/deepseek-v4-flash-free").kind, "unavailable");
  assert.strictEqual(capsFor("oc/some-new-upstream-model").kind, "chat", "unknown model stays usable");
  assert.strictEqual(variantsFor("oc/jev-1.13-free"), null, "no reasoning → no variants");
  assert.strictEqual(variantsFor("oc/muse-spark-1.3-contributor-free").high.reasoningEffort, "high");
});
ok("opencode fragment: skips only unavailable, variants per model, openai-compatible npm", () => {
  const frag = opencodeConfig.buildFragment({
    host: "127.0.0.1", port: 20399,
    modelIds: ["oc/mimo-v2.5-free", "oc/jev-1.13-free", "oc/deepseek-v4-flash-free", "oc/muse-spark-1.3-contributor-free"],
  });
  const p = frag.provider.archrouter;
  assert.strictEqual(p.npm, "@ai-sdk/openai-compatible");
  assert.strictEqual(p.options.baseURL, "http://127.0.0.1:20399/v1");
  // deepseek is the only drop: upstream-unavailable. jev (systemone) and
  // muse-spark (responses) cannot be reached via /v1/chat/completions but stay
  // listed on purpose — recorded in opencodeConfig.js, not hidden.
  assert.deepStrictEqual(Object.keys(p.models), ["mimo-v2.5-free", "jev-1.13-free", "muse-spark-1.3-contributor-free"]);
  assert.deepStrictEqual(Object.keys(p.models["mimo-v2.5-free"].variants), ["low", "medium", "high"]);
  assert.strictEqual(p.models["jev-1.13-free"].variants, undefined);
  assert.deepStrictEqual(Object.keys(p.models["muse-spark-1.3-contributor-free"].variants), ["high"]);
});
ok("opencode merge: keeps other providers, agents and the top-level model", () => {
  const frag = opencodeConfig.buildFragment({ modelIds: ["oc/mimo-v2.5-free"] });
  const existing = {
    $schema: "https://opencode.ai/config.json",
    model: "9router/Big-P",
    provider: { "9router": { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:20128/v1" } } },
    agent: { explorer: { model: "OcRouter/Big-P" } },
  };
  const merged = opencodeConfig.mergeFragment(existing, frag);
  assert.strictEqual(merged.model, "9router/Big-P");
  assert.strictEqual(merged.provider["9router"].options.baseURL, "http://127.0.0.1:20128/v1");
  assert.strictEqual(merged.agent.explorer.model, "OcRouter/Big-P");
  assert.ok(merged.provider.archrouter.models["mimo-v2.5-free"]);
});
// Regression guard for a wrong premise that shipped in this file: the old
// comment here claimed opencode reads the catalog from a custom provider's
// /v1/models on its own. It does not. Verified on opencode 1.18.3 — the catalog
// is models.dev plus the static `models` map, auto-discovery is hardcoded to
// Ollama/LM Studio/vLLM, and a provider without a models block reports
// "Provider not found". So the static list is the default shape.
ok("opencode minimal entry drops the models block on purpose and is NOT a usable config", () => {
  const frag = opencodeConfig.buildFragment({ includeModels: false });
  const p = frag.provider.archrouter;
  assert.strictEqual(p.npm, "@ai-sdk/openai-compatible");
  assert.strictEqual(p.options.baseURL, "http://127.0.0.1:20399/v1");
  assert.strictEqual(p.models, undefined);
  assert.ok(!("models" in JSON.parse(JSON.stringify(p))), "no models key may reach the file");
});
ok("opencode entry defaults to a models block (opencode does not auto-discover /v1/models)", () => {
  // The default path must still be the static one; only --no-models opts out.
  assert.ok(typeof opencodeConfig.buildFragment({}).provider.archrouter.models === "object");
  assert.ok(opencodeConfig.buildFragment({ includeModels: false }).provider.archrouter.models === undefined);
  const real = opencodeConfig.buildFragment({ modelIds: ["space-bunny-free"] });
  assert.ok(real.provider.archrouter.models["space-bunny-free"], "a listed id must reach the catalog");
  assert.strictEqual(opencodeConfig.buildProvider().archrouter.name, "archrouter", "display name is written");
});
ok("opencode entry carries the apiKey so an auth-required router answers /v1/models", () => {
  const p = opencodeConfig.buildProvider({ apiKey: "sk-arch-test" }).archrouter;
  assert.strictEqual(p.options.apiKey, "sk-arch-test");
  assert.ok(!("apiKey" in opencodeConfig.buildProvider({}).archrouter.options), "no empty apiKey written");
});
ok("opencode minimal write replaces a stale models block instead of leaving it", () => {
  const minimal = opencodeConfig.buildFragment({ includeModels: false });
  const existing = {
    provider: { archrouter: { models: { "claude-opus-5-5": { name: "claude-opus-5-5" } } }, "9router": { npm: "x" } },
  };
  const merged = opencodeConfig.mergeFragment(existing, minimal);
  assert.strictEqual(merged.provider.archrouter.models, undefined);
  assert.ok(merged.provider["9router"], "other providers untouched");
  const onDisk = JSON.parse(JSON.stringify(merged));
  assert.ok(!("models" in onDisk.provider.archrouter));
});

// A CRLF inside a shell script makes Linux refuse it ("bad interpreter:
// /bin/bash^M"). core.autocrlf=true is the default on Windows checkouts, so
// .gitattributes must pin LF and the committed blobs must actually be LF.
ok("line endings: shell scripts are LF in the tree and in the committed blobs", () => {
  const fs = require("fs");
  const path = require("path");
  const { execFileSync } = require("child_process");
  const repo = path.join(__dirname, "..");
  const attrs = fs.readFileSync(path.join(repo, ".gitattributes"), "utf8");
  for (const rule of ["*.sh text eol=lf", "setup.sh text eol=lf"]) {
    assert.ok(
      attrs.split(/\r?\n/).includes(rule),
      `.gitattributes must contain the exact rule: ${rule}`,
    );
  }
  const files = ["setup.sh", "archrouter", "install.sh", "scripts/test-setup-sh.sh", "scripts/test-setup-flow.sh"];
  for (const f of files) {
    const onDisk = fs.readFileSync(path.join(repo, f));
    assert.ok(!onDisk.includes(Buffer.from("\r\n")), `${f} has CRLF in the working tree`);
  }
  // Raw buffer read: piping git through a shell can add CR on its own.
  let blobs = 0;
  for (const f of files) {
    let buf;
    try {
      buf = execFileSync("git", ["-C", repo, "cat-file", "blob", `HEAD:${f}`], { maxBuffer: 8 << 20 });
    } catch {
      continue; // not committed yet (fresh clone of a dirty tree)
    }
    blobs++;
    assert.ok(!buf.includes(Buffer.from("\r\n")), `committed ${f} has CRLF — Linux would refuse to run it`);
  }
  assert.ok(blobs > 0, "no committed shell script could be inspected");
});

async function okAsync(name, fn) {
  try { await fn(); pass += 1; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}: ${e.message}`); process.exitCode = 1; }
}

// End-to-end 429 rotation, hermetic: fake pool on 127.0.0.1:0, upstream
// stubbed — no real network, no real WARP (AGENTS rule 5).
(async () => {
  const http = require("http");
  const transport = require("./lib/transport.js");
  const realDoRequest = transport.doRequest;
  const reports = [];
  const seq = [];
  const sessions = [];
  let pool = null;
  try {
    pool = http.createServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          instances: [{ id: "a", public_ip: "203.0.113.7" }, { id: "b", public_ip: "203.0.113.8" }],
          last_serve: { "opencode.ai": "a" },
        }));
      }
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        seq.push("report");
        try { reports.push(JSON.parse(raw || "{}")); } catch { reports.push({}); }
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolve) => pool.listen(0, "127.0.0.1", resolve));
    const statusUrl = `http://127.0.0.1:${pool.address().port}`;

    transport.doRequest = async (opts) => {
      if (opts.target.hostname === "127.0.0.1") return realDoRequest(opts);
      sessions.push(opts.headers["x-opencode-session"]);
      seq.push("req");
      return { status: 429, headers: {}, text: async () => JSON.stringify({ error: { message: "Upstream request failed: Endpoint is unavailable" } }) };
    };

    const proxyRouter = {
      mode: "warp",
      nextProxy: () => "socks5h://127.0.0.1:11801",
      reportLimit: () => {},
      reportFailure: () => {},
      reportBadProxy: () => {},
    };
    const config = { retries: 3, baseUrl: "https://opencode.ai", proxy: { warp: { statusUrl } } };
    const r = new Router({ config, proxyRouter, modelCache: null });

    await okAsync("429 rotation is one package: fresh session per attempt + report before next attempt + egress IP in the log", async () => {
      const out = await r.forward({ body: { model: "mimo-v2.6-flash-free", messages: [{ role: "user", content: "hi" }], stream: true } });
      assert.strictEqual(out.status, 429, `expected the capped 429, got ${out.status}`);
      assert.strictEqual(sessions.length, 3, `expected 3 upstream attempts, got ${sessions.length}`);
      assert.strictEqual(new Set(sessions).size, 3, `every attempt must carry a fresh session: ${sessions.join(",")}`);
      assert.strictEqual(reports.length, 3, `every 429 must be reported to the pool, got ${reports.length}`);
      assert.ok(reports.every((x) => x.event === "freeusagelimit"), JSON.stringify(reports));
      assert.deepStrictEqual(seq, ["req", "report", "req", "report", "req", "report"], "the pool report must be awaited before the next attempt (IP a→b, then session+1)");
      const rotations = r.logs.entries.filter((e) => e.type === "rotation");
      assert.strictEqual(rotations.length, 3, `expected 3 rotation entries, got ${rotations.length}`);
      for (const [i, e] of rotations.entries()) {
        assert.strictEqual(e.session, sessions[i], `rotation entry ${i} must name the session that got the 429`);
        assert.strictEqual(e.egress, "203.0.113.7", `rotation entry ${i} must name the burned egress IP`);
      }
      assert.strictEqual(out.session, sessions[2], "final response must carry the session actually used");
      assert.strictEqual(out.egress, "203.0.113.7", "final response must carry the egress IP");
    });
  } catch (e) {
    console.error(`FAIL - async setup: ${e.message}`);
    process.exitCode = 1;
  } finally {
    transport.doRequest = realDoRequest;
    if (pool) {
      if (pool.closeAllConnections) pool.closeAllConnections();
      await new Promise((resolve) => pool.close(resolve));
    }
  }

  // Deploy proof: `version` must name the live HEAD, /health must echo the
  // commit cmdStart injects — otherwise "restarted, now on the new code" is
  // an assumption. Health server = detached child (rule 11), sandboxed home
  // (rule 5), polled to a deadline (rule 1), killed by process group.
  await okAsync("version prints the live git commit (deploy proof)", async () => {
    const { execFileSync } = require("child_process");
    const path = require("path");
    const out = execFileSync(process.execPath, [path.join(__dirname, "..", "archrouter.js"), "version"], { encoding: "utf8" });
    assert.match(out, /commit=[0-9a-f]{7,40}/, `no commit in: ${out.trim()}`);
    assert.ok(!out.includes("commit=unknown"), `the repo must resolve its own HEAD: ${out.trim()}`);
  });

  let healthChild = null;
  let healthHome = null;
  try {
    await okAsync("/health echoes the running commit (deploy proof)", async () => {
      const net = require("net");
      const fs = require("fs");
      const os = require("os");
      const path = require("path");
      const { spawn } = require("child_process");
      healthHome = fs.mkdtempSync(path.join(os.tmpdir(), "archrouter-health-"));
      const port = await new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on("error", reject);
        s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
      });
      healthChild = spawn(process.execPath, [path.join(__dirname, "server.js"), "--port", String(port), "--host", "127.0.0.1"], {
        env: { ...process.env, ARCHROUTER_HOME: healthHome, HOME: healthHome, USERPROFILE: healthHome, ARCHROUTER_COMMIT: "deadbee" },
        detached: true,
        stdio: "ignore",
      });
      healthChild.unref();
      const deadline = Date.now() + 90000;
      let health = null;
      for (;;) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          health = await res.json();
          if (health && health.status === "ok") break;
        } catch {}
        if (Date.now() >= deadline) assert.fail("/health did not answer within 90s — poll to a deadline, never a fixed wait");
        await new Promise((r) => setTimeout(r, 300));
      }
      assert.strictEqual(health.commit, "deadbee", `health = ${JSON.stringify(health)}`);
    });
  } finally {
    if (healthChild) { try { process.kill(-healthChild.pid, "SIGKILL"); } catch { try { healthChild.kill("SIGKILL"); } catch {} } }
    if (healthHome) { try { require("fs").rmSync(healthHome, { recursive: true, force: true }); } catch {} }
  }

  // Leak audit 2026-10-07: the catalog refresh must ride the proxy the chat
  // attempts ride (warp = pool SOCKS) — a direct fetch hands opencode.ai the
  // device IP on a 300s timer. Fails without the proxy wiring (rule 16).
  await okAsync("models catalog fetch goes through the active proxy (never direct)", async () => {
    const transport = require("./lib/transport.js");
    const { ModelCache } = require("./lib/models.js");
    const orig = transport.request;
    let seen = null;
    transport.request = async (opts) => { seen = opts; return { status: 200, json: { data: [{ id: "leaktest-free", object: "model" }] } }; };
    try {
      const mc = new ModelCache({ models: { cacheSeconds: 0 } }, { mode: "warp", nextProxy: () => "socks5h://127.0.0.1:11801" });
      await mc.refresh(true);
    } finally {
      transport.request = orig;
    }
    assert.ok(seen, "transport.request never called");
    assert.strictEqual(seen.proxy, "socks5h://127.0.0.1:11801");
    assert.strictEqual(seen.proxyStyle, "socks5");
  });

  console.log(`\n${pass} passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
})();
