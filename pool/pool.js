"use strict";
/*
 * pool/pool.js — warp-pool slim (adopsi metode warpy-pool, tanpa GUI/desktop).
 *
 * SOCKS5 pool di :11801 → round-robin ke warp-a :11810 / warp-b :11811.
 * Health probe per backend + reset coordinator (mutex + cooldown + active
 * verify) + status API :9190 (GET /, GET /health, POST /api/report).
 * Reset aktual didelegasikan ke hook (default: `archrouter warp-reset <id>`).
 * Zero dependency. TCP CONNECT saja (UDP ASSOCIATE dijawab 0x07 jujur).
 *
 * Usage: node pool.js [--listen 127.0.0.1:11801] [--status-port 9190]
 *   [--backend a=127.0.0.1:11810] [--backend b=127.0.0.1:11811]
 *   [--reset-hook "archrouter warp-reset %ID%"] [--health-url URL]
 *   [--health-interval 30] [--health-fail-thr 3] [--min-reset-gap 30]
 *   [--verify-timeout 5] [--hook-timeout 120] [--auto-reset 1]
 *   [--quarantine-secs 300] [--same-ip-guard 1] [--distinct-retries 5]
 *   [--distinct-retry-delay 12] [--park-retry-delay 180]
 *
 * 429/403 rotation: the router POSTs /api/report on usage-limit. The pool
 * quarantines the backend that last served opencode.ai (excluded from RR
 * for quarantine-secs) and resets it in background — traffic fails over
 * to the healthy backend while the burned one re-handshakes for a new IP.
 *
 * Same-IP guard (quota is per egress IP — two accounts sharing one IP burn
 * one quota bucket together, proven 2026-09-25 when .130 and .247.133 each
 * returned 429 for a single client). WARP assigns the egress IP per colo,
 * NOT per wgcf account, so two accounts can land on one IP. Therefore:
 *   - after every probe the pool reconciles IP uniqueness: a group of
 *     backends sharing one IP elects a keeper (healthiest, oldest ipSince)
 *     and parks the rest — parked backends are skipped by pickBackend, so
 *     traffic NEVER runs through two accounts on the same egress IP;
 *   - resets can run "until distinct": if the fresh handshake lands on the
 *     sibling's IP, the reset is retried (distinct-retries x distinct-retry-delay)
 *     instead of silently accepting a shared IP;
 *   - a usage-limit report on a shared IP quarantines BOTH backends on that
 *     IP (the sibling's quota is burned too) and resets both;
 *   - status / exposes ip_conflict + parked so collisions are observable.
 * A parked backend keeps retrying in the background (park-retry-delay) and
 * rejoins RR as soon as it reports a distinct IP. Guard off: --same-ip-guard 0.
 *
 * Always-on: when no warp backend is healthy (or all dials fail), the pool
 * serves via direct TCP egress and counts it in totals.direct_fallback.
 * --auto-reset 0 disables coordinator resets (useful on UDP-filtered
 * networks where resets can never succeed); traffic still flows direct.
 */

const net = require("net");
const http = require("http");
const https = require("https");
const tls = require("tls");
const dns = require("dns");
const { spawn } = require("child_process");

// Resolve dst hostname via the OS resolver BEFORE dialing the warp backend.
// sing-box inside the tunnel has no working resolver on this network (its
// DNS queries ride route.final=warp-ep and come back REFUSED — proven
// 2026-09-24: `lookup api.ipify.org: exchange4 REFUSED`, while system dig
// works fine). So the pool does the resolution and passes an IPv4 literal
// to the backend; SNI/Host upstream are unaffected (we only change the
// SOCKS CONNECT target, not the TLS servername / HTTP Host).
function resolveIPv4(host) {
  if (/^[\d.]+$/.test(host)) return Promise.resolve(host);
  return dns.promises.lookup(host, { family: 4 }).then(
    (r) => r.address,
    (e) => { throw new Error(`local resolve ${host}: ${e.message}`); }
  );
}

