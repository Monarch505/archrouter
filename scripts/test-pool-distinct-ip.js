"use strict";
/* Test: same-egress-IP guard — two wgcf accounts must never be served on one
 * WARP egress IP (quota is per IP, proven 2026-09-25). All local, no internet.
 *
 * Fake backends answer the health probe from an ipmap file ({a:"1.1.1.1",...}),
 * so the test can force a collision and simulate what a real bounce does:
 * the reset hook hands the reset backend a NEW ip, then the pool must park,
 * re-probe, and put it back into rotation.
 *
 * Usage: node scripts/test-pool-distinct-ip.js
 */
const net = require("net");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// NB: avoid 18005-18104 / 19211-19310 — Windows excluded port ranges.
// Ports are overridable because Windows moves those ranges around (netsh
// "excludedportrange"), so a hardcoded port can refuse to bind with EACCES on
// one day and work the next.
const FAKE_A = Number(process.env.POOLDIST_A_PORT || 28020), FAKE_B = Number(process.env.POOLDIST_B_PORT || 28021),
      POOL = Number(process.env.POOLDIST_POOL_PORT || 28002), STATUS = Number(process.env.POOLDIST_STATUS_PORT || 29091),
      HEALTH = Number(process.env.POOLDIST_HEALTH_PORT || 28902);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pooldistinct-"));
const ipMap = path.join(tmp, "ipmap.json");
const planFile = path.join(tmp, "plan.json");
const hookLog = path.join(tmp, "hooks.txt");
const hookJs = path.join(tmp, "hook.js");
const ipArg = ipMap.replace(/\\/g, "\\\\");
const hookArg = hookLog.replace(/\\/g, "\\\\");

// Egress IP per backend. Collision is forced mid-test; the hook bumps the
// reset backend to FRESH[tag] (what Cloudflare does after a real bounce).
const FRESH = { a: "8.8.8.8", b: "9.9.9.9" };
let ipState = { a: "1.1.1.1", b: "2.2.2.2" };
function writeIps(next) {
  ipState = { ...ipState, ...next };
  fs.writeFileSync(ipMap, JSON.stringify(ipState));
}
writeIps({});

const counts = { a: 0, b: 0 }; // client traffic served (host != 127.0.0.1)

// argv: [node, hook.js, <hookLog path>, %ID%] — id is argv[3] (same layout as
// test-pool-rotation.js). plan.json ({a:["1.2.3.4",...]}) overrides the landing
// per reset attempt so a test can hand the pool a "fresh" IP that is NOT fresh
// (same /24 as the burned one) and watch it refuse to stay there.
fs.writeFileSync(hookJs, `
const fs = require("fs");
const ipFile = ${JSON.stringify(ipMap)};
const planFile = ${JSON.stringify(planFile)};
const fresh = ${JSON.stringify(FRESH)};
const id = process.argv[3];
fs.appendFileSync(${JSON.stringify(hookLog)}, id + "\\n");
const m = JSON.parse(fs.readFileSync(ipFile, "utf8"));
let next = null;
try {
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  if (Array.isArray(plan[id]) && plan[id].length) next = plan[id].shift();
  if (Array.isArray(plan[id])) fs.writeFileSync(planFile, JSON.stringify(plan));
} catch {}
m[id] = next || fresh[id];               // bounce -> new egress IP
fs.writeFileSync(ipFile, JSON.stringify(m));
`);

