#!/usr/bin/env node
"use strict";
/*
 * server.js — standalone opencode-router entry point.
 *
 * Usage:
 *   node server.js [--port 20299] [--host 127.0.0.1] [--mode none|upstream|embedded]
 *                  [--upstream http://127.0.0.1:10802] [--no-auth]
 *
 * Serves:
 *   POST /v1/chat/completions   (OpenAI, streaming + non-streaming)
 *   POST /v1/messages           (Anthropic)
 *   POST /v1/responses          (OpenAI Responses API — muse-spark, P1-3)
 *   POST /v1/messages/count_tokens
 *   GET  /v1/models
 *   GET  /                       (browser dashboard)
 *   GET  /api/...                (dashboard JSON API)
 */

const http = require("http");
const url = require("url");
const configStore = require("./lib/configStore.js");
const logger = require("./lib/logger.js");
const { ProxyRouter } = require("./lib/proxyPool.js");
const { ModelCache } = require("./lib/models.js");
const { Router } = require("./lib/router.js");
const { handleChatCompletions, parseBody, sendJson } = require("./routes/chatCompletions.js");
const { handleMessages } = require("./routes/messages.js");
const { handleResponses } = require("./routes/responses.js");
const { handleModels } = require("./routes/models.js");
const { handleDashboard } = require("./routes/dashboard.js");
const { handleApiKeys } = require("./routes/apiKeys.js");
const auth = require("./lib/auth.js");

const BANNER = `
\x1b[1m\x1b[36m  opencode-router \x1b[0m — standalone 9router-like server (opencode models only)
\x1b[2m  docs: endpoint https://opencode.ai/zen/v1 | UA opencode/1.18.18 | headers = opencode.exe\x1b[0m
`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    let val = true;
    if (eq > 0) val = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) val = argv[++i];
    opts[key] = val;
  }
  return opts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = configStore.load();

  if (args.port) cfg.port = parseInt(args.port, 10);
  if (args.host) cfg.host = args.host;
  if (args.mode) {
    cfg.proxy.mode = args.mode;
    if (!["none", "upstream", "manual", "embedded", "warp"].includes(args.mode)) {
      console.error(`invalid --mode '${args.mode}' (none|upstream|manual|embedded|warp)`);
      process.exit(1);
    }
  }
  if (args.upstream) cfg.proxy.upstream = args.upstream;
  if (args.debug) logger.setLevel("debug");

  process.stdout.write(BANNER);

const proxyRouter = new ProxyRouter(cfg);
  const modelCache = new ModelCache(cfg);
  const router = new Router({ config: cfg, proxyRouter, modelCache });

  // Seed SQLite from config (manual proxies + combos), then load the
  // full persisted list (including anything added via API on earlier runs).
  const store = require("./lib/store.js");
  store.seedProxies(cfg.proxy?.manual?.proxies || []);
  store.seedCombos(cfg.combos || {});
  proxyRouter.manual.load(store.listProxies());
  if (cfg.combos) {
    const persisted = store.listCombos();
    cfg.combos = { ...(cfg.combos || {}), ...Object.fromEntries(Object.entries(persisted).map(([k, v]) => [k, v.model])) };
  }

  // Auth is a three-way setting (auto/on/off) resolved once at start and
  // changeable at runtime from the dashboard, so flipping it takes effect
  // without a restart. Env and --no-auth still win over the stored mode.
  const staticKey = (process.env.ARCHROUTER_KEY || "").trim();
  let mode = auth.normalizeMode(cfg.auth?.requireAuthMode);
  let authState = auth.resolveAuthRequired({
    mode,
    envFlag: process.env.ARCHROUTER_REQUIRE_AUTH,
    noAuthFlag: !!args["no-auth"],
    staticKey,
    activeKeys: store.countEnabledApiKeys(),
  });
  cfg.auth.apiKey = staticKey || null;
  cfg.auth.requireAuthMode = mode;
  const authVerify = auth.makeVerifier({
    staticKey,
    lookup: (hash) => {
      const row = store.findApiKeyByHash(hash);
      return row ? { id: row.id, active: row.active, revoked: row.revoked } : null;
    },
  });
  router.authVerify = authVerify;
  router.authState = () => ({ ...authState, mode });
  // Re-reads the enabled-key count, so auto mode reacts to a key being
  // disabled or revoked without waiting for a restart.
  router.resolveAuth = () => {
    authState = auth.resolveAuthRequired({
      mode,
      envFlag: process.env.ARCHROUTER_REQUIRE_AUTH,
      noAuthFlag: !!args["no-auth"],
      staticKey,
      activeKeys: store.countEnabledApiKeys(),
    });
    return router.authState();
  };
  router.setAuthMode = (next) => {
    mode = auth.normalizeMode(next);
    cfg.auth.requireAuthMode = mode;
    configStore.save({ auth: { requireAuthMode: mode } });
    const s = router.resolveAuth();
    logger.info(`[auth] require key = ${s.required} (mode=${s.mode}, source=${s.source})`);
    return s;
  };

  await modelCache.refresh(false).catch(() => {});
  proxyRouter.start();

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const p = parsed.pathname;

    // CORS is off unless an origin is configured. A wildcard would let any page in