function parseArgs(argv) {
  const o = { backends: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    let val = eq > 0 ? a.slice(eq + 1) : true;
    if (eq < 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--")) val = argv[++i];
    if (key === "backend") o.backends.push(val);
    else o[key] = val;
  }
  return o;
}

function splitHostPort(s, defPort) {
  const m = String(s).match(/^(?:\[([^\]]+)\]|([^:]+))(?:\:(\d+))?$/);
  if (!m) throw new Error(`bad host:port: ${s}`);
  return { host: m[1] || m[2], port: Number(m[3] || defPort) };
}

function log(...a) { console.log(`[pool ${new Date().toISOString()}]`, ...a); }

// Never die silently: log crashes before exit (helps launcher debugging).
process.on("uncaughtException", (e) => { log(`FATAL uncaught: ${e.stack || e.message}`); process.exit(1); });
process.on("unhandledRejection", (e) => { log(`FATAL unhandled rejection: ${e && e.stack || e}`); process.exit(1); });

/* ---------------- SOCKS5 client (pool → backend) ---------------- */

function socks5Connect(proxyHost, proxyPort, dstHost, dstPort, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let sock = null;
    let timer = null;
    const done = (err, s) => { clearTimeout(timer); err ? (sock && sock.destroy(), reject(err)) : resolve(s); };
    // Resolve locally first (see resolveIPv4): pass IP literal downstream.
    resolveIPv4(dstHost).then((ip) => {
      sock = net.connect(proxyPort, proxyHost);
      timer = setTimeout(() => { sock.destroy(); reject(new Error("socks5 dial timeout")); }, timeoutMs);
      sock.once("error", (e) => done(e));
      sock.once("connect", () => {
        sock.write(Buffer.from([0x05, 0x01, 0x00])); // no-auth
        let stage = 0, buf = Buffer.alloc(0);
        sock.on("data", (c) => {
          buf = Buffer.concat([buf, c]);
          if (stage === 0 && buf.length >= 2) {
            if (buf[0] !== 0x05 || buf[1] !== 0x00) return done(new Error("socks5 auth rejected"));
            stage = 1; buf = Buffer.alloc(0);
            const ip4 = ip.split(".").map(Number);
            const req = Buffer.from([0x05, 0x01, 0x00, 0x01, ip4[0], ip4[1], ip4[2], ip4[3],
              (dstPort >> 8) & 0xff, dstPort & 0xff]);
            sock.write(req);
          } else if (stage === 1 && buf.length >= 10) {
            if (buf[1] !== 0x00) return done(Object.assign(new Error(`socks5 connect failed rep=${buf[1]}`), { rep: buf[1] }));
            sock.removeAllListeners("data");
            done(null, sock);
          }
        });
      });
    }).catch(reject);
  });
}

function fetchViaSocks(backend, urlStr, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const mod = u.protocol === "https:" ? https : http;
    socks5Connect(backend.host, backend.port, u.hostname, Number(u.port) || (u.protocol === "https:" ? 443 : 80), timeoutMs)
      .then((sock) => {
        // NOTE: custom createConnection bypasses Node's implicit TLS wrap,
        // so for https we must TLS-wrap the SOCKS tunnel ourselves.
        const mkConn = () => {
          if (u.protocol !== "https:") return sock;
          return tls.connect({ socket: sock, servername: u.hostname });
        };
        const req = mod.request({
          createConnection: mkConn, method: "GET", path: u.pathname + u.search || "/",
          headers: { Host: u.host, "User-Agent": "archrouter-pool/0.1", Connection: "close" },
        });
        const timer = setTimeout(() => { try { req.destroy(); } catch {} reject(new Error("probe timeout")); }, timeoutMs);
        req.on("response", (resp) => {
          let body = "";
          resp.on("data", (c) => { body += c; if (body.length > 4096) resp.destroy(); });
          resp.on("end", () => { clearTimeout(timer); resolve({ status: resp.statusCode || 0, body: body.trim() }); });
        });
        req.on("error", (e) => { clearTimeout(timer); reject(e); });
        req.end();
      })
      .catch(reject);
  });
}

