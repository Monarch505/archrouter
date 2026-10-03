#!/usr/bin/env node
"use strict";
/*
 * archrouter.js — cross-OS launcher for monarch-router (Linux / Termux / Windows).
 *
 * Replaces the 369-line bash launcher: same subcommands, same defaults, same env
 * vars, so existing Linux/Termux deployments keep working (the bash `archrouter`
 * is now a thin shim into this file).
 *
 * What had to change for Windows:
 *   - process management: bash `setsid`/`nohup`/`kill -0` → spawn(detached) +
 *     process.kill(pid, 0) + `taskkill /T /F` fallback for stubborn children;
 *   - port checks: `ss` / `/dev/tcp` → net.connect probe (no external tool);
 *   - binary layout: `uname -m` dir → both legacy (x86_64/aarch64) and
 *     process.arch dir (x64/arm64), plus `.exe` on win32;
 *   - `tail -f` → poll the log file (Windows ships no tail);
 *   - `command -v` → manual PATH scan;
 *   - `$HOME` is unset on Windows → os.homedir() (store.js does the same).
 *
 * Env precedence (intentional change vs bash): values already set in the process
 * environment WIN over $BASE/.env. Bash re-assigned the file over the inherited
 * value, contradicting its own comment.
 *
 * Usage: archrouter start|stop|restart|status|logs [name]|update
 *        [--check|--no-restart|--force|--full]|rollback|key [name]|connect-opencode [--variants]|warp-setup [--force]
 *        |warp-reset [a|b]|doctor|version
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const { spawn, spawnSync, execFile } = require("child_process");

const PROG = "archrouter";
const VERSION = "0.3.0";
const IS_WIN = process.platform === "win32";

/* ---------------- base paths ---------------- */

const HOME_DIR = process.env.HOME || (() => { try { return os.homedir(); } catch { return null; } })();
const BASE = process.env.ARCHROUTER_HOME || (HOME_DIR ? path.join(HOME_DIR, ".archrouter") : process.cwd());
const DATA = path.join(BASE, "data");
const LOGS = path.join(DATA, "logs");
const WARP = path.join(BASE, "warp");
const BINBASE = path.join(BASE, "bin");

// Persisted env; existing process env wins (see header).
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile(path.join(BASE, ".env"));

const PLATFORM = IS_WIN
  ? "windows"
  : (process.env.PREFIX && process.env.PREFIX.includes("com.termux") ? "termux" : "linux");

/* ---------------- ports / env ---------------- */

const API_PORT = process.env.ARCHROUTER_PORT || "20399";
const API_HOST = process.env.ARCHROUTER_HOST || "127.0.0.1";
const POOL_SOCKS = process.env.ARCHROUTER_POOL_SOCKS || "11801";
const WARP_A_SOCKS = process.env.ARCHROUTER_WARP_A || "11810";
const WARP_B_SOCKS = process.env.ARCHROUTER_WARP_B || "11811";
const STATUS_PORT = process.env.ARCHROUTER_STATUS_PORT || "9190";
// Handshake stagger at start: two tunnels joining Cloudflare's pool in the same
// instant collide more often (see docs-internal/TASKS.md history). This lowers
// collisions — it is NOT the guarantee. The guarantee is the guard: park the
// duplicate and bounce until distinct, observable as invariant_ok. Tune with
// ARCHROUTER_STAGGER_MS=0 to disable.
const STAGGER_MS = Number(process.env.ARCHROUTER_STAGGER_MS ?? 8000);

const INSTANCES = [
  { id: "a", dir: "warp-a", port: WARP_A_SOCKS },
  { id: "b", dir: "warp-b", port: WARP_B_SOCKS },
];
const warpDirname = (id) => { const h = INSTANCES.find((x) => x.id === id || x.dir === id); return h ? h.dir : ""; };
const portOf = (dir) => { const h = INSTANCES.find((x) => x.dir === dir); return h ? h.port : ""; };

/* ---------------- binary resolution ---------------- */