// a browser drive the local router; ARCHROUTER_CORS_ORIGIN takes a single
// origin (comma-separated for several).
const corsOrigins = (process.env.ARCHROUTER_CORS_ORIGIN || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
function applyCors(req, res) {
  if (!corsOrigins.length) return false;
  const origin = req.headers.origin;
  if (!origin || !corsOrigins.includes(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-archrouter-key");
  return true;
  }

    if (req.method === "OPTIONS") {
      applyCors(req, res);
      res.writeHead(204);
      res.end();
      return;
    }
    applyCors(req, res);

    const unauthorized = () => sendJson(res, 401, { error: { message: "unauthorized", type: "authentication_error" } });
    const guard = () => {
      if (!authState.required) return false;
      const v = authVerify(auth.extractKey(req));
      if (v.ok) {
        if (v.id) { try { store.touchApiKey(v.id); } catch { /* bookkeeping must not fail a request */ } }
        return false;
      }
      unauthorized();
      return true;
    };

    try {
      if (p.startsWith("/api/keys")) return await handleApiKeys(router, req, res, parsed, cfg);

      if (p === "/v1/chat/completions" && req.method === "POST") {
        if (guard()) return;
        return await handleChatCompletions(router, req, res);
      }
      if (p === "/v1/messages" && req.method === "POST") {
        if (guard()) return;
        return await handleMessages(router, req, res);
      }
      if (p === "/v1/responses" && req.method === "POST") {
        if (guard()) return;
        return await handleResponses(router, req, res);
      }
      if (p === "/v1/messages/count_tokens" && req.method === "POST") {
        if (guard()) return;
        // Best-effort estimate; forward through opencode for accurate count when possible.
        try {
          const body = await parseBody(req);
          const inputTokens = estimateTokens(JSON.stringify(body.messages || ""));
          return sendJson(res, 200, { input_tokens: inputTokens, output_tokens: 0 });
        } catch (e) {
          return sendJson(res, 400, { error: { message: e.message, type: "invalid_request_error" } });
        }
      }
      if ((p === "/v1/models" || p === "/v1beta/models") && req.method === "GET") {
        if (guard()) return;
        return await handleModels(router, req, res, parsed);
      }
      if (p === "/health" || p === "/api/health") {
        // commit = env injected by cmdStart — proves WHICH code is running,
        // so "restart done" is verifiable instead of assumed.
        return sendJson(res, 200, { status: "ok", uptimeSeconds: Math.floor(process.uptime()), commit: process.env.ARCHROUTER_COMMIT || "unknown" });
      }
      // Escape hatch: with no enabled key left there is nothing to authenticate
      // against, so the mode switch stays reachable. Otherwise mode=on plus a
      // revoked key would lock the dashboard out with no way back.
      if (p === "/api/auth/mode" && req.method === "POST" && store.countEnabledApiKeys() === 0) {
        return await handleDashboard(router, req, res, parsed);
      }
      // Dashboard reads stay open for the monitor UI; anything that changes
      // state needs a key. GET /api/config exposes the key hash path, so it is
      // treated as a mutation too.
      if (req.method !== "GET" && req.method !== "HEAD" && guard()) return;
      return await handleDashboard(router, req, res, parsed);
    } catch (e) {
      logger.error(`route error ${p}: ${e.message}`);
      return sendJson(res, 500, { error: { message: e.message, type: "server_error" } });
    }
  });

  server.listen(cfg.port, cfg.host, () => {
    logger.info(`listening on http://${cfg.host}:${cfg.port}`);
    logger.info(`  OpenAI-compatible : http://${cfg.host}:${cfg.port}/v1/chat/completions`);
    logger.info(`  Anthropic-compatible: http://${cfg.host}:${cfg.port}/v1/messages`);
    logger.info(`  Models             : http://${cfg.host}:${cfg.port}/v1/models`);
    logger.info(`  Dashboard          : http://${cfg.host}:${cfg.port}/`);
    logger.info(`  Proxy mode         : ${cfg.proxy.mode}`);
    logger.info(`  Auth               : ${authState.required ? `required (${authState.source}) · ${store.countActiveApiKeys()} key(s)` : `open (${authState.source}) — no credential needed`}`);
  });

  process.on("SIGINT", () => {
    logger.info("shutting down...");
    proxyRouter.embedded.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

function estimateTokens(s) {
  // Rough: ~4 chars/token for latin, 1 char/token for CJK.
  let cjk = 0, other = 0;
  for (const ch of s) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(other / 4) + cjk;
}

main();