/* ---------------- pool state ---------------- */

const args = parseArgs(process.argv.slice(2));
const [listenHost, listenPortStr] = String(args.listen || "127.0.0.1:11801").split(":");
const LISTEN = { host: listenHost, port: Number(listenPortStr || 11801) };
const STATUS_PORT = Number(args["status-port"] || 9190);
const HEALTH_URL = args["health-url"] || "https://api.ipify.org";
const HEALTH_INTERVAL = Number(args["health-interval"] || 30) * 1000;
const HEALTH_FAIL_THR = Number(args["health-fail-thr"] || 3);
const MIN_RESET_GAP = Number(args["min-reset-gap"] || 30) * 1000;
const VERIFY_TIMEOUT = Number(args["verify-timeout"] || 5) * 1000;
const HOOK_TIMEOUT = Number(args["hook-timeout"] || 120) * 1000;
const RESET_HOOK = args["reset-hook"] || "archrouter warp-reset %ID%";
const AUTO_RESET = String(args["auto-reset"] ?? "1") !== "0";
const QUARANTINE_SECS = Number(args["quarantine-secs"] || 300);
// Same-IP guard: quota is per egress IP, and WARP hands the same IP to
// different accounts (per-colo assignment, not per-account). Keep the two
// backends on distinct egress IPs at all times.
const SAME_IP_GUARD = String(args["same-ip-guard"] ?? "1") !== "0";
const DISTINCT_RETRIES = Math.max(1, Number(args["distinct-retries"] || 5));
const DISTINCT_RETRY_DELAY = Math.max(0, Number(args["distinct-retry-delay"] || 12)) * 1000;
const PARK_RETRY_DELAY = Math.max(5, Number(args["park-retry-delay"] || 180)) * 1000;
const SWEEP_INTERVAL = Math.max(2, Number(args["sweep-interval"] || 10)) * 1000;

const backendDefs = args.backends.length ? args.backends : ["a=127.0.0.1:11810", "b=127.0.0.1:11811"];
const backends = backendDefs.map((d) => {
  const eq = d.indexOf("=");
  const id = d.slice(0, eq);
  const hp = splitHostPort(d.slice(eq + 1), 1080);
  return {
    id, host: hp.host, port: hp.port,
    consecFails: 0, lastOk: 0,
    lastIp: null,
    ipSince: 0,        // when lastIp was first observed (keeper election)
    parked: false,     // shares its egress IP with a sibling → excluded from RR
    parkedAt: 0,
    retryAt: 0,        // next background diverge attempt for a parked backend
    lastReset: 0, lastResetAt: 0, resetting: false, quarantineUntil: 0, rr: true,
  };
});

// host -> backend id that last served it (used to map 429/403 limit reports
// to the backend whose IP actually got burned).
const lastServe = {};