// install.sh (older) wrote bin/<uname -m>/; install.js writes bin/<arch>/.
function archDirs() {
  const dirs = process.arch === "arm64" ? ["aarch64", "arm64"] : ["x86_64", "x64"];
  if (IS_WIN && !dirs.includes(process.arch)) dirs.push(process.arch);
  return [...new Set(dirs)];
}
function whichSync(name) {
  const exts = IS_WIN ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  const dirs = (process.env.PATH || "").split(IS_WIN ? ";" : ":").filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep scanning */ }
    }
  }
  return "";
}
function findBin(name) {
  const file = IS_WIN ? `${name}.exe` : name;
  for (const dir of archDirs()) {
    const p = path.join(BINBASE, dir, file);
    try {
      if (!fs.statSync(p).isFile()) continue;
      if (!IS_WIN) { try { fs.accessSync(p, fs.constants.X_OK); } catch { continue; } }
      return p;
    } catch { /* next candidate */ }
  }
  return whichSync(file);
}
const SINGBOX = findBin("sing-box");
const WGCF = findBin("wgcf");

/* ---------------- repo location ---------------- */

function resolveRepo() {
  const candidates = [__dirname];
  if (process.env.ARCHROUTER_REPO) candidates.push(process.env.ARCHROUTER_REPO);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "server", "server.js"))) return c;
  }
  return __dirname;
}
const REPO = resolveRepo();
const SERVER_JS = path.join(REPO, "server", "server.js");
const POOL_JS = path.join(REPO, "pool", "pool.js");
const GEN_SINDBOX_JS = path.join(REPO, "pool", "gen-singbox.js");

/* ---------------- helpers ---------------- */

const log = (...a) => console.log(`[${PROG}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(...a) { console.error(`[${PROG}] ERROR:`, ...a); process.exit(1); }

function portFree(port, host = "127.0.0.1", timeoutMs = 800) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (free) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(free); };
    const s = net.connect({ host, port: Number(port) });
    s.setTimeout(timeoutMs, () => finish(true));
    s.once("connect", () => finish(false));
    s.once("error", () => finish(true));
  });
}

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    try {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        let body = "";
        res.on("data", (c) => { if (body.length < 400000) body += c; });
        res.on("end", () => finish({ status: res.statusCode, body }));
      });
      req.on("error", () => finish(null));
      req.on("timeout", () => { try { req.destroy(); } catch {} finish(null); });
    } catch { finish(null); }
  });
}

// curl is present on Windows 10+, macOS, Termux and every supported Linux; it
// is the cheapest way to speak HTTP-over-SOCKS without hand-rolling TLS.
const CURL = IS_WIN ? "curl.exe" : "curl";
function curl(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(CURL, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
}
// Egress IP through one warp instance's SOCKS port. IP-literal target so no DNS
// is required (sing-box inside the tunnel has no usable resolver).
async function warpTrace(port) {
  const out = await curl(["-s", "-m", "15", "-x", `socks5://127.0.0.1:${port}`, "https://1.1.1.1/cdn-cgi/trace"]);
  if (!out) return null;
  const m = /^ip=(\S+)$/m.exec(out);
  return m ? m[1] : null;
}

function pidAlive(pid) {
  if (!pid) return false;
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
}
const readPid = (name) => { try { return fs.readFileSync(path.join(DATA, `${name}.pid`), "utf8").trim(); } catch { return ""; } };
function writePid(name, pid) {
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, `${name}.pid`), String(pid)); } catch { /* best effort */ }
}
function rmPid(name) { try { fs.unlinkSync(path.join(DATA, `${name}.pid`)); } catch { /* already gone */ } }

function openLog(name) {
  try { fs.mkdirSync(LOGS, { recursive: true }); } catch { /* best effort */ }
  return fs.openSync(path.join(LOGS, `${name}.log`), "a");
}

