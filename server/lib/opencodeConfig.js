"use strict";
/*
 * opencodeConfig.js — build the opencode.json provider entry for archrouter.
 *
 * includeModels: true — the model list plus per-model `variants`, generated from
 *     the live list and modelCaps so only effort levels a model really accepts
 *     are advertised. This is the DEFAULT and the only shape opencode actually
 *     uses.
 *
 * includeModels: false — npm + baseURL only, no `models` block. Kept only so an
 *     existing install can be cleaned up. **This does not work.** opencode builds
 *     its catalog from models.dev plus the static `models` map in opencode.json
 *     and never calls a custom provider's /v1/models; auto-discovery is
 *     hardcoded to Ollama, LM Studio and vLLM at their default ports. A provider
 *     written this way shows up as "Provider not found" with an empty list.
 *     General discovery is still an open PR (anomalyco/opencode#42660), so do
 *     not build on it. Verified on opencode 1.18.3.
 *
 * The list is static, so a new upstream free model needs a re-run of
 * `archrouter connect-opencode`. That is the cost of opencode's config-driven
 * catalog, not something this file can work around.
 *
 * The catalog is the full live list, minus models upstream marks unavailable.
 * A few of them cannot be reached through opencode (see the note in
 * buildProvider) and are listed anyway — recorded, not hidden.
 *
 * `apiKey` is written into options when we can resolve one, because with auth
 * required every route including /v1/models rejects an unauthenticated request.
 * opencode also reads a credential saved via /connect; either source works, but
 * an explicit key here survives a wiped auth store.
 *
 * Only our own key is touched; every other provider, agent and MCP entry in
 * the user's file is preserved as-is.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { capsFor, variantsFor } = require("./modelCaps.js");

const PROVIDER_ID = "archrouter";
const PROVIDER_NPM = "@ai-sdk/openai-compatible";

function configPath() {
  const home = process.env.HOME || (() => { try { return os.homedir(); } catch { return null; } })();
  if (!home) return null;
  const base = process.platform === "win32"
    ? path.join(home, ".config", "opencode")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
  return path.join(base, "opencode.json");
}

// Where /connect stores credentials. opencode uses ~/.local/share on Windows
// too (the archrouter shim already lives in ~/.local/bin), so the shape is the
// same everywhere; XDG_DATA_HOME is honoured on unix. Best-effort: a null or
// missing path just means "no key available", never an error.
function authPath() {
  const home = process.env.HOME || (() => { try { return os.homedir(); } catch { return null; } })();
  if (!home) return null;
  const base = process.platform === "win32"
    ? path.join(home, ".local", "share")
    : (process.env.XDG_DATA_HOME || path.join(home, ".local", "share"));
  return path.join(base, "opencode", "auth.json");
}

function buildProvider({ host = "127.0.0.1", port = 20399, modelIds = [], includeModels = true, apiKey = "" } = {}) {
  const provider = {
    npm: PROVIDER_NPM,
    name: "archrouter",
    options: { baseURL: `http://${host}:${port}/v1` },
  };
  if (apiKey) provider.options.apiKey = apiKey;
  if (!includeModels) {
    // Explicitly undefined, so mergeFragment drops a models block written by
    // an earlier run instead of leaving a stale list behind.
    provider.models = undefined;
    return { [PROVIDER_ID]: provider };
  }
  const models = {};
  for (const raw of modelIds) {
    const id = String(raw).replace(/^(oc|combo)\//, "");
    const caps = capsFor(id);
    // Only upstream-unavailable models are dropped. Everything else is listed,
    // including the models opencode cannot actually reach through this provider:
    //
    //   @ai-sdk/openai-compatible always posts to /v1/chat/completions, so a
    //   caps.kind of "responses" (muse-spark-*-contributor-free) or "systemone"
    //   (jev-1.13-free) gets a 500 from upstream on the chat path. They are kept
    //   in the catalog on purpose — the user asked for the full list, and hiding
    //   them makes a router limitation look like a missing model. Reach them on
    //   their own endpoints (/v1/responses, /v1/messages) instead.
    //
    // Also observed 2026-10-02/04, upstream-side and not archrouter's doing:
    // ling-3.0-flash-fin-free answers 400 "Endpoint is unavailable" and
    // ling-3.1-flash-free answers 429 with the same text, reproducibly. Both stay
    // listed; they may come back when upstream rotates them.
    if (caps.kind === "unavailable") continue;
    const entry = { name: id };
    const variants = variantsFor(id);
    if (variants) entry.variants = variants;
    models[id] = entry;
  }
  provider.models = models;
  return { [PROVIDER_ID]: provider };
}

function buildFragment(opts) {
  return { provider: buildProvider(opts) };
}

// Only our own key is touched; every other provider, agent and MCP entry in
// the user's file is preserved as-is.
function mergeFragment(existing, fragment) {
  const out = existing && typeof existing === "object" ? { ...existing } : {};
  const providers = { ...(out.provider || {}) };
  for (const [id, value] of Object.entries(fragment.provider || {})) {
    providers[id] = { ...(providers[id] || {}), ...value };
  }
  out.provider = providers;
  return out;
}

function writeConfig(fragment, { file = configPath() } = {}) {
  if (!file) return { ok: false, error: "cannot locate opencode config dir" };
  // A .jsonc file may hold comments; rewriting it as JSON would delete them, so
  // the caller is told to paste manually instead.
  const jsonc = file.replace(/\.json$/, ".jsonc");
  if (fs.existsSync(jsonc) && !fs.existsSync(file)) {
    return { ok: false, error: `only ${path.basename(jsonc)} exists and it may contain comments — use Copy and paste manually` };
  }
  let existing = {};
  if (fs.existsSync(file)) {
    try { existing = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { return { ok: false, error: `cannot parse ${path.basename(file)}: ${e.message}` }; }
  }
  const merged = mergeFragment(existing, fragment);
  const backup = fs.existsSync(file) ? `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}` : null;
  if (backup) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
  const written = merged.provider[PROVIDER_ID]?.models;
  return {
    ok: true,
    file,
    backup,
    mode: written ? "static" : "auto-discovery",
    models: written ? Object.keys(written).length : null,
  };
}

module.exports = { PROVIDER_ID, PROVIDER_NPM, configPath, authPath, buildProvider, buildFragment, mergeFragment, writeConfig };