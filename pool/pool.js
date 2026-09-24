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
const { spawn } = require("child_process");

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
    const sock = net.connect(proxyPort, proxyHost);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("socks5 dial timeout")); }, timeoutMs);
    const done = (err, s) => { clearTimeout(timer); err ? (sock.destroy(), reject(err)) : resolve(s); };
    sock.once("error", (e) => done(e));
    sock.once("connect", () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00])); // no-auth
      let stage = 0, buf = Buffer.alloc(0);
      sock.on("data", (c) => {
        buf = Buffer.concat([buf, c]);
        if (stage === 0 && buf.length >= 2) {
          if (buf[0] !== 0x05 || buf[1] !== 0x00) return done(new Error("socks5 auth rejected"));
          stage = 1; buf = Buffer.alloc(0);
          const host = Buffer.from(dstHost, "utf8");
          const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host,
            Buffer.from([(dstPort >> 8) & 0xff, dstPort & 0xff])]);
          sock.write(req);
        } else if (stage === 1 && buf.length >= 10) {
          if (buf[1] !== 0x00) return done(Object.assign(new Error(`socks5 connect failed rep=${buf[1]}`), { rep: buf[1] }));
          sock.removeAllListeners("data");
          done(null, sock);
        }
      });
    });
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

const backendDefs = args.backends.length ? args.backends : ["a=127.0.0.1:11810", "b=127.0.0.1:11811"];
const backends = backendDefs.map((d) => {
  const eq = d.indexOf("=");
  const id = d.slice(0, eq);
  const hp = splitHostPort(d.slice(eq + 1), 1080);
  return { id, host: hp.host, port: hp.port, consecFails: 0, lastOk: 0, lastIp: null, lastReset: 0, rr: true };
});

const totals = { total_resets: 0, success_count: 0, same_ip_count: 0, direct_fallback: 0 };
const events = [];
function event(type, instance, msg) {
  events.push({ time: new Date().toISOString(), type, instance, msg });
  if (events.length > 50) events.shift();
  log(`[${type}] inst=${instance} ${msg}`);
}

let rrIndex = 0;
function pickBackend() {
  const healthy = backends.filter((b) => b.consecFails < HEALTH_FAIL_THR);
  const pool = healthy.length ? healthy : backends;
  const b = pool[rrIndex % pool.length];
  rrIndex += 1;
  return b;
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
      if (/^[\d.]+$/.test(r.body)) b.lastIp = r.body;
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

let resetting = false;
let lastResetAt = 0;

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

async function verifyBackend(b) {
  const ipBefore = b.lastIp;
  const deadline = Date.now() + Math.max(VERIFY_TIMEOUT * 6, 30000);
  while (Date.now() < deadline) {
    if (await probeBackend(b)) {
      const same = ipBefore && b.lastIp && ipBefore === b.lastIp;
      return { ok: true, sameIp: !!same, ip: b.lastIp };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false };
}

async function coordinatorReset(id, source) {
  const b = backends.find((x) => x.id === id);
  if (!b) return { code: 404, msg: `unknown instance ${id}` };
  if (!AUTO_RESET) return { code: 503, msg: "auto-reset disabled (direct-fallback active)" };
  if (resetting) return { code: 409, msg: "reset already in progress" };
  const gap = Date.now() - lastResetAt;
  if (gap < MIN_RESET_GAP) return { code: 429, msg: `cooldown ${(MIN_RESET_GAP - gap) / 1000}s remaining`, retryAfter: Math.ceil((MIN_RESET_GAP - gap) / 1000) };
  resetting = true;
  event("reset", id, `START source=${source} currentIP=${b.lastIp}`);
  try {
    const hook = await runHook(id);
    if (!hook.ok) {
      event("error", id, `hook failed: ${hook.msg}`);
      return { code: 502, msg: hook.msg };
    }
    const v = await verifyBackend(b);
    totals.total_resets += 1;
    lastResetAt = Date.now();
    b.lastReset = lastResetAt;
    if (v.ok) {
      totals.success_count += 1;
      if (v.sameIp) totals.same_ip_count += 1;
      event("reset", id, `DONE source=${source} → IP: ${v.ip}${v.sameIp ? " (same)" : ""}`);
      return { code: 200, msg: `reset done → ${v.ip}` };
    }
    event("error", id, "verify FAILED after reset");
    return { code: 502, msg: "verify failed after reset" };
  } finally {
    resetting = false;
  }
}

/* map a report event to the most-likely backend: explicit id wins,
// else highest fail count, tie → least recently reset. */
function mapEventToBackend(explicitId) {
  if (explicitId) return backends.find((b) => b.id === explicitId) || null;
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
      instances: backends.map((b) => ({ id: b.id, running: Date.now() - b.lastOk < 2 * HEALTH_INTERVAL, public_ip: b.lastIp, consecFails: b.consecFails, lastReset: b.lastReset ? new Date(b.lastReset).toISOString() : null })),
      smart_reset: { ...totals, success_rate: totals.total_resets ? `${Math.round((100 * totals.success_count) / totals.total_resets)}%` : "n/a" },
      resetting, events,
    });
  }
  if (u.pathname === "/api/report" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch {}
      const b = mapEventToBackend(body.instance);
      if (!b) return sendJson(res, 400, { error: "no backend" });
      event("report", b.id, `api event=${body.event || "?"}`);
      const r = await coordinatorReset(b.id, "api");
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