const totals = { total_resets: 0, success_count: 0, same_ip_count: 0, direct_fallback: 0, park_count: 0, unpark_count: 0, conflict_resets: 0, shared_ip_quarantines: 0 };
const events = [];
function event(type, instance, msg) {
  events.push({ time: new Date().toISOString(), type, instance, msg });
  if (events.length > 50) events.shift();
  log(`[${type}] inst=${instance} ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- same-egress-IP guard ----------------
 * Quota lives on the egress IP, so two accounts on one IP share one bucket.
 * WARP assigns the IP per colo (NOT per account), so collisions happen.
 * reconcileIpUniqueness() elects one keeper per shared IP and parks the
 * rest; parked backends are skipped by pickBackend until they diverge. */

function conflictPartner(b) {
  if (!b.lastIp) return null;
  return backends.find((x) => x !== b && x.lastIp && x.lastIp === b.lastIp) || null;
}
function isHealthy(b) { return b.consecFails < HEALTH_FAIL_THR; }
function hasIpConflict() { return backends.some((b) => !!conflictPartner(b)); }

function reconcileIpUniqueness(source) {
  if (!SAME_IP_GUARD) return;
  const groups = new Map();
  for (const b of backends) {
    if (!b.lastIp) continue;
    const g = groups.get(b.lastIp) || [];
    g.push(b);
    groups.set(b.lastIp, g);
  }
  for (const [ip, group] of groups) {
    if (group.length < 2) {
      for (const b of group) {
        if (b.parked) {
          b.parked = false; b.parkedAt = 0; b.retryAt = 0;
          totals.unpark_count += 1;
          event("same-ip", b.id, `distinct egress IP ${ip} → back in rotation (source=${source})`);
        }
      }
      continue;
    }
    // Keeper: healthy first (a down backend cannot keep the slot), then the
    // one that has held this IP longest (stable, least churn).
    const ordered = [...group].sort((x, y) => (isHealthy(y) - isHealthy(x)) || (x.ipSince - y.ipSince));
    const keeper = ordered[0];
    for (const b of group) {
      if (b === keeper) {
        if (b.parked) {
          b.parked = false; b.parkedAt = 0; b.retryAt = 0;
          totals.unpark_count += 1;
          event("same-ip", b.id, `keeps egress IP ${ip} (shared with sibling) — back in rotation`);
        }
        continue;
      }
      if (!b.parked) {
        b.parked = true; b.parkedAt = Date.now(); b.retryAt = 0;
        totals.park_count += 1;
        event("same-ip", b.id, `egress IP ${ip} shared with ${keeper.id} → parked, excluded from RR until distinct (source=${source})`);
      }
    }
  }
  // A backend that lost its IP knowledge (reset in flight) must not stay
  // parked forever: if it is parked but reports no IP, let probes re-decide.
  for (const b of backends) {
    if (b.parked && !b.lastIp) { b.parked = false; b.parkedAt = 0; }
  }
}

// Parked backends get background reset attempts until they report a distinct
// IP. Rate-limited by park-retry-delay; respects the per-instance mutex.
function sweepParked() {
  if (!SAME_IP_GUARD || !AUTO_RESET) return;
  const now = Date.now();
  for (const b of backends) {
    if (!b.parked || b.resetting) continue;
    if (b.retryAt && now < b.retryAt) continue;
    b.retryAt = now + PARK_RETRY_DELAY;
    event("same-ip", b.id, `background diverge attempt (shares ${b.lastIp} with ${(conflictPartner(b) || {}).id || "?"})`);
    void coordinatorReset(b.id, "same-ip", { untilDistinct: true }).then((r) => {
      if (r.code !== 200 && r.code !== 202) log(`[coordinator] parked diverge ${b.id}: ${r.code} ${r.msg}`);
    });
  }
}
setInterval(sweepParked, SWEEP_INTERVAL);

let rrIndex = 0;
function isQuarantined(b, now = Date.now()) {
  return b.quarantineUntil > now;
}
function pickBackend() {
  const now = Date.now();
  const pick = (list) => { const b = list[rrIndex % list.length]; rrIndex += 1; return b; };
  const healthy = (b) => isHealthy(b) && !isQuarantined(b, now);
  // Serve-guard: never hand traffic to two accounts sharing one egress IP.
  // Parked backends stay out of RR as long as a keeper exists.
  const fresh = backends.filter((b) => healthy(b) && !b.parked);
  if (fresh.length) return pick(fresh);
  // Keeper itself is quarantined/down: prefer a parked healthy backend over a
  // burned one — still a single account on the shared IP, traffic keeps flowing.
  const healthyParked = backends.filter((b) => healthy(b) && b.parked);
  if (healthyParked.length) return pick(healthyParked);
  // Everything is quarantined: prefer the one whose quarantine expires soonest.
  const byQuarantine = [...backends].sort((x, y) => x.quarantineUntil - y.quarantineUntil);
  return pick(byQuarantine);
}

/* ---------------- SOCKS5 server (client → pool) ---------------- */

function replyFail(sock, rep = 0x01) {
  try { sock.write(Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch {}
  sock.destroy();
}

async function serveClient(client) {
  client.setTimeout(5 * 60 * 1000);
  client.on("timeout", () => client.destroy());
  client.on("error", () => {});
  let stage = 0, buf = Buffer.alloc(0);
  const onData = async (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    try {
      if (stage === 0) {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        client.write(Buffer.from([0x05, 0x00]));
        buf = buf.slice(2 + buf[1]); stage = 1;
      }
      if (stage === 1) {
        if (buf.length < 4) return;
        const cmd = buf[1], atyp = buf[3];
        if (cmd !== 0x01) { event("warn", "-", `unsupported CMD=${cmd} (TCP only)`); client.removeListener("data", onData); return replyFail(client, 0x07); }
        let host, port, off;
        if (atyp === 0x01) { if (buf.length < 10) return; host = [...buf.slice(4, 8)].join("."); port = buf.readUInt16BE(8); off = 10; }
        else if (atyp === 0x03) { const n = buf[4]; if (buf.length < 5 + n + 2) return; host = buf.slice(5, 5 + n).toString("utf8"); port = buf.readUInt16BE(5 + n); off = 5 + n + 2; }
        else if (atyp === 0x04) { if (buf.length < 22) return; host = buf.slice(4, 20).toString("hex").replace(/(.{4})(?=.)/g, "$1:"); port = buf.readUInt16BE(20); off = 22; }
        else { client.removeListener("data", onData); return replyFail(client, 0x08); }
        buf = buf.slice(off);
        client.removeListener("data", onData);
        await relay(client, host, port);
      }
    } catch { try { client.destroy(); } catch {} }
  };
  client.on("data", onData);
}

async function relay(client, host, port) {
  let lastErr = null;
  for (let i = 0; i < backends.length; i++) {
    const b = pickBackend();
    try {
      const up = await socks5Connect(b.host, b.port, host, port);
      b.consecFails = 0; b.lastOk = Date.now();
      lastServe[host] = b.id;
      event("serve", b.id, `${host}:${port}`);
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      client.pipe(up); up.pipe(client);
      const done = () => { try { client.destroy(); } catch {} try { up.destroy(); } catch {} };
      client.on("close", done); up.on("close", done);
      client.on("error", done); up.on("error", done);
      return;
    } catch (e) {
      lastErr = e;
      b.consecFails += 1;
      event("warn", b.id, `backend dial failed (${e.message}) fails=${b.consecFails}`);
    }
  }
  // Always-on: all warp backends down (e.g. UDP-filtered mobile network) →
  // direct TCP egress so traffic keeps flowing. Uses the OS resolver
  // (works where sing-box's built-in resolver has no stub, e.g. Termux).
  try {
    const direct = await directConnect(host, port);
    totals.direct_fallback += 1;
    event("serve", "direct", `${host}:${port} (fallback #${totals.direct_fallback}, warp down)`);
    client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    client.pipe(direct); direct.pipe(client);
    const done = () => { try { client.destroy(); } catch {} try { direct.destroy(); } catch {} };
    client.on("close", done); direct.on("close", done);
    client.on("error", done); direct.on("error", done);
    return;
  } catch (e) {
    lastErr = e;
    event("error", "-", `direct fallback failed for ${host}:${port}: ${e.message}`);
  }
  event("error", "-", `no backend for ${host}:${port}: ${lastErr && lastErr.message}`);
  replyFail(client, 0x05);
}

function directConnect(host, port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("direct dial timeout")); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(timer); resolve(sock); });
    sock.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/* ---------------- health probe ---------------- */