// Detached long-running child: survives our exit on POSIX (detached ≈ setsid)
// and on Windows (independent console).
function spawnDetached(cmd, args, logName) {
  const fd = openLog(logName);
  const child = spawn(cmd, args, { detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
  child.unref();
  return child.pid;
}

async function killTree(pid) {
  if (!pidAlive(pid)) return;
  try { process.kill(Number(pid), "SIGTERM"); } catch { /* already gone */ }
  for (let i = 0; i < 75 && pidAlive(pid); i++) await sleep(200);   // 15s grace
  if (!pidAlive(pid)) return;
  if (IS_WIN) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { process.kill(Number(pid), "SIGKILL"); } catch { /* ignore */ }
  }
}

/* ---------------- subcommands ---------------- */

function cmdVersion() {
  console.log(`${PROG} ${VERSION} (platform=${PLATFORM} base=${BASE} repo=${REPO})`);
}

async function cmdDoctor() {
  let ok = 0, fail = 0;
  const say = (good, msg) => { if (good) { ok++; console.log(`  [ok] ${msg}`); } else { fail++; console.log(`  [!!] ${msg}`); } };
  console.log(`== ${PROG} doctor (platform=${PLATFORM}) ==`);

  const major = Number((process.versions.node || "0").split(".")[0]);
  say(major >= 22, `node ${process.version} ${major >= 22 ? "(>=22, sqlite ready)" : "(<22 → JSON fallback, D6)"}`);
  say(fs.existsSync(SERVER_JS), `server.js present${fs.existsSync(SERVER_JS) ? "" : ` (${SERVER_JS})`}`);
  say(fs.existsSync(POOL_JS), `pool.js present${fs.existsSync(POOL_JS) ? "" : " (Fase 3)"}`);

  // Ports are only "free" before the stack starts. Once our own services hold
  // them that is the expected state, so check ownership instead of shouting.
  const portOwners = [
    [API_PORT, "router"], [POOL_SOCKS, "pool"],
    [WARP_A_SOCKS, "warp-a"], [WARP_B_SOCKS, "warp-b"],
    [STATUS_PORT, "pool"],
  ];
  for (const [p, owner] of portOwners) {
    const free = await portFree(p);
    if (free) { say(true, `port ${p} free`); continue; }
    if (pidAlive(readPid(owner))) say(true, `port ${p} in use by ${owner} (expected)`);
    else say(false, `port ${p} in use by another process (owner ${owner} not running)`);
  }

  say(!!SINGBOX, `bin sing-box (${SINGBOX || "missing — run install"})`);
  say(!!WGCF, `bin wgcf (${WGCF || "missing — run install"})`);

  for (const inst of INSTANCES) {
    const acc = path.join(WARP, inst.dir, "wgcf-account.toml");
    say(fs.existsSync(acc), `${inst.dir} account${fs.existsSync(acc) ? "" : " (run archrouter warp-setup)"}`);
  }

  const health = await httpGet(`http://${API_HOST}:${API_PORT}/health`, 3000);
  say(!!health, `router :${API_PORT}/health ${health ? `→ ${health.status}` : "no response (stack down?)"}`);

  const poolSt = await httpGet(`http://127.0.0.1:${STATUS_PORT}/`, 3000);
  if (poolSt) {
    try {
      const j = JSON.parse(poolSt.body);
      const ips = (j.instances || []).map((x) => `${x.id}=${x.public_ip}`).join(" ");
      console.log(`  [--] pool: ${ips} conflict=${j.ip_conflict} parked=[${(j.parked || []).join(",")}]`);
      if (j.invariant_ok === true) say(true, `invariant_ok=true (distinct egress IPs: ${(j.serving_ips || []).join(", ")})`);
      else if (j.invariant_ok === null) console.log("  [--] invariant_ok=null (no IP known yet — pool still probing)");
      else say(false, "invariant_ok=FALSE — two accounts share one egress IP in rotation");
    } catch { say(false, "pool status unparseable"); }
  } else {
    console.log("  [--] pool not running — skipped invariant + warp trace");
  }

  // WARP preflight: the only honest proof is a live trace through a tunnel (a
  // bare UDP send proves nothing — WireGuard ignores non-handshake packets).
  const up = INSTANCES.find((i) => pidAlive(readPid(i.dir)));
  if (up) {
    const t = await warpTrace(up.port);
    say(!!t && /^104\./.test(t), `warp ${up.dir} egress=${t || "no answer"}`);
  } else {
    console.log("  [--] warp trace skipped (no instance running)");
  }

  const models = await curl(["-s", "-o", IS_WIN ? "NUL" : "/dev/null", "-m", "8", "https://opencode.ai/zen/v1/models"]);
  say(models !== null, "upstream opencode.ai reachable");

  const authLine = authStatus();
  const modeTxt = authLine.mode && authLine.mode !== "auto" ? ` [mode=${authLine.mode}]` : "";
  if (authLine.source && !["auto", "config"].includes(authLine.source)) modeTxt += ` [forced by ${authLine.source}]`;
  if (authLine.requireAuth) {
    say(authLine.enabledKeys > 0, `auth: required${modeTxt}, ${authLine.enabledKeys}/${authLine.activeKeys} key(s) enabled${authLine.staticKey ? " + ARCHROUTER_KEY" : ""}`);
  } else if (authLine.activeKeys > 0) {
    say(true, `auth: open by choice${modeTxt} — ${authLine.activeKeys} key(s) exist but none are enabled`);
  } else {
    console.log(`  [--] auth: OPEN${modeTxt} — no credential exists yet; create one in the dashboard (POST /api/keys)`);
  }

  console.log(`== result: ${ok} ok, ${fail} problem(s) ==`);
  process.exit(fail === 0 ? 0 : 1);
}

// Reads the same store the server uses, so the numbers cannot drift apart.
function authStatus() {
  const out = { requireAuth: false, mode: "auto", source: "", activeKeys: 0, enabledKeys: 0, staticKey: !!process.env.ARCHROUTER_KEY };
  try {
    const store = require(path.join(REPO, "server", "lib", "store.js"));
    const configStore = require(path.join(REPO, "server", "lib", "configStore.js"));
    const auth = require(path.join(REPO, "server", "lib", "auth.js"));
    out.activeKeys = store.countActiveApiKeys();
    out.enabledKeys = store.countEnabledApiKeys();
    out.mode = auth.normalizeMode(configStore.get().auth?.requireAuthMode);
    const state = auth.resolveAuthRequired({
      mode: out.mode,
      envFlag: process.env.ARCHROUTER_REQUIRE_AUTH,
      staticKey: process.env.ARCHROUTER_KEY || "",
      activeKeys: out.enabledKeys,
    });
    out.requireAuth = state.required;
    out.source = state.source;
  } catch (e) {
    out.source = "unknown";
  }
  return out;
}

async function cmdStart() {
  const mode = process.env.ARCHROUTER_MODE || "none";
  const wantWarp = mode === "warp";
  const approx = wantWarp ? `~${Math.round((STAGGER_MS * INSTANCES.length) / 1000) + 8}s (${STAGGER_MS}ms stagger + pool + router)` : "~3s (router only)";
  log(`starting stack — ${approx}, output below is progress, not a hang`);
  fs.mkdirSync(LOGS, { recursive: true });
  if (!fs.existsSync(SERVER_JS)) die(`server.js missing (${SERVER_JS})`);
  if (wantWarp) {
    for (const inst of INSTANCES) {
      if (!fs.existsSync(path.join(WARP, inst.dir, "sing-box.json"))) die(`mode=warp but ${inst.dir} config missing — run: ${PROG} warp-setup`);
    }
    if (!SINGBOX) die("sing-box not found (run install)");
    if (!fs.existsSync(POOL_JS)) die(`pool.js missing (${POOL_JS})`);
  }

  if (!(await portFree(API_PORT))) die(`port ${API_PORT} in use — stop dulu atau set ARCHROUTER_PORT`);
  if (wantWarp) {
    for (const p of [POOL_SOCKS, WARP_A_SOCKS, WARP_B_SOCKS, STATUS_PORT]) {
      if (!(await portFree(p))) die(`port ${p} in use — stop dulu (${PROG} stop)`);
    }
    for (const [idx, inst] of INSTANCES.entries()) {
      if (idx > 0 && STAGGER_MS > 0) { log(`stagger ${STAGGER_MS}ms before ${inst.dir} ...`); await sleep(STAGGER_MS); }
      await startSingbox(inst.dir, inst.port);
    }
    await startPool();
  }

  const old = readPid("router");
  if (pidAlive(old)) { log(`router already running (pid ${old})`); return; }
  log(`starting router :${API_PORT} (mode=${mode}) ...`);
  const extra = (process.env.ARCHROUTER_EXTRA_ARGS || "").trim().split(/\s+/).filter(Boolean);
  const pid = spawnDetached(process.execPath, [SERVER_JS, "--port", API_PORT, "--host", API_HOST, "--mode", mode, ...extra], "router");
  writePid("router", pid);
  await sleep(1200);
  pidAlive(readPid("router")) ? log(`router pid ${pid}`) : die(`router failed to start — see ${path.join(LOGS, "router.log")}`);
}

async function startSingbox(dir, port) {
  const old = readPid(dir);
  if (pidAlive(old)) { log(`${dir} already running (pid ${old})`); return; }
  log(`starting ${dir} :${port} ...`);
  const pid = spawnDetached(SINGBOX, ["run", "-c", path.join(WARP, dir, "sing-box.json")], dir);
  writePid(dir, pid);
  await sleep(1200);
  pidAlive(readPid(dir)) ? log(`${dir} pid ${pid}`) : die(`${dir} failed to start — see ${path.join(LOGS, `${dir}.log`)}`);
}

async function startPool() {
  const old = readPid("pool");
  if (pidAlive(old)) { log(`pool already running (pid ${old})`); return; }
  log(`starting pool :${POOL_SOCKS} (backends a=:${WARP_A_SOCKS} b=:${WARP_B_SOCKS}) ...`);
  // The pool's reset hook calls back into THIS launcher. pool.js runs the hook
  // through a shell, so quote every path (Windows paths contain spaces).
  const self = `"${process.execPath}" "${path.join(REPO, "archrouter.js")}" warp-reset %ID%`;
  const args = [
    POOL_JS,
    "--listen", `127.0.0.1:${POOL_SOCKS}`,
    "--status-port", STATUS_PORT,
    "--backend", `a=127.0.0.1:${WARP_A_SOCKS}`,
    "--backend", `b=127.0.0.1:${WARP_B_SOCKS}`,
    "--reset-hook", self,
    "--auto-reset", process.env.ARCHROUTER_AUTO_RESET || "1",
    "--quarantine-secs", process.env.ARCHROUTER_QUARANTINE_SECS || "300",
  ];
  if (process.env.ARCHROUTER_HEALTH_URL) args.push("--health-url", process.env.ARCHROUTER_HEALTH_URL);
  if (process.env.ARCHROUTER_SAME_IP_GUARD) args.push("--same-ip-guard", process.env.ARCHROUTER_SAME_IP_GUARD);
  if (process.env.ARCHROUTER_DISTINCT_RETRIES) args.push("--distinct-retries", process.env.ARCHROUTER_DISTINCT_RETRIES);
  if (process.env.ARCHROUTER_DISTINCT_RETRY_DELAY) args.push("--distinct-retry-delay", process.env.ARCHROUTER_DISTINCT_RETRY_DELAY);
  const pid = spawnDetached(process.execPath, args, "pool");
  writePid("pool", pid);
  await sleep(1200);
  pidAlive(readPid("pool")) ? log(`pool pid ${pid}`) : die(`pool failed to start — see ${path.join(LOGS, "pool.log")}`);
}

async function cmdStop() {
  let stopped = 0;
  for (const name of ["router", "pool", ...INSTANCES.map((i) => i.dir)]) {
    const pid = readPid(name);
    if (pidAlive(pid)) { await killTree(pid); stopped++; log(`stopped ${name} (pid ${pid})`); }
    rmPid(name);
  }
  if (!stopped) log("nothing running");
}

async function cmdStatus() {
  for (const name of ["router", "pool", ...INSTANCES.map((i) => i.dir)]) {
    const pid = readPid(name);
    console.log(pidAlive(pid) ? `  ${name}: RUNNING (pid ${pid})` : `  ${name}: stopped`);
  }
  const poolSt = await httpGet(`http://127.0.0.1:${STATUS_PORT}/`, 2500);
  if (poolSt) {
    try {
      const j = JSON.parse(poolSt.body);
      console.log(`  pool: ${(j.instances || []).map((x) => `${x.id}=${x.public_ip}`).join(" ")}`);
      console.log(`  invariant_ok=${j.invariant_ok} serving_ips=[${(j.serving_ips || []).join(",")}] parked=[${(j.parked || []).join(",")}]`);
    } catch { /* ignore */ }
  }
  const health = await httpGet(`http://${API_HOST}:${API_PORT}/health`, 2500);
  console.log(health ? `  api :${API_PORT} → ${health.status} ${health.body.slice(0, 120)}` : `  api :${API_PORT} no response`);
}

// Creates and prints a key. Existing keys cannot be reprinted (only their
// SHA-256 is stored), so this always mints a new one.
function cmdKey(nameArg) {
  let store, authLib;
  try {
    store = require(path.join(REPO, "server", "lib", "store.js"));
    authLib = require(path.join(REPO, "server", "lib", "auth.js"));
  } catch (e) {
    die(`cannot open the key store (${e.message}) — node >= 22 required for node:sqlite`);
  }
  const name = (nameArg || "").trim() || `key-${new Date().toISOString().slice(0, 10)}`;
  const key = authLib.newKey();
  store.insertApiKey({ id: authLib.keyId(), name, keyHash: authLib.sha256hex(key), prefix: authLib.displayPrefix(key) });
  log(`created key '${name}' — copy it now, it is not recoverable:`);
  console.log(`\n  ${key}\n`);
  log(`${store.countActiveApiKeys()} active key(s). The router requires a key on its next start.`);
}

// Points opencode at this router. Default writes npm + baseURL only, which is
// enough for opencode to read the catalog from /v1/models itself; --variants
// additionally writes the static list with per-model effort levels. Needs no
// running router in the default mode.
function cmdConnectOpencode(flags) {
  let variants = false;
  for (const f of flags) {
    if (f === "--variants") variants = true;
    else die(`usage: ${PROG} connect-opencode [--variants]`);
  }
  const oc = require(path.join(REPO, "server", "lib", "opencodeConfig.js"));
  const modelIds = [];
  if (variants) {
    const list = httpGetSync(`http://${API_HOST}:${API_PORT}/v1/models`);
    const data = list?.data || [];
    for (const m of data) modelIds.push(m.id);
    if (!modelIds.length) die(`router not answering on :${API_PORT} — start it first, or drop --variants`);
  }
  const fragment = oc.buildFragment({ host: API_HOST, port: API_PORT, modelIds, includeModels: variants });
  const result = oc.writeConfig(fragment);
  if (!result.ok) die(result.error);
  log(`opencode provider written to ${result.file} (${result.mode})`);
  if (result.backup) log(`backup: ${result.backup}`);
  if (variants) log(`${result.models} models with effort levels.`);
  else log("opencode now reads the model list from /v1/models, so new free models appear on their own.");
  log("in opencode: /connect -> Other -> archrouter -> paste your key (see `archrouter key`).");
}

function httpGetSync(url) {
  try {
    const r = spawnSync(process.execPath, ["-e", `
      const u = ${JSON.stringify(url)};
      fetch(u).then(r => r.json()).then(j => { process.stdout.write(JSON.stringify(j)); })
        .catch(() => process.exit(1));
    `], { encoding: "utf8", timeout: 20000 });
    if (r.status !== 0) return null;
    return JSON.parse(r.stdout || "null");
  } catch {
    return null;
  }
}

function cmdLogs(name) {
  const target = name || "router";
  const file = path.join(LOGS, `${target}.log`);
  if (!fs.existsSync(file)) die(`no log ${file}`);
  let pos = Math.max(0, fs.statSync(file).size - 16000);
  const pump = () => {
    try {
      const size = fs.statSync(file).size;
      if (size < pos) pos = size; // rotated/truncated
      if (size <= pos) return;
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      pos = size;
      process.stdout.write(buf.toString("utf8"));
    } catch { /* keep following */ }
  };
  pump();
  const timer = setInterval(pump, 1000);
  process.on("SIGINT", () => { clearInterval(timer); process.exit(0); });
}

function git(args, opts = {}) {
  const r = spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", ...opts });
  if (r.error) die(`git not available (${r.error.message})`);
  return r;
}
const repoHead = () => { const r = git(["rev-parse", "HEAD"]); return r.status === 0 ? r.stdout.trim() : ""; };

async function cmdUpdate(flags) {
  let check = false, noRestart = false, force = false, full = false;
  for (const f of flags) {
    if (f === "--check") check = true;
    else if (f === "--no-restart") noRestart = true;
    else if (f === "--force") force = true;
    else if (f === "--full") full = true;
    else die(`usage: ${PROG} update [--check|--no-restart|--force|--full]`);
  }
  if (!fs.existsSync(path.join(REPO, ".git"))) die(`not a git clone (${REPO}) — update needs origin`);
  log("fetching origin ...");
  if (git(["fetch", "origin"]).status !== 0) die("fetch failed (network?) — nothing changed");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() || "main";
  let remote = `origin/${branch}`;
  if (git(["rev-parse", "--verify", remote], { stdio: "ignore" }).status !== 0) remote = "origin/main";
  if (git(["rev-parse", "--verify", remote], { stdio: "ignore" }).status !== 0) die(`no remote branch (${remote}) — nothing changed`);
  const before = repoHead();
  const after = git(["rev-parse", remote]).stdout.trim();
  if (before === after) { log(`already up to date (${before})`); return; }
  if (check) {
    log(`update available: ${before} → ${after}`);
    console.log(git(["log", "--oneline", `${before}..${after}`]).stdout.split("\n").slice(0, 20).join("\n"));
    return;
  }
  if (git(["status", "--porcelain"]).stdout.trim() && !force) {
    die("repo has local modifications — commit/stash or re-run with --force (local changes will be lost)");
  }
  rememberPrev(before);
  if (!noRestart) { await cmdStop(); await sleep(1000); }
  if (git(["reset", "--hard", after]).status !== 0) die("reset failed");
  if (full) {
    log("full: re-running install.js ...");
    const r = spawnSync(process.execPath, [path.join(REPO, "install.js")], { stdio: "inherit" });
    if (r.status !== 0) die(`install failed — rollback with: ${PROG} rollback`);
  }
  if (!noRestart) {
    await cmdStart();
    await sleep(2500);
    const h = await httpGet(`http://${API_HOST}:${API_PORT}/health`, 4000);
    if (!h) die(`router /health failed after update — rollback with: ${PROG} rollback`);
    log(`update done: ${before} → ${after} (prev saved, rollback available)`);
  } else {
    log(`update done (no restart): ${before} → ${after}`);
  }
}

// Records the commit we are leaving, so `rollback` has a target. Called after
// the reset, because the repo must not be left mid-operation.
function rememberPrev(commit) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, "update.prev"), commit);
  } catch (e) {
    log(`could not record previous version: ${e.message}`);
  }
}

