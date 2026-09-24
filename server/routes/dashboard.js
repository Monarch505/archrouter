"use strict";
/*
 * routes/dashboard.js — web UI + JSON API for the browser dashboard.
 *
 *  GET  /                    -> dashboard HTML (web/index.html)
 *  GET  /api/status          -> version, mode, identity, uptime, stats
 *  GET  /api/models          -> cached model list (+ refresh?)
 *  POST /api/models/refresh  -> force refresh model cache
 *  GET  /api/logs?limit=N    -> recent request log
 *  GET  /api/pool            -> proxy pool status
 *  POST /api/rotate          -> rotate identity now
 *  POST /api/config          -> update config (aliases, proxy mode, etc.)
 *  GET  /api/identity        -> current session/user IDs
 */

const fs = require("fs");
const path = require("path");
const logger = require("../lib/logger.js");
const configStore = require("../lib/configStore.js");
const store = require("../lib/store.js");
const { parseBody, sendJson } = require("./chatCompletions.js");

const INDEX_HTML = path.join(__dirname, "..", "web", "index.html");

function readIndex() {
  try {
    return fs.readFileSync(INDEX_HTML, "utf8");
  } catch (e) {
    return `<!doctype html><html><body><h1>opencode-router</h1><p>web/index.html missing</p></body></html>`;
  }
}

async function handleDashboard(router, req, res, url) {
  const p = url.pathname;

  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(readIndex());
    return;
  }

  if (p === "/api/status") {
    const cfg = configStore.get();
    return sendJson(res, 200, {
      version: "1.0.0",
      uptimeSeconds: Math.floor(process.uptime()),
      port: cfg.port,
      host: cfg.host,
      mode: router.proxyRouter.mode,
      retries: cfg.retries,
      identity: router.provider.identity(),
      baseUrl: cfg.baseUrl,
      release: cfg.release,
      usageTotal: router.logs.usageTotal,
      modelCount: router.modelCache.data?.count ?? null,
      modelsFetchedAt: router.modelCache.data?.fetchedAt ?? null,
    });
  }

  if (p === "/api/identity") {
    return sendJson(res, 200, router.provider.identity());
  }

  if (p === "/api/models") {
    const list = await router.modelCache.listOpenAI(url.searchParams.get("force") === "1");
    return sendJson(res, 200, list);
  }

  if (p === "/api/models/refresh" && (req.method === "POST" || req.method === "GET")) {
    const list = await router.modelCache.listOpenAI(true);
    return sendJson(res, 200, { ok: true, count: list.data?.length ?? 0 });
  }

  if (p === "/api/logs") {
    const limit = Math.min(500, parseInt(url.searchParams.get("limit") || "50", 10));
    return sendJson(res, 200, { logs: router.logs.recent(limit) });
  }

  if (p === "/api/pool") {
    return sendJson(res, 200, router.proxyRouter.status());
  }

  // ---- Manual proxies (runtime add/remove, persisted in SQLite) ----
  if (p === "/api/proxies" && req.method === "GET") {
    return sendJson(res, 200, { proxies: store.listProxies() });
  }
  if (p === "/api/proxies" && req.method === "POST") {
    try {
      const b = await parseBody(req);
      const url = String(b.url || "").trim();
      if (!/^https?:\/\/[^\s]+$/.test(url)) {
        return sendJson(res, 400, { error: "invalid proxy url" });
      }
      store.addProxy(url);
      router.proxyRouter.manual.load(store.listProxies());
      logger.info(`[dashboard] manual proxy added: ${url}`);
      return sendJson(res, 200, { ok: true, proxies: store.listProxies() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }
  if (p === "/api/proxies/remove" && req.method === "POST") {
    try {
      const b = await parseBody(req);
      const url = String(b.url || "").trim();
      store.removeProxy(url);
      router.proxyRouter.manual.load(store.listProxies());
      logger.info(`[dashboard] manual proxy removed: ${url}`);
      return sendJson(res, 200, { ok: true, proxies: store.listProxies() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }
  if (p === "/api/proxies/refresh" && (req.method === "POST" || req.method === "GET")) {
    try {
      await router.proxyRouter.manual.autoRefresh(true);
      const list = store.listProxies();
      router.proxyRouter.manual.load(list);
      return sendJson(res, 200, { ok: true, proxies: list, pool: router.proxyRouter.status() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // ---- Model combos (runtime add/remove, persisted in SQLite + config) ----
  if (p === "/api/combos" && req.method === "GET") {
    return sendJson(res, 200, { combos: store.listCombos() });
  }
  if (p === "/api/combos" && req.method === "POST") {
    try {
      const b = await parseBody(req);
      const name = String(b.name || "").trim();
      const model = String(b.model || "").trim();
      if (!name || !model) return sendJson(res, 400, { error: "combo name and target model required" });
      store.addCombo(name, model);
      // Persist into config.combos as well so resolveModel() sees it live.
      const cfg = configStore.get();
      cfg.combos = { ...(cfg.combos || {}), [name]: model };
      configStore.save({ combos: cfg.combos });
      logger.info(`[dashboard] combo added: ${name} -> ${model}`);
      return sendJson(res, 200, { ok: true, combos: store.listCombos() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }
  if (p === "/api/combos/remove" && req.method === "POST") {
    try {
      const b = await parseBody(req);
      const name = String(b.name || "").trim();
      store.removeCombo(name);
      const cfg = configStore.get();
      if (cfg.combos && cfg.combos[name]) {
        delete cfg.combos[name];
        configStore.save({ combos: cfg.combos });
      }
      logger.info(`[dashboard] combo removed: ${name}`);
      return sendJson(res, 200, { ok: true, combos: store.listCombos() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (p === "/api/rotate" && (req.method === "POST" || req.method === "GET")) {
    const id = router.provider.rotateIdentity();
    logger.info(`[dashboard] manual identity rotation -> session=${id.session}`);
    return sendJson(res, 200, { ok: true, identity: id });
  }

  if (p === "/api/config" && req.method === "POST") {
    try {
      const patch = await parseBody(req);
      const cfg = configStore.save(patch);
      if (patch.proxy?.mode) {
        router.proxyRouter.setMode(patch.proxy.mode);
        router.proxyRouter.config = cfg;
        router.proxyRouter.start();
      }
      // Keep the running fallback pool's config (sources, cooldownMs) in sync.
      if (patch.proxy?.manual && router.proxyRouter.manual) {
        router.proxyRouter.manual.cfg = cfg.proxy.manual;
      }
      logger.info("[dashboard] config updated");
      return sendJson(res, 200, { ok: true, config: cfg });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (p === "/api/config" && req.method === "GET") {
    return sendJson(res, 200, configStore.get());
  }

  return sendJson(res, 404, { error: "not found" });
}

module.exports = { handleDashboard };