async function probeBackend(b) {
  try {
    const r = await fetchViaSocks(b, HEALTH_URL, 10000);
    if (r.status >= 200 && r.status < 400) {
      b.consecFails = 0; b.lastOk = Date.now();
      // HEALTH_URL may be a bare-IP endpoint (api.ipify.org) or a trace
      // page (https://1.1.1.1/cdn-cgi/trace → "ip=1.2.3.4" lines).
      const ipMatch = /^ip=([\d.]+)$/m.exec(r.body) || (/^[\d.]+$/.test(r.body.trim()) ? [null, r.body.trim()] : null);
      if (ipMatch && ipMatch[1] !== b.lastIp) {
        b.ipSince = Date.now();
        b.lastIp = ipMatch[1];
        // A fresh IP re-opens the slot: clear the parked flag decision and
        // re-elect keepers (this backend may now be the odd one out).
        b.retryAt = 0;
        reconcileIpUniqueness(`probe:${b.id}`);
      }
      return true;
    }
    throw new Error(`status ${r.status}`);
  } catch (e) {
    b.consecFails += 1;
    log(`[health] ${b.id} FAIL ${b.consecFails}/${HEALTH_FAIL_THR} (${e.message})`);
    if (b.consecFails === HEALTH_FAIL_THR) {
      if (AUTO_RESET) {
        event("detect", b.id, `health threshold reached → reset (source=health)`);
        void coordinatorReset(b.id, "health");
      } else {
        event("detect", b.id, `health threshold reached (auto-reset OFF, direct-fallback active)`);
      }
    }
    return false;
  }
}

