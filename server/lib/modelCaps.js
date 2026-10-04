"use strict";
/*
 * modelCaps.js — what each upstream model can actually do.
 *
 * opencode.ai/zen/v1/models returns no capability metadata (only ids), so the
 * reasoning-effort levels are curated here from measured behaviour:
 *   chat        — works via /chat/completions
 *   responses   — served only via /responses (muse-spark family)
 *   systemone   — /systemone, no reasoning at all
 *   unavailable — upstream rejects it, hidden from the catalog
 *
 * efforts are the variants opencode should offer. Effort is forwarded as
 * reasoning_effort; ocEmbed.primer() clamps what it does not accept and fills
 * in "high" when the client sends nothing (proven: 88 vs 23 reasoning tokens).
 *
 * Override without editing code: ARCHROUTER_MODEL_CAPS in .env takes a JSON
 * object of the same shape, merged over this table.
 */

const CAPS = {
  // Measured working on the chat path with reasoning (2026-09-25/30).
  "mimo-v2.5-free": { kind: "chat", reasoning: true, efforts: ["low", "medium", "high"] },
  "mimo-v2.6-flash-free": { kind: "chat", reasoning: true, efforts: ["low", "medium", "high"] },
  "space-bunny-free": { kind: "chat", reasoning: true, efforts: ["low", "medium", "high"] },
  // Upstream keeps listing it but the chat path is dead: 3/3 attempts on
  // 2026-10-04 gave 400 "Endpoint is unavailable". Stays "chat" on purpose so it
  // is not silently hidden — see the ling note below.
  "ling-3.0-flash-fin-free": { kind: "chat", reasoning: true, efforts: ["low", "medium", "high"] },
  "nemotron-3.5-lightning-free": { kind: "chat", reasoning: true, efforts: ["low", "medium", "high"] },
  "nemotron-3-ultra-free": { kind: "chat", reasoning: true, efforts: ["low", "medium", "high"] },
  "longcat-2.5-preview-free": { kind: "chat", reasoning: true, efforts: ["low", "high"] },

  // muse-spark answers 500 on chat; only the Responses path serves it, and the
  // primer there pins reasoning.summary so it exposes one effort level.
  "muse-spark-1.2-contributor-free": { kind: "responses", reasoning: true, efforts: ["high"] },
  "muse-spark-1.3-contributor-free": { kind: "responses", reasoning: true, efforts: ["high"] },
  "muse-spark-1.2": { kind: "responses", reasoning: true, efforts: ["high"] },
  "muse-spark-1.3": { kind: "responses", reasoning: true, efforts: ["high"] },

  "jev-1.13-free": { kind: "systemone", reasoning: false, efforts: [] },

  // Upstream answered 400 "Model is unavailable" on 2026-09-30.
  "deepseek-v4-flash-free": { kind: "unavailable", reasoning: false, efforts: [] },

  // Left as chat on purpose — NOT to be unlisted. Measured 2026-10-04, three
  // identical attempts each through /v1/chat/completions:
  //   ling-3.0-flash-fin-free -> 400 "Upstream request failed: Endpoint is unavailable"
  //   ling-3.1-flash-free     -> 429, same message
  // Reproducible, so it is upstream, not archrouter. They stay in the catalog so
  // the failure is visible where it happens; flip them to "unavailable" only if
  // upstream stops listing them or you would rather the picker not offer them.
  "ling-3.1-flash-free": { kind: "chat", reasoning: true, efforts: ["low", "medium", "high"] },
};

// Unknown model: assume the chat path with reasoning and the two levels that
// every reasoning model upstream accepts, so a newly added upstream model is
// still usable instead of silently missing.
const DEFAULT_CAPS = { kind: "chat", reasoning: true, efforts: ["low", "high"] };

function overrides() {
  const raw = (process.env.ARCHROUTER_MODEL_CAPS || "").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function bare(modelId) {
  return String(modelId || "").replace(/^(combo\/|oc\/)/, "");
}

// Only the free tier is served. Upstream marks it with a -free suffix on the
// model id; everything else (claude, gemini, big-p, muse-spark without the
// suffix) costs quota we do not have, so it never appears and never runs.
function isFreeModel(modelId) {
  return bare(modelId).endsWith("-free");
}

function freeOnlyEnabled(config) {
  if (process.env.ARCHROUTER_FREE_ONLY === "0") return false;
  if (process.env.ARCHROUTER_FREE_ONLY === "1") return true;
  return config?.models?.freeOnly !== false;
}


function capsFor(modelId) {
  const id = bare(modelId);
  const ov = overrides();
  // Paywalled and free ids of the same model behave identically upstream, so a
  // "-free" entry answers for the paid id too.
  const alias = id.endsWith("-free") ? id.slice(0, -5) : `${id}-free`;
  const hit = ov[id] || CAPS[id] || ov[alias] || CAPS[alias] || DEFAULT_CAPS;
  return {
    kind: hit.kind || DEFAULT_CAPS.kind,
    reasoning: hit.reasoning !== false,
    efforts: Array.isArray(hit.efforts) ? hit.efforts.slice() : DEFAULT_CAPS.efforts.slice(),
    default_effort: hit.default_effort || (Array.isArray(hit.efforts) && hit.efforts.length ? hit.efforts[hit.efforts.length - 1] : null),
  };
}

// What the opencode variant list looks like for one model: opencode overlays
// the chosen variant onto the model config, so an unknown id fails resolution
// instead of silently running the base model.
function variantsFor(modelId) {
  const caps = capsFor(modelId);
  if (!caps.reasoning || !caps.efforts.length) return null;
  const out = {};
  for (const effort of caps.efforts) out[effort] = { reasoningEffort: effort };
  return out;
}

module.exports = { CAPS, DEFAULT_CAPS, capsFor, variantsFor, bare, isFreeModel, freeOnlyEnabled };