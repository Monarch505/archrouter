"use strict";
/*
 * test-auth-store.js — api_keys persistence, including the migration for
 * databases created before is_active existed.
 *
 * Uses a throwaway ARCHROUTER_HOME so the live database is never touched.
 * Run: node server/test-auth-store.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

let pass = 0;
function ok(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      throw new Error("use the sync wrapper for this suite");
    }
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "archrouter-authstore-"));
process.env.ARCHROUTER_HOME = HOME;
const DATA = path.join(HOME, "data");
fs.mkdirSync(DATA, { recursive: true });
const DB_PATH = path.join(DATA, "archrouter.db");

// Pre-create the schema as d3402f9 shipped it: no is_active column.
const legacy = new DatabaseSync(DB_PATH);
legacy.exec(`
  CREATE TABLE api_keys (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
  );
`);
legacy.prepare("INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES (?,?,?,?,?)")
  .run("legacy-1", "old", "hash-old", "sk-arch-old", "2026-01-01T00:00:00.000Z");
legacy.close();

const auth = require("./lib/auth.js");
const store = require("./lib/store.js");

ok("migration: existing api_keys gains is_active, old row defaults to enabled", () => {
  const rows = store.listApiKeys();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, "legacy-1");
  assert.strictEqual(rows[0].active, true, "pre-existing keys must stay enabled");
  assert.strictEqual(rows[0].revoked, false);
});

ok("countActiveApiKeys counts enabled and disabled, countEnabledApiKeys only enabled", () => {
  const fresh = auth.newKey();
  const inserted = store.insertApiKey({ id: "k-new", name: "fresh", keyHash: auth.sha256hex(fresh), prefix: auth.displayPrefix(fresh) });
  assert.strictEqual(inserted.active, true);
  assert.strictEqual(store.countActiveApiKeys(), 2);
  assert.strictEqual(store.countEnabledApiKeys(), 2);

  store.setApiKeyActive("k-new", false);
  assert.strictEqual(store.countActiveApiKeys(), 2, "disabling must not hide the key");
  assert.strictEqual(store.countEnabledApiKeys(), 1, "a disabled key must not satisfy auto mode");
});

ok("setApiKeyActive is what the verifier sees", () => {
  const k = auth.newKey();
  store.insertApiKey({ id: "k-toggle", name: "toggle", keyHash: auth.sha256hex(k), prefix: auth.displayPrefix(k) });
  const verify = auth.makeVerifier({
    lookup: (h) => {
      const row = store.findApiKeyByHash(h);
      return row ? { id: row.id, active: row.active, revoked: row.revoked } : null;
    },
  });
  assert.strictEqual(verify(k).ok, true);
  store.setApiKeyActive("k-toggle", false);
  const off = verify(k);
  assert.strictEqual(off.ok, false);
  assert.strictEqual(off.reason, "inactive");
  assert.strictEqual(off.id, "k-toggle", "the key keeps its identity for the audit trail");
  store.setApiKeyActive("k-toggle", true);
  assert.strictEqual(verify(k).ok, true, "re-enabling must work without rotating the secret");
});

ok("revoked keys leave both counters", () => {
  store.setApiKeyActive("k-new", true);
  store.setApiKeyActive("k-toggle", true);
  assert.strictEqual(store.countEnabledApiKeys(), 3, "legacy-1 is still enabled at this point");
  store.revokeApiKey("legacy-1");
  const row = store.listApiKeys().find((r) => r.id === "legacy-1");
  assert.strictEqual(row.revoked, true);
  assert.strictEqual(store.countActiveApiKeys(), 2, "revoked key drops out of both counters");
  assert.strictEqual(store.countEnabledApiKeys(), 2);
});

ok("disabling every key leaves auto mode open instead of locking out", () => {
  for (const r of store.listApiKeys()) if (!r.revoked) store.setApiKeyActive(r.id, false);
  assert.strictEqual(store.countActiveApiKeys(), 2);
  assert.strictEqual(store.countEnabledApiKeys(), 0);
  const state = auth.resolveAuthRequired({ mode: "auto", activeKeys: store.countEnabledApiKeys() });
  assert.strictEqual(state.required, false);
});

// The DB holds only hashes, but hashes are crackable offline: 0644 (the
// default umask) would hand them to every local account. getDb() must chmod
// 600 on open — including on a file an older version created as 0644, which is
// exactly the file this suite just built with the legacy schema.
ok(`the api-key database is mode 600${process.platform === "win32" ? " (skipped: no POSIX modes on Windows)" : ""}`, () => {
  if (process.platform === "win32") return;
  const mode = fs.statSync(DB_PATH).mode & 0o777;
  assert.strictEqual(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

store.close();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed`);
if (process.exitCode) console.log("FAILED");