setInterval(() => { for (const b of backends) void probeBackend(b); }, HEALTH_INTERVAL);
for (const b of backends) void probeBackend(b); // immediate first probe

/* ---------------- reset coordinator ---------------- */
/* Per-instance locks: a and b reset INDEPENDENTLY. When a is burned and
 * resetting, b keeps serving (and vice versa) — the whole point of two
 * backends. Cooldown is per-instance too. */

function runHook(id) {
  return new Promise((resolve) => {
    const cmd = RESET_HOOK.replace(/%ID%/g, id);
    log(`[coordinator] hook: ${cmd}`);
    const child = spawn(cmd, { shell: true, stdio: "ignore" });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve({ ok: false, msg: "hook timeout" }); }, HOOK_TIMEOUT);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, msg: `hook spawn: ${e.message}` }); });
    child.on("exit", (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, msg: `hook exit ${code}` }); });
  });
}

async function verifyBackend(b, ipBefore) {
  if (ipBefore === undefined) ipBefore = b.lastIp;
  const deadline = Date.now() + Math.max(VERIFY_TIMEOUT * 6, 30000);
  while (Date.now() < deadline) {
    if (await probeBackend(b)) {
      const same = ipBefore && b.lastIp && ipBefore === b.lastIp;
      return { ok: true, sameIp: !!same, ip: b.lastIp };
    }
    await sleep(2000);
  }
  return { ok: false };
}

