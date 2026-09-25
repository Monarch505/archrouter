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
const FAKE_A = 28020, FAKE_B = 28021, POOL = 28002, STATUS = 29091, HEALTH = 28902;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pooldistinct-"));
const ipMap = path.join(tmp, "ipmap.json");
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
// test-pool-rotation.js).
fs.writeFileSync(hookJs, `
const fs = require("fs");
const ipFile = ${JSON.stringify(ipMap)};
const fresh = ${JSON.stringify(FRESH)};
const id = process.argv[3];
fs.appendFileSync(${JSON.stringify(hookLog)}, id + "\\n");
const m = JSON.parse(fs.readFileSync(ipFile, "utf8"));
m[id] = fresh[id];               // bounce -> new egress IP
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

function fakeBackend(port, tag) {
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
          if (portN === HEALTH) { replyHealth(client, JSON.parse(fs.readFileSync(ipMap, "utf8"))[tag]); return; }
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

function viaPool(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(POOL, "127.0.0.1");
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

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: STATUS, path: p, timeout: 8000 }, (r) => {
      let s = ""; r.on("data", (c) => { s += c; }); r.on("end", () => resolve({ code: r.statusCode, body: s }));
    }).on("error", reject);
  });
}
function post(p, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request({ host: "127.0.0.1", port: STATUS, path: p, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 8000 }, (r) => {
      let s = ""; r.on("data", (c) => { s += c; }); r.on("end", () => resolve({ code: r.statusCode, body: s }));
    });
    req.on("error", reject); req.end(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

    // 2) force a collision: both backends now report the same egress IP
    writeIps({ a: "5.5.5.5", b: "5.5.5.5" });
    const st1 = await waitFor((st) => st.ip_conflict === true);
    check("collision detected", st1.ip_conflict === true, `ips=${JSON.stringify(st1.instances.map((i) => i.id + ":" + i.public_ip))}`);
    check("exactly one backend parked", st1.parked.length === 1, `parked=${JSON.stringify(st1.parked)}`);
    const parkedId = st1.parked[0];
    const keeperId = st1.instances.find((i) => i.id !== parkedId).id;
    check("parked flag visible per instance", st1.instances.find((i) => i.id === parkedId).parked === true
      && st1.instances.find((i) => i.id === keeperId).parked === false, `parked=${parkedId} keeper=${keeperId}`);

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

    // 6) invariant holds overall: no moment with two backends served on one IP
    const stF = await waitFor((st) => st.instances.every((i) => i.public_ip) && new Set(st.instances.map((i) => i.public_ip)).size === 2, 40);
    const ipsF = stF.instances.map((i) => i.public_ip);
    check("final state: two distinct egress IPs", new Set(ipsF).size === 2, JSON.stringify(ipsF));
  } catch (e) {
    check("no exception", false, e.message);
  } finally {
    killAll();
  }
  if (failures) console.log(`\n--- pool log tail ---\n${poolOut.split("\n").slice(-25).join("\n")}`);
  console.log(failures ? `RESULT: ${failures} FAILURES` : "RESULT: ALL PASS");
  process.exit(failures ? 1 : 0);
})();