async function cmdRollback() {
  const prevFile = path.join(DATA, "update.prev");
  const prev = fs.existsSync(prevFile) ? fs.readFileSync(prevFile, "utf8").trim() : "";
  if (!prev) die("no previous version recorded (no update run yet?)");
  if (git(["rev-parse", "--verify", prev], { stdio: "ignore" }).status !== 0) die(`previous commit ${prev} not found locally`);
  const cur = repoHead();
  if (prev === cur) die(`already on ${cur.slice(0, 7)} — nothing to roll back to`);
  fs.writeFileSync(prevFile, cur);
  await cmdStop(); await sleep(1000);
  if (git(["reset", "--hard", prev]).status !== 0) die("reset failed");
  await cmdStart();
  await sleep(2500);
  const h = await httpGet(`http://${API_HOST}:${API_PORT}/health`, 4000);
  if (!h) die("router /health failed after rollback");
  log(`rollback done: ${cur} → ${prev}`);
}

function cmdWarpSetup(flags) {
  const force = flags.includes("--force");
  if (!WGCF) die("wgcf not found (run install)");
  fs.mkdirSync(WARP, { recursive: true });
  for (const inst of INSTANCES) {
    const d = path.join(WARP, inst.dir);
    fs.mkdirSync(d, { recursive: true });
    const acc = path.join(d, "wgcf-account.toml");
    if (fs.existsSync(acc) && !force) {
      log(`${inst.dir}: account exists, keeping (use --force to re-register)`);
    } else {
      if (force) {
        try { fs.unlinkSync(acc); } catch { /* none */ }
        try { fs.unlinkSync(path.join(d, "wgcf-profile.conf")); } catch { /* none */ }
      }
      log(`${inst.dir}: registering new WARP device ...`);
      // Back-to-back device registrations can trip Cloudflare rate limits
      // ("User was rejected"), so space the two registrations out.
      if (spawnSync(WGCF, ["register", "--accept-tos"], { cwd: d, stdio: "inherit" }).status !== 0) die(`${inst.dir}: wgcf register failed`);
      if (spawnSync(WGCF, ["generate"], { cwd: d, stdio: "inherit" }).status !== 0) die(`${inst.dir}: wgcf generate failed`);
      sleepSync(8000);
    }
    if (spawnSync(process.execPath, [GEN_SINDBOX_JS, d, inst.port], { stdio: "inherit" }).status !== 0) die(`${inst.dir}: gen-singbox failed`);
    if (!SINGBOX) die("sing-box not found (run install)");
    if (spawnSync(SINGBOX, ["check", "-c", path.join(d, "sing-box.json")], { stdio: "inherit" }).status !== 0) die(`${inst.dir}: sing-box check failed`);
  }
  log("warp-setup done (configs validated)");
}