async function coordinatorReset(id, source, opts = {}) {
  const b = backends.find((x) => x.id === id);
  if (!b) return { code: 404, msg: `unknown instance ${id}` };
  if (!AUTO_RESET) return { code: 503, msg: "auto-reset disabled (direct-fallback active)" };
  if (b.resetting) return { code: 409, msg: `reset already in progress for ${id}`, retryAfter: 30 };
  const gap = Date.now() - b.lastResetAt;
  if (gap < MIN_RESET_GAP) return { code: 429, msg: `cooldown ${(MIN_RESET_GAP - gap) / 1000}s remaining for ${id}`, retryAfter: Math.ceil((MIN_RESET_GAP - gap) / 1000) };
  const untilDistinct = !!opts.untilDistinct && SAME_IP_GUARD;
  const maxAttempts = untilDistinct ? DISTINCT_RETRIES : 1;
  b.resetting = true;
  const ipBefore = b.lastIp;
  // Drop the stale IP while the tunnel is down: a half-dead backend must not
  // be reported as an IP conflict (nor keep a keeper slot) on stale data.
  b.lastIp = null;
  event("reset", id, `START source=${source} currentIP=${ipBefore}${untilDistinct ? " untilDistinct" : ""}`);
  totals.total_resets += 1; // counted per reset CALL (retries are attempts, not resets)
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const hook = await runHook(id);
      if (!hook.ok) {
        event("error", id, `hook failed: ${hook.msg}`);
        return { code: 502, msg: hook.msg };
      }
      const v = await verifyBackend(b, ipBefore);
      b.lastResetAt = Date.now();
      b.lastReset = b.lastResetAt;
      if (v.ok) {
        // Invariant: two accounts must never share an egress IP. If the fresh
        // handshake landed on the sibling's IP, retry instead of accepting it.
        const partner = conflictPartner(b);
        if (partner && untilDistinct) {
          totals.conflict_resets += 1;
          event("same-ip", id, `post-reset IP ${v.ip} still shared with ${partner.id} (attempt ${attempt}/${maxAttempts})`);
          if (attempt < maxAttempts) {
            // Let the sibling keep the slot; only one tunnel bounces at a time.
            await sleep(DISTINCT_RETRY_DELAY);
            continue;
          }
          b.parked = true; b.parkedAt = Date.now();
          b.retryAt = Date.now() + PARK_RETRY_DELAY;
          event("same-ip-stuck", id, `still ${v.ip} after ${maxAttempts} attempts → parked, retry in ${Math.round(PARK_RETRY_DELAY / 1000)}s`);
          reconcileIpUniqueness(`reset:${id}`);
          return { code: 202, msg: `parked: egress IP ${v.ip} shared with ${partner.id}`, ip: v.ip };
        }
        totals.success_count += 1;
        if (v.sameIp) totals.same_ip_count += 1;
        else b.quarantineUntil = 0; // fresh IP → burned flag no longer applies
        event("reset", id, `DONE source=${source} → IP: ${v.ip}${v.sameIp ? " (same)" : ""}`);
        reconcileIpUniqueness(`reset:${id}`);
        return { code: 200, msg: `reset done → ${v.ip}` };
      }
      event("error", id, `verify FAILED after reset (attempt ${attempt}/${maxAttempts})`);
      if (attempt < maxAttempts) { await sleep(DISTINCT_RETRY_DELAY); continue; }
      return { code: 502, msg: "verify failed after reset" };
    }
    return { code: 202, msg: "reset attempts exhausted" };
  } finally {
    b.resetting = false;
    reconcileIpUniqueness(`reset-end:${id}`);
  }
}

/* Map a report event to the backend whose IP actually served the failed
// request: usage-limit events map via last-serve history for opencode.ai
// (explicit id wins); anything else uses the fail-count heuristic. */
const LIMIT_EVENTS = new Set(["freeusagelimit", "forbidden", "limit", "ip-limit", "429", "403"]);
function mapEventToBackend(explicitId, eventName) {
  if (explicitId) return backends.find((b) => b.id === explicitId) || null;
  if (eventName && LIMIT_EVENTS.has(String(eventName).toLowerCase())) {
    const lastId = lastServe["opencode.ai"];
    const b = lastId && backends.find((x) => x.id === lastId);
    if (b) return b;
  }
  const sorted = [...backends].sort((x, y) => (y.consecFails - x.consecFails) || (x.lastReset - y.lastReset));
  return sorted[0] || null;
}

/* ---------------- status API :9190 ---------------- */

function sendJson(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Content-Length": Buffer.byteLength(body), ...extra });
  res.end(body);
}

