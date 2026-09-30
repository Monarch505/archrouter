#!/usr/bin/env node
"use strict";
/*
 * install.js — cross-platform installer for archrouter (Linux / Termux / Windows).
 *
 * Replaces install.sh (which was bash-only and died on any non-x86_64/aarch64
 * unix, and had no Windows path at all). Same job, one codebase:
 *   1. detect platform + arch
 *   2. make sure Node >= 22 is available (the only hard runtime requirement)
 *   3. fetch wgcf + sing-box (NATIVE binaries — no Docker anywhere)
 *   4. create <base>/{data,warp/warp-a,warp/b}, write <base>/.env
 *   5. put `archrouter` on the user's PATH (symlink on unix, .cmd on Windows)
 *   6. --unattended: warp-setup + start + verify
 *
 * No autostart / service installation: you start it with `archrouter start`.
 *
 * Flags: --unattended  full deploy (warp-setup + start + verify)
 *        --skip-bins   don't download binaries
 *        --reinstall-bins  force re-download
 *        --offline     skip OS packages AND downloads
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { spawnSync } = require("child_process");

const PROG = "install";
const WGCF_VER = process.env.WGCF_VER || "2.3.0";
const SINGBOX_VER = process.env.SINGBOX_VER || "1.14.1";

const IS_WIN = process.platform === "win32";
const IS_TERMUX = !IS_WIN && !!(process.env.PREFIX && process.env.PREFIX.includes("com.termux"));

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const SKIP_BINS = has("--skip-bins");
const REINSTALL = has("--reinstall-bins");
const OFFLINE = has("--offline");
const UNATTENDED = has("--unattended");
if (has("--offline") && UNATTENDED) { console.error("[install] ERROR: --unattended + --offline conflict"); process.exit(1); }

const HOME_DIR = process.env.HOME || (() => { try { return os.homedir(); } catch { return null; } })();
const BASE = process.env.ARCHROUTER_HOME || (HOME_DIR ? path.join(HOME_DIR, ".archrouter") : process.cwd());
const DATA = path.join(BASE, "data");
const LOGS = path.join(DATA, "logs");
const WARP = path.join(BASE, "warp");
const REPO = __dirname;
const ARCH_DIR = process.arch === "arm64" ? "aarch64" : "x86_64";   // legacy name; archrouter.js also checks x64/arm64
const WIN_ARCH_DIR = process.arch === "arm64" ? "arm64" : "x64";
const BINBASE = path.join(BASE, "bin");

const ok = (m) => console.log(`  [ok] ${m}`);
const bad = (m) => { console.log(`  [!!] ${m}`); failures++; };
const info = (m) => console.log(`  [--] ${m}`);
const step = (m) => console.log(`\n== ${m} ==`);
let failures = 0;
const die = (m) => { console.error(`[install] ERROR: ${m}`); process.exit(1); };

/* ---------------- platform ---------------- */

function platform() {
  if (IS_WIN) return "windows";
  if (IS_TERMUX) return "termux";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}
const PLAT = platform();

// wgcf ships no android asset (linux static build works); sing-box has one.
function wgcfAsset() {
  const a = process.arch === "arm64" ? "arm64" : "amd64";
  switch (PLAT) {
    case "windows": return `windows_${a}.exe`;
    case "darwin": return `darwin_${a}`;
    case "termux": return process.arch === "arm64" ? "linux_arm64" : "linux_amd64";
    default: return process.arch === "arm64" ? "linux_arm64" : "linux_amd64";
  }
}
function singboxAsset() {
  const a = process.arch === "arm64" ? "arm64" : "amd64";
  switch (PLAT) {
    case "windows": return `sing-box-${SINGBOX_VER}-windows-${a}.zip`;
    case "darwin": return `sing-box-${SINGBOX_VER}-darwin-${a}.tar.gz`;
    case "termux": return process.arch === "arm64"
      ? `sing-box-${SINGBOX_VER}-android-arm64.tar.gz`
      : `sing-box-${SINGBOX_VER}-linux-${a}.tar.gz`;
    default: return `sing-box-${SINGBOX_VER}-linux-${a}.tar.gz`;
  }
}

