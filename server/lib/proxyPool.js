"use strict";
/*
 * proxyPool.js — optional proxy routing.
 *
 * Modes:
 *   "none"      — direct connection (no proxy).
 *   "upstream"  — delegate to a running forward proxy (e.g. the existing
 *                 NormalProxies pool at 127.0.0.1:10802).
 *   "embedded"  — self-managed pool: fetch proxy lists, health-check each via a
 *                 real opencode completion probe, round-robin rotation,
 *                 per-proxy cooldown, auto-remove dead/exhausted proxies.
 *
 * Health probe mirrors proxy_pool.py's test_proxy_model: tries several models so
 * a globally-limited model isn't mistaken for per-IP exhaustion.
 */

const transport = require("./transport.js");
const logger = require("./logger.js");
const configStore = require("./configStore.js");

const EXHAUSTION_MARKERS = ["FreeUsageLimitError", "Rate limit exceeded", "rate limit"];
const FALLBACK_TEST_MODELS = [
  "laguna-s-2.1-free",
  "hy3-free",
  "nemotron-3.5-lightning-free",
  "deepseek-v4-flash-free",
];

function stripPrefix(model) {
  const prefix = "oc/";
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

class EmbeddedPool {
  constructor(cfg) {
    this.cfg = cfg;
    this.proxies = [];           // [{url, latency_ms, model, tested_at}]
    this.seen = new Set();
    this.cooldown = new Map();   // url -> epoch ms when retry allowed
    this.rrIndex = 0;
    this.fetchInProgress = false;
    this.healthInProgress = false;
    this.lastFetch = null;
    this.lastHealth = null;
    this.stats = {
      totalFetched: 0, totalTested: 0, totalAdded: 0, totalRemoved: 0,
      totalDead: 0, totalExhausted: 0, totalSlow: 0, fetchCycles: 0, healthCycles: 0,
    };
    this._timers = [];
    this._startTime = Date.now();
  }

  status() {
    return {
      mode: "embedded",
      poolSize: this.proxies.length,
      lastFetch: this.lastFetch,
      lastHealth: this.lastHealth,
      fetchInProgress: this.fetchInProgress,
      healthInProgress: this.healthInProgress,
      cooldownCount: this.cooldown.size,
      proxies: this.proxies.slice(0, 10),
      stats: this.stats,
      uptimeSeconds: Math.floor((Date.now() - this._startTime) / 1000),
    };
  }

  nextProxy() {
    const now = Date.now();
    if (!this.proxies.length) return null;
    for (let tries = 0; tries < this.proxies.length; tries++) {
      const p = this.proxies[this.rrIndex % this.proxies.length];
      this.rrIndex += 1;
      const cd = this.cooldown.get(p.url);
      if (!cd || cd <= now) return p.url;
    }
    return this.proxies[0].url;
  }

  reportFailure(url) {
    const ms = this.cfg.cooldownMs ?? 60_000;
    this.cooldown.set(url, Date.now() + ms);
  }

  async fetchRaw() {
    const sources = this.cfg.sources || [];
    const lists = [];
    for (const src of sources) {
      try {
        const resp = await transport.request({ url: src, timeoutMs: 20000 });
        if (resp.status === 200) {
          const lines = resp.body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          const parsed = lines.map((l) => (l.startsWith("http://") || l.startsWith("https://") ? l : `http://${l}`));
          lists.push(...parsed);
          logger.info(`[pool] source ok: ${src} (${parsed.length})`);
        } else {
          logger.warn(`[pool] source returned ${resp.status}: ${src}`);
        }
      } catch (e) {
        logger.warn(`[pool] source error: ${src}: ${e.message}`);
      }
    }
    return [...new Set(lists)];
  }

  async testProxy(proxyUrl) {
    const mt = {
      endpoint: "https://opencode.ai/zen/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-client": "desktop",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Origin: "https://opencode.ai",
        Referer: "https://opencode.ai/",
      },
      timeoutSeconds: 15,
    };
    const models = [...new Set([...(this.cfg.testModels || ["oc/big-pickle"]), ...FALLBACK_TEST_MODELS])];
    let exhaustedSeen = false;
    let usedModel = "";
    const maxModels = this.cfg.maxModelsPerProxy ?? 3;
    for (const m of models.slice(0, maxModels)) {
      usedModel = m;
      const payload = {
        model: stripPrefix(m),
        messages: [{ role: "user", content: this.cfg.testPrompt ?? "hi" }],
        max_tokens: this.cfg.testMaxTokens ?? 3,
        stream: false,
      };
      try {
        const start = Date.now();
        const resp = await transport.request({
          url: mt.endpoint, method: "POST", headers: mt.headers, body: JSON.stringify(payload),
          proxy: proxyUrl, timeoutMs: mt.timeoutSeconds * 1000,
        });
        const latency = Date.now() - start;
        if (resp.status === 429 || EXHAUSTION_MARKERS.some((m) => resp.body.includes(m))) {
          exhaustedSeen = true;
          continue;
        }
        if (resp.status >= 200 && resp.status < 300 && !resp.json?.error) {
          return { working: true, latencyMs: latency, reason: "ok", model: usedModel };
        }
      } catch (e) {
        return { working: false, latencyMs: 0, reason: "dead", model: usedModel };
      }
    }
    return { working: false, latencyMs: 0, reason: exhaustedSeen ? "exhausted" : "dead", model: usedModel };
  }

  async cycleFetch() {
    if (this.fetchInProgress) return;
    this.fetchInProgress = true;
    this.stats.fetchCycles += 1;
    try {
      const raw = await this.fetchRaw();
      this.stats.totalFetched = raw.length;
      const newUrls = raw.filter((u) => !this.seen.has(u));
      if (!newUrls.length) { logger.info(`[pool] no new proxies (pool ${this.proxies.length})`); return; }
      const sample = newUrls.slice(0, 100);
      const tested = [];
      for (const url of sample) {
        const r = await this.testProxy(url);
        this.stats.totalTested += 1;
        if (!r.working) {
          if (r.reason === "exhausted") { this.stats.totalExhausted += 1; this.seen.add(url); }
          else { this.stats.totalDead += 1; }
          continue;
        }
        if (r.latencyMs > this.cfg.maxLatencyMs) { this.stats.totalSlow += 1; this.seen.add(url); continue; }
        tested.push({ url, latency_ms: r.latencyMs, model: r.model, tested_at: new Date().toISOString() });
      }
      const added = this.addProxies(tested);
      this.lastFetch = new Date().toISOString();
      logger.info(`[pool] fetch cycle: ${tested.length} tested, ${added} added (pool ${this.proxies.length})`);
    } finally {
      this.fetchInProgress = false;
    }
  }

  async cycleHealth() {
    if (this.healthInProgress) return;
    this.healthInProgress = true;
    this.stats.healthCycles += 1;
    try {
      const sample = this.proxies.slice(0, Math.max(5, this.proxies.length));
      const dead = [];
      for (const p of sample) {
        const r = await this.testProxy(p.url);
        if (!r.working) {
          this.cooldown.set(p.url, Date.now() + 60_000);
          if (r.reason === "exhausted") { dead.push(p.url); this.stats.totalExhausted += 1; }
          else { dead.push(p.url); this.stats.totalDead += 1; }
        }
      }
      this.removeProxies(dead);
      this.lastHealth = new Date().toISOString();
      if (dead.length) logger.info(`[pool] health cycle: removed ${dead.length} (pool ${this.proxies.length})`);
    } finally {
      this.healthInProgress = false;
    }
  }

  addProxies(items) {
    let added = 0;
    for (const p of items) {
      if (this.proxies.length >= (this.cfg.maxPoolSize ?? 100)) break;
      if (!this.seen.has(p.url)) {
        this.proxies.push(p);
        this.seen.add(p.url);
        added += 1;
      }
    }
    if (added) this.stats.totalAdded += added;
    return added;
  }

  removeProxies(urls) {
    const set = new Set(urls);
    const before = this.proxies.length;
    this.proxies = this.proxies.filter((p) => !set.has(p.url));
    const removed = before - this.proxies.length;
    if (removed) this.stats.totalRemoved += removed;
    return removed;
  }

  start() {
    const fi = this.cfg.fetchIntervalSeconds ?? 300;
    const hi = this.cfg.healthCheckIntervalSeconds ?? 60;
    this.cycleFetch();
    this._timers.push(setInterval(() => this.cycleFetch(), fi * 1000));
    this._timers.push(setInterval(() => this.cycleHealth(), hi * 1000));
    logger.info(`[pool] embedded pool started (fetch ${fi}s, health ${hi}s)`);
  }

  stop() {
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
  }
}

