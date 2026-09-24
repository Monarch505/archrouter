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
const { DatabaseSync } = require("node:sqlite");

// DB lives in <base>/data/archrouter.db (plug-and-play, repo stays clean).
// <base> = $ARCHROUTER_HOME or $HOME/.archrouter. Fallback: repo dir (dev).
const BASE_DIR =
  process.env.ARCHROUTER_HOME ||
  (process.env.HOME ? path.join(process.env.HOME, ".archrouter") : null) ||
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
    DROP TABLE IF EXISTS aliases;
  `);
  return db;
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
  close,
};
