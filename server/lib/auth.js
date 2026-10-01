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

// lookup(keyHash) -> { id, revoked } | null   (injected so tests need no DB)
function makeVerifier({ staticKey = "", lookup = null } = {}) {
  return function verify(key) {
    if (!staticKey && !lookup) return { ok: true, reason: "no-auth-configured" };
    if (!key) return { ok: false, reason: "missing-key" };
    if (staticKey && equalConstantTime(key, staticKey)) return { ok: true, reason: "static" };
    if (!lookup) return { ok: false, reason: "unknown-key" };
    const row = lookup(sha256hex(key));
    if (!row) return { ok: false, reason: "unknown-key" };
    if (row.revoked) return { ok: false, reason: "revoked" };
    return { ok: true, reason: "db", id: row.id, name: row.name };
  };
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
};