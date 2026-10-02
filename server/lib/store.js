"use strict";
/*
 * store.js — SQLite persistence for runtime-added data (manual proxies, model
 * combos). Uses node:sqlite (DatabaseSync), no external dependency.
 *
 * Tables:
 *   proxies(url TEXT UNIQUE, added_at TEXT)
 *   combos(name TEXT UNIQUE, model TEXT, added_at TEXT)
 */

const path = require("path");
const os = require("os");
const { DatabaseSync } = require("node:sqlite");

// DB lives in <base>/data/archrouter.db (plug-and-play, repo stays clean).
// <base> = $ARCHROUTER_HOME or <home>/.archrouter. Fallback: repo dir (dev).
// HOME_DIR: $HOME on unix; on Windows HOME is usually NOT set, so fall back to
// os.homedir() (USERPROFILE) — otherwise the DB lands inside the git repo.
// Proven 2026-09-30 (native Windows spike): HOME empty -> data/ inside repo.
const HOME_DIR = process.env.HOME || (() => { try { return os.homedir(); } catch { return null; } })();
const BASE_DIR =
  process.env.ARCHROUTER_HOME ||
  (HOME_DIR ? path.join(HOME_DIR, ".archrouter") : null) ||
  path.join(__dirname, "..");
const DATA_DIR = BASE_DIR === path.join(__dirname, "..")
  ? BASE_DIR
  : path.join(BASE_DIR, "data");
try { require("fs").mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const DB_PATH = path.join(DATA_DIR, "archrouter.db");

let db = null;

function getDb() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxies (
      url      TEXT PRIMARY KEY,
      added_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS combos (
      name     TEXT PRIMARY KEY,
      model    TEXT NOT NULL,
      added_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key      TEXT PRIMARY KEY,
      value    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      prefix       TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at   TEXT,
      is_active    INTEGER NOT NULL DEFAULT 1
    );
    DROP TABLE IF EXISTS aliases;
  `);
  ensureColumn(db, "api_keys", "is_active", "INTEGER NOT NULL DEFAULT 1");
  return db;
}

// Older installs already have api_keys without later columns; CREATE TABLE
// IF NOT EXISTS leaves them untouched, so add what is missing.
function ensureColumn(database, table, column, decl) {
  try {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all();
    if (cols.some((c) => c.name === column)) return false;
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- settings ---------------- */

function getSetting(key) {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSetting(key, value) {
  getDb()
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(key, JSON.stringify(value));
  return value;
}

function getAllSettings() {
  const rows = getDb().prepare("SELECT key, value FROM settings").all();
  const out = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

/* ---------------- proxies ---------------- */

function listProxies() {
  const rows = getDb().prepare("SELECT url, added_at FROM proxies ORDER BY added_at").all();
  return rows.map((r) => ({ url: r.url, added_at: r.added_at }));
}

function addProxy(url) {
  getDb()
    .prepare("INSERT OR IGNORE INTO proxies (url, added_at) VALUES (?, ?)")
    .run(url, new Date().toISOString());
  return listProxies();
}

function removeProxy(url) {
  getDb().prepare("DELETE FROM proxies WHERE url = ?").run(url);
  return listProxies();
}

function seedProxies(urls) {
  const now = new Date().toISOString();
  const ins = getDb().prepare("INSERT OR IGNORE INTO proxies (url, added_at) VALUES (?, ?)");
  for (const u of urls || []) ins.run(u, now);
  return listProxies();
}

/* ---------------- combos ---------------- */

function listCombos() {
  const rows = getDb().prepare("SELECT name, model, added_at FROM combos ORDER BY name").all();
  const out = {};
  for (const r of rows) out[r.name] = { model: r.model, added_at: r.added_at };
  return out;
}

function addCombo(name, model) {
  getDb()
    .prepare("INSERT OR REPLACE INTO combos (name, model, added_at) VALUES (?, ?, ?)")
    .run(name, model, new Date().toISOString());
  return listCombos();
}

function removeCombo(name) {
  getDb().prepare("DELETE FROM combos WHERE name = ?").run(name);
  return listCombos();
}

function seedCombos(combos) {
  const now = new Date().toISOString();
  const ins = getDb().prepare("INSERT OR IGNORE INTO combos (name, model, added_at) VALUES (?, ?, ?)");
  for (const [name, model] of Object.entries(combos || {})) {
    if (typeof model === "string") ins.run(name, model, now);
    else if (model && typeof model.model === "string") ins.run(name, model.model, now);
  }
  return listCombos();
}

/* ---------------- api keys ----------------
 * Only the SHA-256 of a key is persisted. The plaintext is returned once at
 * creation and cannot be recovered afterwards, so a leaked database does not
 * hand out working credentials. */

function listApiKeys() {
  const rows = getDb()
    .prepare("SELECT id, name, key_hash, prefix, created_at, last_used_at, revoked_at, is_active FROM api_keys ORDER BY created_at")
    .all();
  return rows.map((r) => ({ ...r, active: !!r.is_active, revoked: !!r.revoked_at }));
}

function insertApiKey({ id, name, keyHash, prefix }) {
  const now = new Date().toISOString();
  getDb()
    .prepare("INSERT INTO api_keys (id, name, key_hash, prefix, created_at, is_active) VALUES (?, ?, ?, ?, ?, 1)")
    .run(id, name, keyHash, prefix || "", now);
  return { id, name, prefix: prefix || "", created_at: now, last_used_at: null, revoked_at: null, active: true, revoked: false };
}

function findApiKeyByHash(keyHash) {
  const row = getDb()
    .prepare("SELECT id, name, key_hash, prefix, created_at, last_used_at, revoked_at, is_active FROM api_keys WHERE key_hash = ?")
    .get(keyHash);
  if (!row) return null;
  return { ...row, active: !!row.is_active, revoked: !!row.revoked_at };
}

// Pause/resume, the way 9router keeps an isActive flag per key: a disabled key
// stops working immediately but keeps its secret and its history.
function setApiKeyActive(id, active) {
  getDb()
    .prepare("UPDATE api_keys SET is_active = ? WHERE id = ?")
    .run(active ? 1 : 0, id);
  return listApiKeys();
}

function touchApiKey(id) {
  getDb().prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

function revokeApiKey(id) {
  getDb()
    .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), id);
  return listApiKeys();
}

function countActiveApiKeys() {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL").get();
  return row ? Number(row.n) : 0;
}

// Keys that would actually pass verification. Auto mode counts these, so
// disabling every key opens the router again instead of locking it.
function countEnabledApiKeys() {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL AND is_active = 1")
    .get();
  return row ? Number(row.n) : 0;
}

function close() {
  if (db) { try { db.close(); } catch {} db = null; }
}

module.exports = {
  DB_PATH,
  listProxies,
  addProxy,
  removeProxy,
  seedProxies,
  listCombos,
  addCombo,
  removeCombo,
  seedCombos,
  getSetting,
  setSetting,
  getAllSettings,
  listApiKeys,
  insertApiKey,
  findApiKeyByHash,
  setApiKeyActive,
  touchApiKey,
  revokeApiKey,
  countActiveApiKeys,
  countEnabledApiKeys,
  close,
};
