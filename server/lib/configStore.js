"use strict";
/*
 * configStore.js — setup storage in SQLite (no config.json).
 *
 * Defaults are defined in code; persisted overrides live in the `settings`
 * table of proxies.db. load() = defaults + DB; save() writes to DB.
 * If a legacy config.json exists on first run, it is migrated once into DB.
 */

const fs = require("fs");
const path = require("path");
const store = require("./store.js");

const DEFAULTS = {
  port: 20399,
  host: "127.0.0.1",
  baseUrl: "https://opencode.ai",
  release: "1.18.31",
  uaSuffix: "ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14",
  client: "cli",
  project: "global",
  auth: { requireAuth: false, apiKey: "sk-opencode-router" },
  retries: 3,
  requestTimeoutMs: 120000,
  cooldown: { forbiddenCooldownMs: 60000, episodeWindowMs: 180000 },
  models: { cacheSeconds: 300, prefix: "oc/" },
  combos: {},
  proxy: {
    mode: "none", // none | upstream | manual | embedded | warp (warp = Fase 3 pool :11801)
    upstream: "http://127.0.0.1:10802",
    warp: { poolSocks: "socks5h://127.0.0.1:11801", statusUrl: "http://127.0.0.1:9190" },
    manual: { cooldownMs: 60000, deadCooldownMs: 60000, maxPoolSize: 30, proxies: [], sources: [] },
    embedded: {
      sources: ["https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&protocol=http&timeout=5000"],
      minPoolSize: 5,
      maxPoolSize: 100,
      testPrompt: "hi",
      testMaxTokens: 3,
      fetchIntervalSeconds: 300,
      healthCheckIntervalSeconds: 60,
      maxLatencyMs: 3000,
    },
  },
};

const LEGACY_CONFIG_PATH = path.join(__dirname, "..", "config.json");

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(override || {})) {
    const v = override[k];
    if (v && typeof v === "object" && !Array.isArray(v) && base && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function migrateLegacy() {
  // One-time: read config.json if present, save into DB, keep file as backup.
  if (!fs.existsSync(LEGACY_CONFIG_PATH)) return false;
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, "utf8"));
    for (const [k, v] of Object.entries(legacy)) store.setSetting(k, v);
    return true;
  } catch (e) {
    console.error(`[configStore] legacy migration failed: ${e.message}`);
    return false;
  }
}

function load() {
  const migrated = migrateLegacy();
  if (migrated) console.log("[configStore] migrated config.json -> SQLite (file kept as backup)");
  const saved = store.getAllSettings();
  return deepMerge(DEFAULTS, saved);
}

function save(next) {
  const cfg = deepMerge(load(), next || {});
  for (const [k, v] of Object.entries(next || {})) {
    store.setSetting(k, v);
  }
  return cfg;
}

function get() {
  return load();
}

module.exports = { load, save, get, DEFAULTS, LEGACY_CONFIG_PATH, deepMerge };