/* ---------------- tiny https downloader ---------------- */

function download(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "archrouter-installer" } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(res.headers.location, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${url}`)); }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.setTimeout(180000, () => { req.destroy(new Error(`timeout ${url}`)); });
    req.on("error", reject);
  });
}
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/* ---------------- OS packages ---------------- */

function have(cmd) {
  const r = spawnSync(IS_WIN ? "where" : "which", [cmd], { stdio: "ignore" });
  return r.status === 0;
}
function osPackages() {
  step("OS packages");
  if (OFFLINE) { info("--offline: skipped"); return; }
  if (IS_WIN) {
    // curl.exe + tar.exe ship with Windows 10+; winget only as a fallback path.
    have("curl") ? ok("curl available") : bad("curl not found — install 'curl' (Windows 10+ has curl.exe)");
    have("tar") ? ok("tar available") : bad("tar not found — needed to unpack sing-box.zip");
    return;
  }
  const sudo = process.getuid && process.getuid() !== 0 && have("sudo") ? "sudo " : "";
  if (IS_TERMUX) {
    const r = spawnSync("pkg", ["install", "-y", "curl", "ca-certificates", "tar", "xz"], { stdio: "inherit" });
    r.status === 0 ? ok("pkg install curl ca-certificates tar xz") : bad("pkg install failed");
    return;
  }
  if (have("apt-get")) {
    const r = spawnSync("sh", ["-c", `${sudo}apt-get install -y -qq curl ca-certificates tar xz-utils git`], { stdio: "inherit" });
    r.status === 0 ? ok("apt-get install curl ca-certificates tar xz-utils git") : bad("apt-get install failed");
  } else if (have("apk")) {
    const r = spawnSync("sh", ["-c", `${sudo}apk add --no-cache curl ca-certificates tar xz git`], { stdio: "inherit" });
    r.status === 0 ? ok("apk add curl ca-certificates tar xz git") : bad("apk add failed");
  } else if (have("dnf")) {
    const r = spawnSync("sh", ["-c", `${sudo}dnf install -y curl ca-certificates tar xz git`], { stdio: "inherit" });
    r.status === 0 ? ok("dnf install curl ca-certificates tar xz git") : bad("dnf install failed");
  } else if (have("pacman")) {
    const r = spawnSync("sh", ["-c", `${sudo}pacman -Sy --noconfirm curl ca-certificates tar xz git`], { stdio: "inherit" });
    r.status === 0 ? ok("pacman install curl ca-certificates tar xz git") : bad("pacman install failed");
  } else {
    have("curl") && have("tar") ? ok("curl + tar present (no package manager needed)") : bad("curl and/or tar missing");
  }
}

/* ---------------- node ---------------- */

function nodeMajor() {
  try { return Number(process.versions.node.split(".")[0]); } catch { return 0; }
}
function checkNode() {
  step("Node.js runtime");
  const major = nodeMajor();
  if (major >= 22) { ok(`node ${process.version} (>=22)`); return; }
  if (IS_TERMUX) {
    info(`node ${process.version} < 22 — try: pkg install nodejs`);
    bad("node >= 22 required (node:sqlite)");
    return;
  }
  if (IS_WIN && have("winget")) info("winget available: winget install OpenJS.NodeJS.LTS");
  if (PLAT === "darwin" && have("brew")) info("brew available: brew install node@22");
  bad(`node ${process.version} < 22 — install Node 22+ then re-run`);
}

/* ---------------- binaries ---------------- */

function extract(archive, destDir, what) {
  fs.mkdirSync(destDir, { recursive: true });
  const flags = archive.endsWith(".gz") ? ["-xzf", archive, "-C", destDir] : ["-xf", archive, "-C", destDir];
  let r = spawnSync("tar", flags, { stdio: "inherit" });
  if (r.error || r.status !== 0) {
    // bsdtar (Windows) auto-detects; GNU tar needs explicit flags. Retry the
    // other way round before giving up.
    r = spawnSync("tar", ["-xf", archive, "-C", destDir], { stdio: "inherit" });
  }
  if (r.error || r.status !== 0) die(`${what}: cannot unpack ${archive} (needs tar)`);
}

function findFile(dir, name) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === name.toLowerCase()) return p;
    }
  }
  return "";
}

async function installBins() {
  step("binaries (wgcf + sing-box, native — no Docker)");
  const bindir = path.join(BINBASE, IS_WIN ? WIN_ARCH_DIR : ARCH_DIR);
  fs.mkdirSync(bindir, { recursive: true });
  if (SKIP_BINS) { info("--skip-bins"); return; }

  // wgcf
  const wgcfTarget = path.join(bindir, IS_WIN ? "wgcf.exe" : "wgcf");
  if (fs.existsSync(wgcfTarget) && !REINSTALL) ok(`bin wgcf (cached)`);
  else {
    const url = `https://github.com/ViRb3/wgcf/releases/download/v${WGCF_VER}/wgcf_${WGCF_VER}_${wgcfAsset()}`;
    info(`downloading wgcf v${WGCF_VER} (${wgcfAsset()}) ...`);
    const buf = await download(url);
    if (buf.length < 3_000_000) die(`wgcf download too small (${buf.length} B) — bad release asset`);
    fs.writeFileSync(wgcfTarget, buf);
    ok(`wgcf v${WGCF_VER} → ${wgcfTarget} (sha256 ${sha256(buf).slice(0, 16)}…)`);
  }
  if (!IS_WIN) { try { fs.chmodSync(wgcfTarget, 0o755); } catch { /* best effort */ } }
  const wr = spawnSync(wgcfTarget, ["--help"], { stdio: "ignore" });
  wr.status === 0 ? ok("wgcf runs on this arch") : bad("wgcf failed to run (wrong arch?)");

  // sing-box
  const sbTarget = path.join(bindir, IS_WIN ? "sing-box.exe" : "sing-box");
  if (fs.existsSync(sbTarget) && !REINSTALL) ok(`bin sing-box (cached)`);
  else {
    const asset = singboxAsset();
    const url = `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VER}/${asset}`;
    info(`downloading sing-box v${SINGBOX_VER} (${asset}) ...`);
    const buf = await download(url);
    if (buf.length < 3_000_000) die(`sing-box download too small (${buf.length} B) — bad release asset`);
    const tmp = path.join(os.tmpdir(), `archrouter-sb-${process.pid}`);
    fs.mkdirSync(tmp, { recursive: true });
    const arc = path.join(tmp, asset);
    fs.writeFileSync(arc, buf);
    extract(arc, tmp, "sing-box");
    const found = findFile(tmp, IS_WIN ? "sing-box.exe" : "sing-box");
    if (!found) die("sing-box binary not found inside archive");
    fs.copyFileSync(found, sbTarget);
    if (!IS_WIN) { try { fs.chmodSync(sbTarget, 0o755); } catch { /* best effort */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
    ok(`sing-box v${SINGBOX_VER} → ${sbTarget} (sha256 ${sha256(buf).slice(0, 16)}…)`);
  }
  const sr = spawnSync(sbTarget, ["version"], { stdio: "ignore" });
  sr.status === 0 ? ok("sing-box runs on this arch") : bad("sing-box failed to run (wrong arch?)");

  // Audit trail. Upstream publishes no per-asset checksum for these two, so we
  // record what we actually installed instead of claiming verification we
  // cannot do.
  try {
    const sums = ["wgcf", "sing-box"].map((n) => {
      const p = path.join(bindir, IS_WIN ? `${n}.exe` : n);
      return `${sha256(fs.readFileSync(p))}  ${n}${IS_WIN ? ".exe" : ""}`;
    });
    fs.writeFileSync(path.join(bindir, "SHA256SUMS"), sums.join("\n") + "\n");
    ok(`checksums recorded → ${path.join(bindir, "SHA256SUMS")}`);
  } catch { info("could not write SHA256SUMS"); }
}

/* ---------------- layout + env ---------------- */

function makeDirs() {
  step("layout");
  for (const d of [DATA, LOGS, path.join(WARP, "warp-a"), path.join(WARP, "warp-b"), BINBASE]) {
    fs.mkdirSync(d, { recursive: true });
  }
  ok(`${BASE} (data, logs, warp/warp-a, warp/warp-b, bin)`);
}

function writeEnv() {
  step("configuration");
  const envFile = path.join(BASE, ".env");
  if (fs.existsSync(envFile)) { ok(".env exists (kept)"); }
  else {
    const src = path.join(REPO, ".env.example");
    let text = "";
    if (fs.existsSync(src)) {
      text = fs.readFileSync(src, "utf8");
    } else {
      text = "# archrouter config\nARCHROUTER_PORT=20399\nARCHROUTER_HOST=127.0.0.1\nARCHROUTER_MODE=warp\n";
    }
    // Health probe must be an IP literal: sing-box inside the tunnel has no
    // usable resolver (queries ride route.final=warp-ep and come back REFUSED).
    if (!/^ARCHROUTER_HEALTH_URL=/m.test(text)) {
      text += "ARCHROUTER_HEALTH_URL=https://1.1.1.1/cdn-cgi/trace\n";
    }
    if (!/^ARCHROUTER_STAGGER_MS=/m.test(text)) {
      text += "# ms between starting warp-a and warp-b (fewer same-IP collisions)\nARCHROUTER_STAGGER_MS=8000\n";
    }
    fs.writeFileSync(envFile, text);
    ok(`.env written → ${envFile}`);
  }
}

/* ---------------- launcher on PATH ---------------- */

function shimDir() {
  // Same location on every OS so docs and muscle memory hold up.
  if (IS_WIN) return path.join(HOME_DIR || os.homedir(), ".local", "bin");
  return path.join(HOME_DIR || os.homedir(), ".local", "bin");
}

function installShims() {
  step("launcher on PATH");
  const dir = shimDir();
  fs.mkdirSync(dir, { recursive: true });
  const nodeExe = process.execPath;

  if (IS_WIN) {
    // cmd/PowerShell entry point. Node path is absolute so PATH tweaks later
    // cannot break the launcher.
    const cmd = `@echo off\r\n"${nodeExe}" "${path.join(REPO, "archrouter.js")}" %*\r\n`;
    fs.writeFileSync(path.join(dir, "archrouter.cmd"), cmd);
    ok(`archrouter.cmd → ${dir}`);
    // Git Bash / WSL bash entry point.
    const sh = `#!/usr/bin/env bash\nexec "${nodeExe}" "${path.join(REPO, "archrouter.js")}" "$@"\n`;
    fs.writeFileSync(path.join(dir, "archrouter"), sh);
    ok(`archrouter (sh) → ${dir}`);

    const already = (process.env.PATH || "").toLowerCase().split(";").includes(dir.toLowerCase());
    if (already) { ok("shim dir already in PATH"); }
    else {
      // User-scope registry, no admin needed. New terminals pick it up.
      const q = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8" });
      let cur = "";
      if (q.status === 0) {
        const m = /REG_(?:EXPAND_)?SZ\s+Path\s+(.*)/.exec(q.stdout || "");
        cur = m ? m[1].trim() : "";
      }
      const next = cur ? `${cur};${dir}` : dir;
      const r = spawnSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", next, "/f"], { stdio: "ignore" });
      r.status === 0
        ? ok(`added to user PATH — open a NEW terminal to pick it up`)
        : bad("could not update user PATH (edit it manually or run archrouter by full path)");
    }
    return;
  }

  const target = path.join(dir, "archrouter");
  try { fs.unlinkSync(target); } catch { /* none */ }
  fs.symlinkSync(path.join(REPO, "archrouter"), target);
  try { fs.chmodSync(path.join(REPO, "archrouter"), 0o755); fs.chmodSync(target, 0o755); } catch { /* best effort */ }
  ok(`symlink → ${target}`);
  const inPath = (process.env.PATH || "").split(":").some((p) => { try { return fs.realpathSync(p) === fs.realpathSync(dir); } catch { return p === dir; } });
  inPath ? ok("shim dir in PATH") : info(`add to PATH: export PATH="$HOME/.local/bin:$PATH"`);
}

/* ---------------- unattended ---------------- */

async function unattended() {
  step("deploy (unattended)");
  const self = [process.execPath, path.join(REPO, "archrouter.js")];
  const run = (args, label) => {
    const r = spawnSync(self[0], [...self.slice(1), ...args], { stdio: "inherit" });
    if (r.status !== 0) { bad(`${label} failed (exit ${r.status})`); return false; }
    return true;
  };
  if (run(["warp-setup"], "warp-setup")) ok("warp accounts + sing-box configs ready");
  else die("warp-setup failed — fix the errors above, then re-run");
  if (run(["start"], "start")) ok("stack started");
  else die("start failed — see ~/.archrouter/data/logs/*.log");

  await new Promise((r) => setTimeout(r, 3000));
  const health = await new Promise((resolve) => {
    const port = process.env.ARCHROUTER_PORT || "20399";
    const req = require("http").get(`http://127.0.0.1:${port}/health`, { timeout: 4000 }, (res) => {
      let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve(b));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { try { req.destroy(); } catch {} resolve(null); });
  });
  health ? ok(`router /health → ${health.slice(0, 80)}`) : bad("router /health no response");

  // The invariant is the whole point of the two-account setup: verify it.
  const statusPort = process.env.ARCHROUTER_STATUS_PORT || "9190";
  const inv = await new Promise((resolve) => {
    const req = require("http").get(`http://127.0.0.1:${statusPort}/`, { timeout: 5000 }, (res) => {
      let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve(b));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { try { req.destroy(); } catch {} resolve(null); });
  });
  if (inv) {
    try {
      const j = JSON.parse(inv);
      const ips = (j.instances || []).map((x) => `${x.id}=${x.public_ip}`).join(" ");
      info(`pool: ${ips}`);
      if (j.invariant_ok === true) ok(`invariant_ok=true (distinct egress IPs: ${(j.serving_ips || []).join(", ")})`);
      else if (j.invariant_ok === null) info("invariant_ok=null — pool still probing IPs, re-run `archrouter doctor` in ~30s");
      else bad("invariant_ok=FALSE — two accounts share one egress IP; the guard will park one and retry");
    } catch { info("pool status not parseable yet"); }
  } else {
    info("pool status not reachable yet — re-run `archrouter doctor` in ~30s");
  }
}

/* ---------------- main ---------------- */

(async () => {
  console.log(`[install] archrouter installer — platform=${PLAT} arch=${process.arch} base=${BASE}`);
  osPackages();
  checkNode();
  makeDirs();
  writeEnv();
  if (OFFLINE) info("--offline: skipped binary download");
  else await installBins();
  installShims();

  if (UNATTENDED) {
    if (nodeMajor() < 22) die("node >= 22 required for unattended deploy");
    await unattended();
  }

  console.log(`\n== summary: ${failures ? `${failures} problem(s)` : "all good"} ==`);
  if (!UNATTENDED) {
    console.log(`
next:
  archrouter warp-setup     # register 2 WARP accounts + generate sing-box configs
  archrouter start           # start warp-a/warp-b + pool + router (mode=warp)
  archrouter doctor          # checks ports, binaries, invariant_ok, live warp trace
  archrouter status          # pids + egress IPs + invariant_ok
  archrouter stop

no autostart was installed — start it yourself whenever you need it.
`);
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => die(e && e.stack ? e.stack : String(e)));