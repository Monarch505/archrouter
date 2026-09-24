"use strict";
/*
 * routes/models.js — GET /v1/models (OpenAI format, live from opencode.ai).
 * Also serves /v1/models/:kind passthrough for compatibility.
 */

const { sendJson } = require("./chatCompletions.js");

async function handleModels(router, req, res, url) {
  const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
  try {
    const list = await router.modelCache.listOpenAI(force);
    sendJson(res, 200, list);
  } catch (e) {
    sendJson(res, 500, { error: { message: e.message, type: "server_error" } });
  }
}

module.exports = { handleModels };
