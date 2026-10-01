"use strict";
/*
 * opencodeConfig.js — build the opencode.json provider fragment for archrouter.
 *
 * opencode reads its model catalog from config, not from /v1/models, so a
 * custom provider has to be described there. Doing that by hand is what makes
 * the 9router setup "primitive": the list goes stale and every model needs
 * typing. This module generates it from the live list plus modelCaps, so the
 * per-model `variants` only advertise effort levels that model really has.
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

function buildProvider({ host = "127.0.0.1", port = 20399, modelIds = [] } = {}) {
  const models = {};
  for (const raw of modelIds) {
    const id = String(raw).replace(/^(oc|combo)\//, "");
    const caps = capsFor(id);
    if (caps.kind === "unavailable") continue;
    const entry = { name: id };
    const variants = variantsFor(id);
    if (variants) entry.variants = variants;
    models[id] = entry;
  }
  return {
    [PROVIDER_ID]: {
      npm: PROVIDER_NPM,
      options: { baseURL: `http://${host}:${port}/v1` },
      models,
    },
  };
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
  return { ok: true, file, backup, models: Object.keys(merged.provider[PROVIDER_ID].models).length };
}

module.exports = { PROVIDER_ID, PROVIDER_NPM, configPath, buildProvider, buildFragment, mergeFragment, writeConfig };