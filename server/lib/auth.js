"use strict";
/*
 * auth.js — API key extraction and verification.
 *
 * Two credential sources, checked in order:
 *   1. ARCHROUTER_KEY in the environment — a static key for scripts and CI.
 *   2. Keys created in the dashboard — random, stored as SHA-256 only.
 *
 * Keys travel in the Authorization header (`Bearer <key>` or the raw key) or in
 * x-archrouter-key. Query-string keys are deliberately NOT accepted: URLs end
 * up in shell history, proxy logs and browser history.
 */

const crypto = require("crypto");

const PREFIX = "sk-arch-";
const KEY_BYTES = 24;

function sha256hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function equalConstantTime(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function newKey() {
  return PREFIX + crypto.randomBytes(KEY_BYTES).toString("base64url");
}

function keyId() {
  return crypto.randomUUID();
}

// Only the part before the secret is safe to show in listings: a prefix plus
// the last four characters is enough to tell two keys apart.
function displayPrefix(key) {
  return `${key.slice(0, PREFIX.length + 6)}…${key.slice(-4)}`;
}

function extractKey(req) {
  const h = req.headers || {};
  const raw = h["x-archrouter-key"] || h["authorization"] || "";
  const value = String(raw).trim();
  if (!value) return "";
  const bearer = /^Bearer\s+(.+)$/i.exec(value);
  return (bearer ? bearer[1] : value).trim();
}

// lookup(keyHash) -> { id, active, revoked } | null   (injected so tests need no DB)
function makeVerifier({ staticKey = "", lookup = null } = {}) {
  return function verify(key) {
    if (!staticKey && !lookup) return { ok: true, reason: "no-auth-configured" };
    if (!key) return { ok: false, reason: "missing-key" };
    if (staticKey && equalConstantTime(key, staticKey)) return { ok: true, reason: "static" };
    if (!lookup) return { ok: false, reason: "unknown-key" };
    const row = lookup(sha256hex(key));
    if (!row) return { ok: false, reason: "unknown-key" };
    if (row.revoked) return { ok: false, reason: "revoked", id: row.id };
    if (row.active === false) return { ok: false, reason: "inactive", id: row.id };
    return { ok: true, reason: "db", id: row.id, name: row.name };
  };
}

// Three-way switch, mirroring the vansrouter/9router setting:
//   off   — the router answers without a credential
//   on    — a key is always required
//   auto  — required as soon as a credential exists, open before that so the
//           first key can be created
// ARCHROUTER_REQUIRE_AUTH and --no-auth win over the stored mode, so a
// deployment can be forced open or closed without touching the database.
function resolveAuthRequired({ mode = "auto", envFlag, noAuthFlag = false, staticKey = "", activeKeys = 0 } = {}) {
  if (noAuthFlag) return { required: false, source: "--no-auth" };
  if (envFlag !== undefined && envFlag !== "") {
    const on = String(envFlag) !== "0" && String(envFlag) !== "false";
    return { required: on, source: "ARCHROUTER_REQUIRE_AUTH" };
  }
  if (mode === "on") return { required: true, source: "config" };
  if (mode === "off") return { required: false, source: "config" };
  return {
    required: !!(staticKey || activeKeys > 0),
    source: "auto",
  };
}

function normalizeMode(v) {
  return v === "on" || v === "off" ? v : "auto";
}

module.exports = {
  PREFIX,
  sha256hex,
  equalConstantTime,
  newKey,
  keyId,
  displayPrefix,
  extractKey,
  makeVerifier,
  resolveAuthRequired,
  normalizeMode,
};