function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no-op */ } }

async function cmdWarpReset(idArg) {
  const dir = warpDirname(idArg || "a");
  if (!dir) die(`usage: ${PROG} warp-reset [a|b]`);
  if (!SINGBOX) die("sing-box not found (run install)");
  const cfg = path.join(WARP, dir, "sing-box.json");
  if (!fs.existsSync(cfg)) die(`${dir} config missing — run: ${PROG} warp-setup`);
  const old = readPid(dir);
  if (pidAlive(old)) { await killTree(old); rmPid(dir); log(`${dir} stopped (pid ${old})`); }
  else log(`${dir} not running (starting fresh)`);
  await startSingbox(dir, portOf(dir));
  log(`${dir} reset done`);
}

/* ---------------- dispatch ---------------- */

const HELP = `Usage: ${PROG} start|stop|restart|status|logs [name]|update [--check|--no-restart|--force|--full]|rollback|key [name]|connect-opencode [--variants]|warp-setup [--force]|warp-reset [a|b]|doctor|version`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case undefined: case "help": case "-h": case "--help": console.log(HELP); break;
    case "version": cmdVersion(); break;
    case "doctor": await cmdDoctor(); break;
    case "start": await cmdStart(); break;
    case "stop": await cmdStop(); break;
    case "restart": await cmdStop(); await sleep(1000); await cmdStart(); break;
    case "status": await cmdStatus(); break;
    case "logs": cmdLogs(rest[0]); break;
    case "update": await cmdUpdate(rest); break;
    case "rollback": await cmdRollback(); break;
    case "key": cmdKey(rest[0]); break;
    case "connect-opencode": cmdConnectOpencode(rest); break;
    case "warp-setup": cmdWarpSetup(rest); break;
    case "warp-reset": await cmdWarpReset(rest[0]); break;
    default: die(`unknown command '${cmd}' (try: ${PROG} help)`);
  }
}

main().catch((e) => die(e && e.message ? e.message : String(e)));