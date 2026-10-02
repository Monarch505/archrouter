"use strict";
/*
 * models.js — live model list from opencode.ai/zen/v1/models, cached.
 * Exposes models under the configured prefix (default "oc/").
 */

const transport = require("./transport.js");
const logger = require("./logger.js");
const { capsFor, isFreeModel, freeOnlyEnabled } = require("./modelCaps.js");

class ModelCache {
  constructor(config) {
    this.config = config;
    this.data = null;
    this.fetchedAt = null;
    this.inFlight = null;
  }

  async refresh(force = false) {
    const cacheSeconds = this.config.models?.cacheSeconds ?? 300;
    const now = Date.now();
    if (!force && this.data && this.fetchedAt && now - this.fetchedAt < cacheSeconds * 1000) {
      return this.data;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const url = `${this.config.baseUrl || "https://opencode.ai"}/zen/v1/models`;
      const headers = {
        "x-opencode-client": "desktop",
        "User-Agent": `opencode/${this.config.release || "1.18.18"}`,
      };
      try {
        const resp = await transport.request({ url, headers, timeoutMs: 20000, json: true });
        if (resp.status === 200 && Array.isArray(resp.json?.data)) {
          const prefix = this.config.models?.prefix || "oc/";
          const freeOnly = freeOnlyEnabled(this.config);
          const comboMap = this.config.combos || {};
          // Models upstream marks unavailable are dropped from the catalog so
          // clients stop offering them; in free-only mode everything without a
          // -free suffix goes too, and combos pointing at those models with them.
          const usable = resp.json.data.filter((m) => capsFor(m.id).kind !== "unavailable");
          const upstream = freeOnly ? usable.filter((m) => isFreeModel(m.id)) : usable;
          const comboNames = Object.entries(comboMap)
            .filter(([, target]) => !freeOnly || isFreeModel(target))
            .map(([name]) => name);
          const comboData = comboNames.map((name) => ({
            id: `combo/${name}`,
            object: "model",
            owned_by: "combo",
          }));
          this.data = {
            fetchedAt: new Date().toISOString(),
            count: upstream.length + comboData.length,
            raw: upstream.map((m) => m.id),
            openai: {
              object: "list",
              data: [
                ...upstream.map((m) => ({
                  id: `${prefix}${m.id}`,
                  object: m.object || "model",
                  created: m.created,
                  owned_by: m.owned_by || "opencode",
                  capabilities: capsFor(m.id),
                })),
                ...comboData.map((c) => ({ ...c, capabilities: { kind: "chat", reasoning: false, efforts: [] } })),
              ],
            },
          };
          this.fetchedAt = now;
          const dropped = resp.json.data.length - upstream.length;
          logger.info(`[models] refreshed: ${this.data.count} models (incl. ${comboData.length} combo)${dropped > 0 ? `, ${dropped} non-free hidden` : ""}`);
        } else {
          logger.warn(`[models] fetch returned ${resp.status}`);
        }
      } catch (e) {
        logger.error(`[models] fetch error: ${e.message}`);
      } finally {
        this.inFlight = null;
      }
      return this.data;
    })();
    return this.inFlight;
  }

  async listOpenAI(force = false) {
    const d = await this.refresh(force);
    return d?.openai || { object: "list", data: [] };
  }

  isKnown(modelId) {
    if (!this.data?.raw) return true; // optimistic when cache empty
    const bare = modelId.startsWith("oc/") ? modelId.slice(3) : modelId;
    return this.data.raw.includes(bare);
  }
}

module.exports = { ModelCache };