function nextMidnight() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

class FallbackPool {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.proxies = [];           // [{url, added_at}]
    this.cursor = 0;
    this.active = null;          // url proxy yang sedang dipakai (persisten sampai limit/gagal)
    this.exhausted = new Map();  // url -> epoch ms (limit hit → reset harian, besok aktif lagi)
    this.dead = new Map();       // url -> epoch ms until retry (connect failure, cooldown singkat)
    this.sources = cfg.sources || [];
    this.stats = { totalAdded: 0, totalRemoved: 0, exhaustedCount: 0, refetches: 0, autoRefreshes: 0 };
    this.lastFetch = null;
    this.fetchInProgress = false;
    this.nextResetAt = nextMidnight();
  }

  get cooldownMs() {
    return this.cfg.cooldownMs ?? 60_000;
  }
  get minLiveProxies() {
    return this.cfg.minLiveProxies ?? 3;
  }
  get minRefetchIntervalMs() {
    return this.cfg.minRefetchIntervalMs ?? 60_000;
  }
  get maxTestPerCycle() {
    return this.cfg.maxTestPerCycle ?? 10;
  }
  get testTimeoutMs() {
    return this.cfg.testTimeoutMs ?? 5000;
  }

  /** Jumlah proxy yang saat ini layak dipakai (tidak exhausted & tidak dead). */
  usableCount() {
    const now = Date.now();
    let n = 0;
    for (const p of this.proxies) {
      const ex = this.exhausted.get(p.url);
      const d = this.dead.get(p.url);
      if ((!ex || ex <= now) && (!d || d <= now)) n += 1;
    }
    return n;
  }

  load(urls) {
    this.proxies = (urls || []).map((u) => (typeof u === "string" ? { url: u, added_at: new Date().toISOString() } : u));
    for (const url of [...this.exhausted.keys()]) {
      if (!this.proxies.some((p) => p.url === url)) this.exhausted.delete(url);
    }
    for (const url of [...this.dead.keys()]) {
      if (!this.proxies.some((p) => p.url === url)) this.dead.delete(url);
    }
    if (this.cursor >= this.proxies.length) this.cursor = 0;
    return this.proxies.length;
  }

  get maxPoolSize() {
    return this.cfg.maxPoolSize ?? 30;
  }

  add(url) {
    if (this.proxies.some((p) => p.url === url)) return false;
    if (this.proxies.length >= this.maxPoolSize) return false; // kualitas > kuantitas
    this.proxies.push({ url, added_at: new Date().toISOString() });
    this.stats.totalAdded += 1;
    return true;
  }

  remove(url) {
    const before = this.proxies.length;
    this.proxies = this.proxies.filter((p) => p.url !== url);
    this.exhausted.delete(url);
    this.dead.delete(url);
    if (this.proxies.length !== before) this.stats.totalRemoved += 1;
    if (this.cursor >= this.proxies.length && this.proxies.length) this.cursor = 0;
    return this.proxies.length !== before;
  }

  /**
   * Proxy aktif dipakai TERUS sampai limit (reportLimit) atau gagal koneksi
   * (reportFailure) — baru pindah. Auto-refresh lazy: jika stok proxy hidup
   * menipis (< minLiveProxies) dan jeda fetch terpenuhi, fetch+filter berjalan
   * di background tanpa memblokir request. Proxy exhausted otomatis aktif lagi
   * besok (nextResetAt) — siklus harian berulang.
   */
  nextProxy() {
    const now = Date.now();
    if (now >= this.nextResetAt) {
      this.nextResetAt = nextMidnight();
      this.exhausted.clear(); // reset harian: proxy yang limit kemarin aktif lagi
    }
    // Auto-refresh lazy: stok hidup menipis.
    if (this.usableCount() < this.minLiveProxies) {
      const last = this.lastFetch ? new Date(this.lastFetch).getTime() : 0;
      if (now - last >= this.minRefetchIntervalMs) this.autoRefresh();
    }
    if (!this.proxies.length) {
      this.autoRefresh();
      return null;
    }
    // Pertahankan proxy aktif jika masih sehat.
    if (this.active) {
      const ex = this.exhausted.get(this.active);
      const d = this.dead.get(this.active);
      if ((!ex || ex <= now) && (!d || d <= now)) return this.active;
      this.active = null;
    }
    const total = this.proxies.length;
    for (let i = 0; i < total; i++) {
      const idx = (this.cursor + i) % total;
      const p = this.proxies[idx];
      const ex = this.exhausted.get(p.url);
      const d = this.dead.get(p.url);
      if ((!ex || ex <= now) && (!d || d <= now)) {
        this.active = p.url;
        this.cursor = (idx + 1) % total;
        return p.url;
      }
    }
    this.autoRefresh();
    const p = this.proxies[this.cursor % total];
    this.active = p.url;
    this.cursor = (this.cursor + 1) % total;
    return p.url;
  }

  /** 429/403 usage-limit: IP proxy ini habis hari ini — aktif lagi besok. */
  reportLimit(url) {
    this.exhausted.set(url, nextMidnight());
    this.stats.exhaustedCount += 1;
    if (this.active === url) this.active = null;
  }

  /** Connect failure (transport error): proxy ini BURUK — buang permanen dari pool. */
  reportBadProxy(url) {
    this.remove(url);
    try { require("./store.js").removeProxy(url); } catch {}
    this.stats.totalRemoved += 1;
    if (this.active === url) this.active = null;
  }

  /** 5xx dari upstream (bukan masalah proxy): cooldown singkat, proxy tetap dipakai nanti. */
  reportFailure(url) {
    const ms = this.cfg.deadCooldownMs ?? 60_000;
    this.dead.set(url, Date.now() + ms);
    if (this.active === url) this.active = null;
  }

  /** Fetch dari sources + liveness-filter kandidat baru (paralel, debounce). */
  async autoRefresh(force = false) {
    const sources = this.cfg.sources || [];
    if (this.fetchInProgress) return;
    if (!force && !sources.length) return;
    this.fetchInProgress = true;
    try {
      const transport = require("./transport.js");
      const store = require("./store.js");
      const lists = [];
      for (const src of sources) {
        try {
          const resp = await transport.request({ url: src, timeoutMs: 20000 });
          if (resp.status === 200) {
            const lines = resp.body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            lists.push(...lines.map((l) => (l.startsWith("http://") || l.startsWith("https://") ? l : `http://${l}`)));
          }
        } catch {}
      }
      // Liveness-test kandidat baru — HANYA yang lolos request beneran masuk pool.
      const seen = new Set(this.proxies.map((p) => p.url));
      const candidates = [...new Set(lists)].filter((u) => !seen.has(u)).slice(0, this.maxTestPerCycle);
      const results = await Promise.allSettled(candidates.map((u) => this.livenessTest(u)));
      let added = 0;
      for (let i = 0; i < candidates.length; i++) {
        const ok = results[i]?.status === "fulfilled" && results[i].value === true;
        if (ok) { this.add(candidates[i]); added++; }
        else { this.reportBadProxy(candidates[i]); }
      }
      // Re-test sampel proxy LAMA — yang gagal request beneran DIBUANG PERMANEN.
      const sample = this.proxies.slice(0, this.maxTestPerCycle);
      const sampleResults = await Promise.allSettled(sample.map((p) => this.livenessTest(p.url)));
      let removed = 0;
      for (let i = 0; i < sample.length; i++) {
        const ok = sampleResults[i]?.status === "fulfilled" && sampleResults[i].value === true;
        if (!ok && this.active !== sample[i].url) { this.reportBadProxy(sample[i].url); removed++; }
      }
      if (added || removed) {
        for (const p of this.proxies) store.addProxy(p.url);
        this.load(store.listProxies());
      }
      this.stats.refetches += 1;
      if (!force) this.stats.autoRefreshes += 1;
      this.lastFetch = new Date().toISOString();
    } finally {
      this.fetchInProgress = false;
    }
  }

  /**
   * Liveness test = REQUEST BENERAN melalui proxy (bukan cuma CONNECT):
   * GET https://opencode.ai/zen/v1/models lewat proxy dengan gaya tunnel.
   * Proxy yang bisa menyelesaikan request HTTP nyata ke opencode = hidup.
   */
  livenessTest(url) {
    return new Promise((resolve) => {
      const transport = require("./transport.js");
      const timer = setTimeout(() => resolve(false), this.testTimeoutMs);
      transport.request({
        url: "https://opencode.ai/zen/v1/models",
        method: "GET",
        headers: { "User-Agent": "opencode/1.18.18", "x-opencode-client": "desktop" },
        proxy: url,
        proxyStyle: "tunnel",
        timeoutMs: this.testTimeoutMs,
      }).then((resp) => {
        clearTimeout(timer);
        resolve(resp.status === 200);
      }).catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  status() {
    const now = Date.now();
    const exhaustedList = [...this.exhausted.entries()]
      .filter(([, t]) => t > now)
      .map(([url, t]) => ({ url, resetAt: new Date(t).toISOString() }));
    return {
      mode: "manual",
      poolSize: this.proxies.length,
      usableCount: this.usableCount(),
      cursor: this.cursor,
      cooldownMs: this.cooldownMs,
      exhaustedCount: exhaustedList.length,
      deadCount: [...this.dead.entries()].filter(([, t]) => t > now).length,
      nextResetAt: new Date(this.nextResetAt).toISOString(),
      lastFetch: this.lastFetch,
      sources: this.cfg.sources || [],
      proxies: this.proxies.slice(0, 50),
      exhausted: exhaustedList.slice(0, 20),
      stats: this.stats,
    };
  }
}

class ProxyRouter {
  constructor(config) {
    this.config = config;
    this.mode = config.proxy.mode || "none";
    this.embedded = new EmbeddedPool(config.proxy.embedded || {});
    this.manual = new FallbackPool(config.proxy.manual || {});
  }

  setMode(mode) {
    this.embedded.cfg = this.config?.proxy?.embedded || {};
    if (this.mode === "embedded" && mode !== "embedded") this.embedded.stop();
    this.mode = mode;
    if (mode === "embedded") this.embedded.start();
  }

  async start() {
    if (this.mode === "embedded") this.embedded.start();
  }

  nextProxy() {
    if (this.mode === "none") return null;
    if (this.mode === "upstream") return this.config.proxy.upstream || null;
    if (this.mode === "warp") return (this.config.proxy.warp && this.config.proxy.warp.poolSocks) || "socks5h://127.0.0.1:11801";
    if (this.mode === "manual") return this.manual.nextProxy();
    if (this.mode === "embedded") return this.embedded.nextProxy();
    return null;
  }

  reportFailure(proxy) {
    if (!proxy) return;
    if (this.mode === "manual") this.manual.reportFailure(proxy);
    else if (this.mode === "embedded") this.embedded.reportFailure(proxy);
  }

  /** Transport error = proxy buruk → buang permanen. */
  reportBadProxy(proxy) {
    if (!proxy) return;
    if (this.mode === "manual") this.manual.reportBadProxy(proxy);
    else if (this.mode === "embedded") this.embedded.reportFailure(proxy);
  }

  /** Called on 429/403 usage-limit: rotate to a fresh IP on the next attempt. */
  reportLimit(proxy) {
    if (!proxy) return;
    if (this.mode === "manual") this.manual.reportLimit(proxy);
    else if (this.mode === "embedded") this.embedded.reportFailure(proxy);
  }

  status() {
    if (this.mode === "none") return { mode: "none", poolSize: 0 };
    if (this.mode === "warp") return { mode: "warp", poolSize: 0, note: "pool Fase 3 (direct fallback)" };
    if (this.mode === "upstream") return { mode: "upstream", upstream: this.config.proxy.upstream, poolSize: 0 };
    if (this.mode === "manual") return this.manual.status();
    return this.embedded.status();
  }
}

module.exports = { ProxyRouter, EmbeddedPool, FallbackPool, stripPrefix };
