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
  if (args["no-auth"]) cfg.auth.requireAuth = false;
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

  await modelCache.refresh(false).catch(() => {});
  proxyRouter.start();

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const p = parsed.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    try {
      if (p === "/v1/chat/completions" && req.method === "POST") {
        if (cfg.auth.requireAuth && !isAuthed(req, cfg.auth.apiKey)) return sendJson(res, 401, { error: { message: "unauthorized", type: "authentication_error" } });
        return await handleChatCompletions(router, req, res);
      }
      if (p === "/v1/messages" && req.method === "POST") {
        if (cfg.auth.requireAuth && !isAuthed(req, cfg.auth.apiKey)) return sendJson(res, 401, { error: { message: "unauthorized", type: "authentication_error" } });
        return await handleMessages(router, req, res);
      }
      if (p === "/v1/responses" && req.method === "POST") {
        if (cfg.auth.requireAuth && !isAuthed(req, cfg.auth.apiKey)) return sendJson(res, 401, { error: { message: "unauthorized", type: "authentication_error" } });
        return await handleResponses(router, req, res);
      }
      if (p === "/v1/messages/count_tokens" && req.method === "POST") {
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
        return await handleModels(router, req, res, parsed);
      }
      if (p === "/health" || p === "/api/health") {
        return sendJson(res, 200, { status: "ok", uptimeSeconds: Math.floor(process.uptime()) });
      }
      // Dashboard + API
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
  });

  process.on("SIGINT", () => {
    logger.info("shutting down...");
    proxyRouter.embedded.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

function isAuthed(req, apiKey) {
  const h = req.headers["authorization"] || "";
  if (!apiKey) return true;
  return h === `Bearer ${apiKey}` || h === apiKey;
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