// Reply to a health probe with this backend's own egress IP. The reply is
// flushed and the socket dropped a beat later: closing immediately races the
// client's request write and shows up as "socket hang up".
function replyHealth(client, ip) {
  const body = `${ip}\n`;
  client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
  setTimeout(() => {
    try {
      client.write(Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`));
    } catch {}
    setTimeout(() => { try { client.destroy(); } catch {} }, 200);
  }, 50);
}

function fakeBackend(port, tag, ipFile = ipMap, healthPort = HEALTH) {
  const srv = net.createServer((client) => {
    let stage = 0, buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (stage === 0) {
          if (buf.length < 2 || buf.length < 2 + buf[1]) return;
          client.write(Buffer.from([5, 0]));
          buf = buf.slice(2 + buf[1]); stage = 1;
        }
        if (stage === 1) {
          if (buf.length < 4) return;
          const atyp = buf[3];
          let host, portN, off;
          if (atyp === 1) { if (buf.length < 10) return; host = [...buf.slice(4, 8)].join("."); portN = buf.readUInt16BE(8); off = 10; }
          else if (atyp === 3) { const n = buf[4]; if (buf.length < 5 + n + 2) return; host = buf.slice(5, 5 + n).toString(); portN = buf.readUInt16BE(5 + n); off = 5 + n + 2; }
          else { client.destroy(); return; }
          client.removeListener("data", onData);
          if (portN === healthPort) { replyHealth(client, JSON.parse(fs.readFileSync(ipFile, "utf8"))[tag]); return; }
          counts[tag] += 1;
          const up = net.connect(portN, host, () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            client.pipe(up); up.pipe(client);
          });
          up.on("error", () => { try { client.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); } catch {} client.destroy(); });
          client.on("error", () => { try { up.destroy(); } catch {} });
        }
      } catch { try { client.destroy(); } catch {} }
    };
    client.on("data", onData);
    client.on("error", () => {});
  });
  return new Promise((res) => srv.listen(port, "127.0.0.1", () => res(srv)));
}

function viaAt(POOLP, host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(POOLP, "127.0.0.1");
    const t = setTimeout(() => { s.destroy(); reject(new Error("timeout")); }, 10000);
    let stage = 0, buf = Buffer.alloc(0);
    s.on("connect", () => s.write(Buffer.from([5, 1, 0])));
    s.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (stage === 0 && buf.length >= 2) {
        stage = 1; buf = Buffer.alloc(0);
        const h = Buffer.from(host);
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([(port >> 8) & 255, port & 255])]));
      } else if (stage === 1 && buf.length >= 10) {
        clearTimeout(t); const rep = buf[1]; s.destroy();
        rep === 0 ? resolve() : reject(new Error("rep=" + rep));
      }
    });
    s.on("error", reject);
  });
}

function getAt(SP, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: SP, path: p, timeout: 8000 }, (r) => {
      let s = ""; r.on("data", (c) => { s += c; }); r.on("end", () => resolve({ code: r.statusCode, body: s }));
    }).on("error", reject);
  });
}
function get(p) { return getAt(STATUS, p); }
function postAt(SP, p, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request({ host: "127.0.0.1", port: SP, path: p, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 8000 }, (r) => {
      let s = ""; r.on("data", (c) => { s += c; }); r.on("end", () => resolve({ code: r.statusCode, body: s }));
    });
    req.on("error", reject); req.end(body);
  });
}
function post(p, obj) { return postAt(STATUS, p, obj); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const viaPool = (h, p) => viaAt(POOL, h, p);
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}
async function waitFor(fn, secs = 40, step = 1000) {
  for (let i = 0; i < secs; i++) {
    let st = null;
    try { st = JSON.parse((await get("/")).body); } catch {}
    if (st && fn(st)) return st;
    await sleep(step);
  }
  try { return JSON.parse((await get("/")).body); } catch { return null; }
}

// 2026-10-09: the two bucket scenarios run in a SECOND, freshly spawned pool.
// They must not inherit burned-memory from the run above: a backend parked
// inside a burned bucket is correctly refused further probes (that is the fix
// working), which would leave the fixture stuck on a stale IP.
const B2 = {
  a: Number(process.env.POOLDIST_B2_A_PORT || 28030),
  b: Number(process.env.POOLDIST_B2_B_PORT || 28031),
  pool: Number(process.env.POOLDIST_B2_POOL_PORT || 28003),
  status: Number(process.env.POOLDIST_B2_STATUS_PORT || 29092),
  health: Number(process.env.POOLDIST_B2_HEALTH_PORT || 28903),
};
async function bucketScenarios() {
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), "pooldistinct2-"));
  const ip2 = path.join(t2, "ipmap.json"), log2 = path.join(t2, "hooks.txt");
  const hk2 = path.join(t2, "hook.js"), pl2 = path.join(t2, "plan.json");
  const FRESH2 = { a: "8.8.8.8", b: "9.9.9.9" };
  const state2 = { a: "104.28.215.130", b: "104.28.215.133" };
  const write2 = (next) => { Object.assign(state2, next); fs.writeFileSync(ip2, JSON.stringify(state2)); };
  fs.writeFileSync(ip2, JSON.stringify(state2));
  fs.writeFileSync(hk2, `
const fs = require("fs");
const id = process.argv[3];
fs.appendFileSync(${JSON.stringify(log2)}, id + "\\n");
const m = JSON.parse(fs.readFileSync(${JSON.stringify(ip2)}, "utf8"));
let next = null;
try {
  const plan = JSON.parse(fs.readFileSync(${JSON.stringify(pl2)}, "utf8"));
  if (Array.isArray(plan[id]) && plan[id].length) next = plan[id].shift();
  if (Array.isArray(plan[id])) fs.writeFileSync(${JSON.stringify(pl2)}, JSON.stringify(plan));
} catch {}
m[id] = next || ${JSON.stringify(FRESH2)}[id];
fs.writeFileSync(${JSON.stringify(ip2)}, JSON.stringify(m));
`);
  const sa = await fakeBackend(B2.a, "a", ip2, B2.health);
  const sb = await fakeBackend(B2.b, "b", ip2, B2.health);
  const hs = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("9.9.9.9\n"); });
  await new Promise((r) => hs.listen(B2.health, "127.0.0.1", r));
  const p2 = spawn(process.execPath, ["pool/pool.js",
    "--listen", `127.0.0.1:${B2.pool}`, "--status-port", String(B2.status),
    "--backend", `a=127.0.0.1:${B2.a}`, "--backend", `b=127.0.0.1:${B2.b}`,
    "--reset-hook", `node "${hk2}" "${log2.replace(/\\/g, "\\\\")}" %ID%`,
    "--health-url", `http://127.0.0.1:${B2.health}/`,
    "--health-interval", "2", "--health-fail-thr", "3",
    "--min-reset-gap", "1", "--quarantine-secs", "4",
    "--same-ip-guard", "1", "--distinct-retries", "3",
    "--distinct-retry-delay", "1", "--park-retry-delay", "5", "--sweep-interval", "2",
  ], { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
  let out2 = "";
  p2.stdout.on("data", (c) => { out2 += c; });
  p2.stderr.on("data", (c) => { out2 += c; });
  const wait2 = async (fn, secs = 40) => {
    for (let i = 0; i < secs; i++) {
      let s = null;
      try { s = JSON.parse((await getAt(B2.status, "/")).body); } catch {}
      if (s && fn(s)) return s;
      await sleep(1000);
    }
    try { return JSON.parse((await getAt(B2.status, "/")).body); } catch { return null; }
  };
  try {
    // 7) BUCKET, not address: .130 and .133 are different addresses in one
    //    quota bucket. A burn on .130 must exclude .133 too — otherwise the
    //    "rotation" just walks into the same wall one address over.
    const st7 = await wait2((s) => s.instances.every((i) => ["104.28.215.130", "104.28.215.133"].includes(i.public_ip)));
    check("bucket fixture live: both backends probed", st7.instances.map((i) => i.id + ":" + i.public_ip).join(" ") === "a:104.28.215.130 b:104.28.215.133",
      JSON.stringify(st7.instances.map((i) => i.id + ":" + i.public_ip)));
    const preQ = st7.smart_reset.shared_ip_quarantines;
    const rep3 = await postAt(B2.status, "/api/report", { event: "freeusagelimit", instance: "a" });
    check("limit report on bucket-mate address → 202", rep3.code === 202, rep3.body);
    const after7 = JSON.parse((await getAt(B2.status, "/")).body);
    const quarantined7 = after7.instances.filter((i) => i.quarantined).map((i) => i.id).sort();
    check("bucket sibling quarantined too (different IP, same /24)", quarantined7.length === 2,
      `quarantined=${JSON.stringify(quarantined7)} ips=${JSON.stringify(after7.instances.map((i) => i.id + ":" + i.public_ip))} msg=${rep3.body}`);
    check("bucket quarantine counted", after7.smart_reset.shared_ip_quarantines > preQ, JSON.stringify(after7.smart_reset));
    check("bucket_bits exposed in status", after7.bucket_bits === 24, `bucket_bits=${after7.bucket_bits}`);
    await wait2((s) => s.instances.every((i) => !i.quarantined), 30);

    // 8) a reset that lands in the SAME BUCKET as the burned IP is not a
    //    recovery. The hook's first bounce is 4.4.4.133 — a different address,
    //    same /24 as the burned 4.4.4.4. The pool must refuse to stay there and
    //    retry until it escapes the bucket (second bounce = 8.8.8.8).
    const burned2 = "4.4.4.4";
    fs.writeFileSync(pl2, JSON.stringify({ a: ["4.4.4.133", "8.8.8.8"] }));
    write2({ a: burned2, b: "5.5.5.5" });
    await wait2((s) => s.instances.find((i) => i.id === "a").public_ip === burned2);
    const pre8 = JSON.parse((await getAt(B2.status, "/")).body);
    const preC = pre8.smart_reset.conflict_resets;
    const rep4 = await postAt(B2.status, "/api/report", { event: "freeusagelimit", instance: "a" });
    check("limit report → 202", rep4.code === 202, rep4.body);
    const inBurnedBucket = (ip) => !ip || ip === burned2 || ip.startsWith("4.4.4.");
    let st8 = null;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      st8 = JSON.parse((await getAt(B2.status, "/")).body);
      // Wait for an ESCAPE from the bucket, not merely "different from the
      // burned address" — 4.4.4.133 differs but sits in the same dead /24.
      if (!inBurnedBucket(st8.instances.find((x) => x.id === "a").public_ip)) break;
    }
    const ip8 = st8.instances.find((x) => x.id === "a").public_ip;
    check("bucket-equal landing rejected — reset escapes the burned /24", ip8 === "8.8.8.8",
      `burned=${burned2} bucket-mate=4.4.4.133 now=${ip8}`);
    check("bucket conflict counted (not silently accepted)", st8.smart_reset.conflict_resets > preC,
      `${preC} → ${st8.smart_reset.conflict_resets}`);

    // 9) fail-closed on a burned bucket: a backend whose ONLY reachable
    //    landing is inside the burned bucket must stay parked/out of rotation
    //    instead of being un-parked onto it (2026-10-09 park/unpark churn).
    // Every future a-reset lands inside the burned /24 again — the hook can no
    // longer produce an escape. Put a BACK onto the burned address first (the
    // report below is what arms the burn), then fire the limit event.
    fs.writeFileSync(pl2, JSON.stringify({ a: new Array(12).fill("4.4.4.133") }));
    write2({ a: burned2, b: "6.6.6.6" });
    await wait2((s) => s.instances.find((i) => i.id === "a").public_ip === burned2, 30);
    const hookCount = () => { try { return fs.readFileSync(log2, "utf8").split("\n").filter((x) => x.trim() === "a").length; } catch { return 0; } };
    const parkBase = hookCount();
    const rep5 = await postAt(B2.status, "/api/report", { event: "freeusagelimit", instance: "a" });
    check("stuck-bucket report → 202", rep5.code === 202, rep5.body);
    // Gate on the retries actually running (hook fired again and again) rather
    // than on a sleep: a fixed wait here would pass whether or not the retry
    // loop ever executed.
    const st9 = await wait2((s) => {
      const a = s.instances.find((i) => i.id === "a");
      return a.parked === true && hookCount() >= parkBase + 3;
    }, 45);
    const a9 = st9.instances.find((i) => i.id === "a");
    check("backend that cannot escape the burned bucket stays parked (never re-served on it)",
      a9.parked === true && String(a9.public_ip).startsWith("4.4.4.") && !st9.serving.includes("a"),
      `parked=${a9.parked} ip=${a9.public_ip} serving=${JSON.stringify(st9.serving)} hookAttempts=${hookCount() - parkBase}`);
  } catch (e) {
    check("no exception (bucket scenarios)", false, e.message);
  } finally {
    try { p2.kill("SIGKILL"); } catch {}
    sa.close(); sb.close(); hs.close();
    fs.rmSync(t2, { recursive: true, force: true });
    if (failures) console.log(`\n--- pool2 log tail ---\n${out2.split("\n").slice(-25).join("\n")}`);
  }
}

(async () => {
  const srvA = await fakeBackend(FAKE_A, "a");
  const srvB = await fakeBackend(FAKE_B, "b");
  const pool = spawn(process.execPath, ["pool/pool.js",
    "--listen", `127.0.0.1:${POOL}`, "--status-port", String(STATUS),
    "--backend", `a=127.0.0.1:${FAKE_A}`, "--backend", `b=127.0.0.1:${FAKE_B}`,
    "--reset-hook", `node "${hookJs}" "${hookArg}" %ID%`,
    "--health-url", `http://127.0.0.1:${HEALTH}/`,
    "--health-interval", "2", "--health-fail-thr", "3",
    "--min-reset-gap", "1", "--quarantine-secs", "4",
    "--same-ip-guard", "1", "--distinct-retries", "3",
    "--distinct-retry-delay", "1", "--park-retry-delay", "5", "--sweep-interval", "2",
  ], { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
  let poolOut = "";
  pool.stdout.on("data", (c) => { poolOut += c; });
  pool.stderr.on("data", (c) => { poolOut += c; });
  const killAll = () => { try { pool.kill("SIGKILL"); } catch {} srvA.close(); srvB.close(); };
  process.on("exit", () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  try {
    // 1) distinct IPs → no conflict, both in rotation
    const st0 = await waitFor((st) => st.instances.every((i) => i.public_ip));
    const ips0 = st0.instances.map((i) => i.public_ip);
    check("both probed with distinct IPs", new Set(ips0).size === 2, JSON.stringify(ips0));
    check("ip_conflict=false when distinct", st0.ip_conflict === false, JSON.stringify(st0.ip_conflict));
    check("nothing parked when distinct", st0.parked.length === 0, JSON.stringify(st0.parked));
    check("invariant_ok=true when distinct", st0.invariant_ok === true, JSON.stringify(st0.invariant_ok));
    check("serving/serving_ips exposed", Array.isArray(st0.serving) && st0.serving.length === 2
      && Array.isArray(st0.serving_ips) && st0.serving_ips.length === 2,
      `serving=${JSON.stringify(st0.serving)} ips=${JSON.stringify(st0.serving_ips)}`);

    // 2) force a collision: both backends now report the same egress IP
    writeIps({ a: "5.5.5.5", b: "5.5.5.5" });
    const st1 = await waitFor((st) => st.ip_conflict === true);
    check("collision detected", st1.ip_conflict === true, `ips=${JSON.stringify(st1.instances.map((i) => i.id + ":" + i.public_ip))}`);
    check("exactly one backend parked", st1.parked.length === 1, `parked=${JSON.stringify(st1.parked)}`);
    const parkedId = st1.parked[0];
    const keeperId = st1.instances.find((i) => i.id !== parkedId).id;
    check("parked flag visible per instance", st1.instances.find((i) => i.id === parkedId).parked === true
      && st1.instances.find((i) => i.id === keeperId).parked === false, `parked=${parkedId} keeper=${keeperId}`);
    // The hard guarantee: even WHILE the IPs collide, the RR-eligible set holds
    // exactly one account (the duplicate is parked) → invariant_ok stays true.
    check("invariant_ok=true even during collision", st1.invariant_ok === true
      && st1.serving.length === 1 && st1.serving_ips.length === 1,
      `invariant_ok=${JSON.stringify(st1.invariant_ok)} serving=${JSON.stringify(st1.serving)} ips=${JSON.stringify(st1.serving_ips)}`);

    // 3) parked backend is never served while the IPs collide
    const before = { ...counts };
    for (let i = 0; i < 3; i++) { try { await viaPool("opencode.ai", 443); } catch {} await sleep(400); }
    const servedParked = counts[parkedId] - before[parkedId];
    const servedKeeper = counts[keeperId] - before[keeperId];
    check("parked backend gets no traffic", servedParked === 0 && servedKeeper > 0,
      `parked=${parkedId} served=${servedParked} keeper=${keeperId} served=${servedKeeper}`);

    // 4) reset hook fired for the parked backend; it diverges → un-parked
    let hooks = "";
    for (let i = 0; i < 25 && !hooks.includes(parkedId); i++) { await sleep(1000); try { hooks = fs.readFileSync(hookLog, "utf8"); } catch {} }
    check("reset hook fired for parked backend", hooks.includes(parkedId), `hooks=${JSON.stringify(hooks.trim())}`);
    const st2 = await waitFor((st) => st.parked.length === 0 && st.ip_conflict === false, 30);
    const ips2 = st2.instances.map((i) => i.public_ip);
    check("diverged → un-parked, IPs distinct again", st2.parked.length === 0 && new Set(ips2).size === 2,
      `ips=${JSON.stringify(ips2)} parked=${JSON.stringify(st2.parked)}`);
    check("unpark counted", st2.smart_reset.unpark_count >= 1, JSON.stringify(st2.smart_reset));

    // 5) usage-limit on a shared IP quarantines BOTH (sibling quota is burned too)
    writeIps({ a: "6.6.6.6", b: "6.6.6.6" });
    await waitFor((st) => st.ip_conflict === true);
    const rep = await post("/api/report", { event: "freeusagelimit", instance: "a" });
    check("limit report on shared IP → 202", rep.code === 202, rep.body);
    const st3 = JSON.parse((await get("/")).body);
    const q3 = st3.instances.filter((i) => i.quarantined).map((i) => i.id).sort();
    check("both backends quarantined (same IP)", q3.length === 2, `quarantined=${JSON.stringify(q3)} msg=${rep.body}`);
    check("shared_ip_quarantines counted", st3.smart_reset.shared_ip_quarantines >= 1, JSON.stringify(st3.smart_reset));

    // 6) a limit event must not hand the burned IP back. Live bug 2026-09-30:
    //    429 on .130 -> reset -> .130 again -> DONE (quota already spent there).
    //    The reset must retry until the IP differs from the burned one.
    const burned = "4.4.4.4";
    writeIps({ a: burned, b: "7.7.7.7" });
    await waitFor((st) => st.instances.find((i) => i.id === "a").public_ip === burned);
    const rep2 = await post("/api/report", { event: "freeusagelimit", instance: "a" });
    check("limit report → 202", rep2.code === 202, rep2.body);
    // The hook gives a FRESH ip for a, so the reset should end on FRESH.a (8.8.8.8),
    // never back on the burned 4.4.4.4.
    let stB = null;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      stB = JSON.parse((await get("/")).body);
      const a = stB.instances.find((x) => x.id === "a").public_ip;
      if (a && a !== burned) break;
    }
    const ipAfter = stB.instances.find((x) => x.id === "a").public_ip;
    check("reset after 429 lands on a NEW ip (never the burned one)", !!ipAfter && ipAfter !== burned,
      `burned=${burned} now=${ipAfter}`);
    check("burned-IP retry counted", stB.smart_reset.conflict_resets >= 1, JSON.stringify(stB.smart_reset));

    // 6) invariant holds overall: no moment with two backends served on one IP
    const stF = await waitFor((st) => st.instances.every((i) => i.public_ip) && new Set(st.instances.map((i) => i.public_ip)).size === 2, 40);
    const ipsF = stF.instances.map((i) => i.public_ip);
    check("final state: two distinct egress IPs", new Set(ipsF).size === 2, JSON.stringify(ipsF));

    // 7-9) bucket scenarios in their own pool (see bucketScenarios)
    await bucketScenarios();
  } catch (e) {
    check("no exception", false, e.message);
  } finally {
    killAll();
  }
  if (failures) console.log(`\n--- pool log tail ---\n${poolOut.split("\n").slice(-25).join("\n")}`);
  console.log(failures ? `RESULT: ${failures} FAILURES` : "RESULT: ALL PASS");
  process.exit(failures ? 1 : 0);
})();
