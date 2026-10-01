"use strict";
/*
 * routes/apiKeys.js — API key management for the dashboard.
 *
 * Bootstrap: while no key exists these endpoints are reachable without a
 * credential, otherwise the first key could never be created. The moment one
 * active key exists the whole surface needs a key again.
 */

const { sendJson, parseBody } = require("./chatCompletions.js");
const auth = require("../lib/auth.js");
const store = require("../lib/store.js");

function bootstrapOpen() {
  return store.countActiveApiKeys() === 0;
}

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix || "",
    created_at: row.created_at,
    last_used_at: row.last_used_at || null,
    revoked: !!row.revoked_at,
  };
}

async function handleApiKeys(router, req, res, url, cfg) {
  const p = url.pathname;
  const verify = router.authVerify;

  const open = bootstrapOpen();
  if (!open && cfg.auth.requireAuth) {
    const key = auth.extractKey(req);
    const v = verify(key);
    if (!v.ok) return sendJson(res, 401, { error: { message: "unauthorized", type: "authentication_error" } });
  }

  if (p === "/api/keys" && req.method === "GET") {
    const rows = store.listApiKeys().map(shape);
    return sendJson(res, 200, { keys: rows, bootstrapOpen: open });
  }

  if (p === "/api/keys" && req.method === "POST") {
    let body = {};
    try { body = await parseBody(req); } catch { body = {}; }
    const name = String(body.name || "").trim().slice(0, 60) || `key-${new Date().toISOString().slice(0, 10)}`;
    const key = auth.newKey();
    const row = store.insertApiKey({
      id: auth.keyId(),
      name,
      keyHash: auth.sha256hex(key),
      prefix: auth.displayPrefix(key),
    });
    router.logger.info(`[auth] api key created: ${name} (${row.id})`);
    return sendJson(res, 201, { ...shape(row), key, note: "shown once — store it now" });
  }

  if (p === "/api/keys/revoke" && req.method === "POST") {
    let body = {};
    try { body = await parseBody(req); } catch { body = {}; }
    const id = String(body.id || "").trim();
    if (!id) return sendJson(res, 400, { error: { message: "id required" } });
    store.revokeApiKey(id);
    router.logger.info(`[auth] api key revoked: ${id}`);
    return sendJson(res, 200, { keys: store.listApiKeys().map(shape) });
  }

  return sendJson(res, 404, { error: { message: "not found" } });
}

module.exports = { handleApiKeys, bootstrapOpen };