"use strict";
/* Test: 429/403 rotation — limit report quarantines the serving backend,
 * traffic fails over, background reset runs. All local, no internet needed.
 *
 * The fake backends answer the health probe themselves with a per-backend IP
 * (a=1.1.1.1, b=2.2.2.2) so the same-IP guard stays ENABLED here: if both
 * reported one IP the pool would park a backend and this test would measure
 * the wrong thing.
 * Usage: node scripts/test-pool-rotation.js
 */
const net = require("net");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const FAKE_A = 18010, FAKE_B = 18011, POOL = 18001, STATUS = 19090, HEALTH = 18901;
const IP_OF = { a: "1.1.1.1", b: "2.2.2.2" }; // distinct egress IPs (guard invariant)
const counts = { a: {}, b: {} }; // tag -> host -> n (health probes hit 127.0.0.1, client traffic hits opencode.ai)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pooltest-"));
const hookLog = path.join(tmp, "hooks.txt");
const hookJs = path.join(tmp, "hook.js");
fs.writeFileSync(hookJs, "require('fs').appendFileSync(process.argv[2], process.argv[3] + '\\n');\n");
const hookPathArg = hookLog.replace(/\\/g, "\\\\");

function fakeBackend(port, tag) {
  const srv = net.createServer((client) => {
    let stage = 0, buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
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
        // Health probe (127.0.0.1:HEALTH) is answered locally with this
        // backend's own egress IP — no upstream dial, and never the same IP
        // for a and b (that is the invariant under test elsewhere). The drop
        // is delayed a beat: closing at once races the client's request write.
        if (portN === HEALTH) {
          const body = `${IP_OF[tag]}\n`;
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          setTimeout(() => {
            try {
              client.write(Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`));
            } catch {}
            setTimeout(() => { try { client.destroy(); } catch {} }, 200);
          }, 50);
          return;
        }
        const up = net.connect(portN, host, () => {
          counts[tag][host] = (counts[tag][host] || 0) + 1;
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          client.pipe(up); up.pipe(client);
        });
        up.on("error", () => { try { client.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); } catch {} client.destroy(); });
        client.on("error", () => { try { up.destroy(); } catch {} });
      }
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
// Client traffic now reaches the backend as an IP literal (pool resolves
// opencode.ai locally before dialing — see resolveIPv4 in pool.js), so count
// every connection that is NOT the health probe (127.0.0.1).
function served(tag) {
  return Object.entries(counts[tag] || {}).filter(([h]) => h !== "127.0.0.1")
    .reduce((n, [, v]) => n + v, 0);
}
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}

(async () => {
  const healthSrv = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("9.9.9.9\n"); });
  await new Promise((res) => healthSrv.listen(HEALTH, "127.0.0.1", res));
  const srvA = await fakeBackend(FAKE_A, "a");
  const srvB = await fakeBackend(FAKE_B, "b");

  const pool = spawn(process.execPath, ["pool/pool.js",
    "--listen", `127.0.0.1:${POOL}`, "--status-port", String(STATUS),
    "--backend", `a=127.0.0.1:${FAKE_A}`, "--backend", `b=127.0.0.1:${FAKE_B}`,
    "--reset-hook", `node "${hookJs}" "${hookPathArg}" %ID%`,
    "--health-url", `http://127.0.0.1:${HEALTH}/`,
    "--health-interval", "60", "--health-fail-thr", "3",
    "--min-reset-gap", "2", "--quarantine-secs", "6",
  ], { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
  let poolOut = "";
  pool.stdout.on("data", (c) => { poolOut += c; });
  pool.stderr.on("data", (c) => { poolOut += c; });

  const killAll = () => { try { pool.kill("SIGKILL"); } catch {} srvA.close(); srvB.close(); healthSrv.close(); };
  process.on("exit", () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  try {
    await sleep(6000); // first health probes
    const st0 = JSON.parse((await get("/")).body);
    check("both backends probed ok", st0.instances.every((i) => i.consecFails === 0), JSON.stringify(st0.instances.map((i) => i.id + ":" + i.consecFails)));

    // serve one request for opencode.ai through the pool (handshake only)
    await viaPool("opencode.ai", 443);
    const svc = { a: served("a"), b: served("b") };
    const servedBy = svc.a === 1 && svc.b === 0 ? "a" : svc.b === 1 && svc.a === 0 ? "b" : "?";
    check("request served via pool", servedBy !== "?", `svc=${JSON.stringify(svc)}`);

    // 429/403 limit report → 202 quarantine of the SERVING backend
    const rep = await post("/api/report", { event: "freeusagelimit" });
    check("limit report → 202 quarantine", rep.code === 202, rep.body);
    const st1 = JSON.parse((await get("/")).body);
    const q = st1.instances.find((i) => i.quarantined);
    check("quarantined == serving backend", !!q && q.id === servedBy, `quarantined=${q && q.id} servedBy=${servedBy}`);

    // failover: next request must land on the OTHER backend
    const before = { a: served("a"), b: served("b") };
    await viaPool("opencode.ai", 443);
    const after = { a: served("a"), b: served("b") };
    const other = servedBy === "a" ? "b" : "a";
    check("failover to healthy backend", after[other] === before[other] + 1 && after[servedBy] === before[servedBy],
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

    // background reset hook fired for the burned backend
    let hookIds = "";
    for (let i = 0; i < 30 && !hookIds.includes(servedBy); i++) {
      await sleep(1000);
      try { hookIds = fs.readFileSync(hookLog, "utf8"); } catch {}
    }
    check("reset hook fired for burned backend", hookIds.includes(servedBy), `hooks=${JSON.stringify(hookIds.trim())}`);

    // reset completes (verify via local health through fake forwarders)
    let done = false;
    for (let i = 0; i < 45 && !done; i++) {
      await sleep(1000);
      const st = JSON.parse((await get("/")).body);
      done = st.events.some((e) => e.type === "reset" && e.instance === servedBy && e.msg.startsWith("DONE"));
    }
    check("background reset DONE", done);

    // quarantine expires (same IP → flag kept until timeout)
    await sleep(8000);
    const st2 = JSON.parse((await get("/")).body);
    check("quarantine expires", st2.instances.every((i) => !i.quarantined));

    // explicit instance id still works
    const rep2 = await post("/api/report", { event: "freeusagelimit", instance: "b" });
    const st3 = JSON.parse((await get("/")).body);
    check("explicit instance quarantine", rep2.code === 202 && st3.instances.find((i) => i.id === "b").quarantined);

    // independent resets: b resetting must NOT block a's reset
    const rep3 = await post("/api/report", { event: "forbidden", instance: "a" });
    await sleep(1000);
    const rep4 = await post("/api/report", { event: "forbidden", instance: "b" });
    check("parallel resets: no 409 cross-block", rep3.code === 202 && rep4.code === 202,
      `a=${rep3.code} b=${rep4.code}`);
    let bothDone = false;
    for (let i = 0; i < 60 && !bothDone; i++) {
      await sleep(1000);
      const st = JSON.parse((await get("/")).body);
      const dones = st.events.filter((e) => e.type === "reset" && e.msg.startsWith("DONE")).map((e) => e.instance);
      bothDone = dones.includes("a") && dones.includes("b");
    }
    check("both parallel resets DONE", bothDone);
  } catch (e) {
    check("no exception", false, e.message);
  } finally {
    killAll();
  }
  console.log(failures ? `RESULT: ${failures} FAILURES` : "RESULT: ALL PASS");
  process.exit(failures ? 1 : 0);
})();