const api = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }); return res.end(); }
  if (u.pathname === "/health" && req.method === "GET") return sendJson(res, 200, { status: "ok", uptimeSeconds: Math.floor(process.uptime()) });
  if (u.pathname === "/" && req.method === "GET") {
    return sendJson(res, 200, {
      instances: backends.map((b) => ({ id: b.id, running: Date.now() - b.lastOk < 2 * HEALTH_INTERVAL, public_ip: b.lastIp, consecFails: b.consecFails, quarantined: isQuarantined(b), parked: b.parked, lastReset: b.lastReset ? new Date(b.lastReset).toISOString() : null })),
      ip_conflict: hasIpConflict(),
      parked: backends.filter((b) => b.parked).map((b) => b.id),
      same_ip_guard: SAME_IP_GUARD,
      smart_reset: { ...totals, success_rate: totals.total_resets ? `${Math.round((100 * totals.success_count) / totals.total_resets)}%` : "n/a" },
      resetting: backends.some((b) => b.resetting), events,
    });
  }
  if (u.pathname === "/api/report" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch {}
      const evtName = String(body.event || "?");
      const b = mapEventToBackend(body.instance, evtName);
      if (!b) return sendJson(res, 400, { error: "no backend" });
      event("report", b.id, `api event=${evtName}`);
      if (LIMIT_EVENTS.has(evtName.toLowerCase())) {
        // Usage-limit on this backend's IP: quarantine it NOW (RR skips it
        // → traffic fails over to the healthy backend) and reset it in
        // background for a fresh IP. Respond immediately so the router's
        // next retry attempt already lands on the healthy backend.
        const burnedIp = b.lastIp;
        b.quarantineUntil = Date.now() + QUARANTINE_SECS * 1000;
        event("quarantine", b.id, `excluded from RR for ${QUARANTINE_SECS}s (limit event)`);
        if (AUTO_RESET) {
          coordinatorReset(b.id, "api-limit", { untilDistinct: true }).then((r) => {
            if (r.code !== 200 && r.code !== 202) log(`[coordinator] background reset ${b.id}: ${r.code} ${r.msg}`);
          });
        }
        // Sibling on the SAME egress IP shares the burned quota bucket: it
        // would 429 on the very next request, so failing over to it is
        // useless. Quarantine + reset it too (staggered: this one is already
        // in flight, the sibling starts after a short delay).
        const twins = backends.filter((x) => x !== b && burnedIp && x.lastIp === burnedIp);
        for (const t of twins) {
          totals.shared_ip_quarantines += 1;
          t.quarantineUntil = Date.now() + QUARANTINE_SECS * 1000;
          event("quarantine", t.id, `shares burned IP ${burnedIp} with ${b.id} → also excluded for ${QUARANTINE_SECS}s`);
          if (AUTO_RESET) {
            setTimeout(() => {
              coordinatorReset(t.id, "shared-ip", { untilDistinct: true }).then((r) => {
                if (r.code !== 200 && r.code !== 202) log(`[coordinator] shared-ip reset ${t.id}: ${r.code} ${r.msg}`);
              });
            }, DISTINCT_RETRY_DELAY);
          }
        }
        return sendJson(res, 202, { ok: true, msg: `backend ${b.id} quarantined, reset started${twins.length ? ` (+${twins.map((t) => t.id).join(",")} same IP)` : ""}` });
      }
      const r = await coordinatorReset(b.id, "api", { untilDistinct: true });
      return sendJson(res, r.code, { ok: r.code === 200, msg: r.msg }, r.retryAfter ? { "Retry-After": String(r.retryAfter) } : {});
    });
    return;
  }
  return sendJson(res, 404, { error: "not found" });
});

/* ---------------- boot ---------------- */

const server = net.createServer(serveClient);
server.on("error", (e) => { console.error(`[pool] listen failed ${LISTEN.host}:${LISTEN.port}: ${e.message}`); process.exit(1); });
server.listen(LISTEN.port, LISTEN.host, () => {
  log(`SOCKS5 pool on ${LISTEN.host}:${LISTEN.port} → ${backends.map((b) => `${b.id}=${b.host}:${b.port}`).join(", ")}`);
  log(`direct-fallback ON (warp down → OS egress) | auto-reset ${AUTO_RESET ? "ON" : "OFF"}`);
  api.listen(STATUS_PORT, LISTEN.host, () => log(`status API on ${LISTEN.host}:${STATUS_PORT}`));
});
