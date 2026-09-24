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
ok("parseError 403-no-limit starts cooldown, no identity spam", () => {
  const p = new OpenCodeProvider({});
  const before = p.ocSession;
  const r = p.parseError(403, JSON.stringify({ error: { message: "inner OpenCode error" } }), { forbiddenCooldownMs: 60000, episodeWindowMs: 180000 });
  assert.ok(r && r.poolScoped.reason === "forbidden-cooldown");
  assert.ok(p.inCooldown());
  assert.ok(p.cooldownRemainingMs() > 50000);
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

console.log(`\n${pass} passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
