"use strict";
/*
 * transport.js — minimal HTTP/HTTPS client supporting:
 *   - direct requests
 *   - HTTP forward proxy via CONNECT tunneling (no external deps)
 *
 * Returns { status, statusText, headers, body (Buffer|string), text(), stream() }
 * For stream() the caller consumes node's IncomingMessage (Readable).
 */

const http = require("http");
const https = require("https");
const tls = require("tls");
const net = require("net");

function parseUrl(url) {
  const u = new URL(url);
  return {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
    path: u.pathname + u.search,
    host: u.host,
  };
}

function writeRequest(req, body) {
  if (body == null) {
    req.end();
    return;
  }
  if (Buffer.isBuffer(body) || typeof body === "string") {
    req.end(body);
    return;
  }
  body.pipe(req);
}

function doRequest({ target, method, headers, body, proxy, proxyStyle = "tunnel", timeoutMs = 120000, signal }) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error("aborted"), { aborted: true }));
    const timer = setTimeout(() => {
      try { req.destroy(); } catch {}
      reject(Object.assign(new Error("request timeout"), { timeout: true }));
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) return reject(Object.assign(new Error("aborted"), { aborted: true }));
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    let req;
    if (proxy) {
      const p = parseUrl(proxy);
      if (proxyStyle === "forward") {
        // HTTP forward proxy: absolute-URI form. The proxy (e.g. the running
        // NormalProxies pool) selects its own upstream proxy and buffers the
        // whole response before returning it.
        const forwardHeaders = { ...headers, Host: target.host };
        req = http.request({
          host: p.hostname,
          port: p.port,
          method,
          path: `/${target.protocol}//${target.host}${target.path}`,
          headers: forwardHeaders,
          timeout: timeoutMs,
        });
        req.on("response", (resp) => {
          cleanup();
          resolve({
            status: resp.statusCode || 0,
            statusText: resp.statusMessage || "",
            headers: resp.headers,
            text: () => collectBody(resp, false),
            stream: () => resp,
          });
        });
        req.on("error", (err) => { cleanup(); reject(err); });
        writeRequest(req, body);
      } else if (proxyStyle === "socks5") {
        // SOCKS5 proxy (e.g. archrouter warp-pool :11801). Raw TCP → no-auth
        // handshake → CONNECT target → TLS when https, plain when http.
        const sock = net.connect(p.port, p.hostname);
        sock.setTimeout(timeoutMs);
        const fail = (err) => { cleanup(); try { sock.destroy(); } catch {} reject(err); };
        sock.once("error", fail);
        sock.once("timeout", () => fail(Object.assign(new Error("socks5 connect timeout"), { timeout: true })));
        sock.once("connect", () => {
          sock.write(Buffer.from([0x05, 0x01, 0x00]));
          let stage = 0, buf = Buffer.alloc(0);
          sock.on("data", (c) => {
            buf = Buffer.concat([buf, c]);
            if (stage === 0 && buf.length >= 2) {
              if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error("socks5 auth rejected"));
              stage = 1;
              buf = Buffer.alloc(0);
              const host = Buffer.from(target.hostname, "utf8");
              sock.write(Buffer.concat([
                Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host,
                Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
              ]));
            } else if (stage === 1 && buf.length >= 10) {
              if (buf[1] !== 0x00) return fail(Object.assign(new Error(`socks5 CONNECT failed rep=${buf[1]}`), { statusCode: buf[1] }));
              sock.removeAllListeners("data");
              sock.removeListener("error", fail);
              if (target.protocol === "https:") {
                const tlsSocket = tls.connect({ socket: sock, servername: target.hostname, rejectUnauthorized: false });
                req = https.request({ createConnection: () => tlsSocket, method, hostname: target.hostname, port: 443, path: target.path, headers });
              } else {
                req = http.request({ createConnection: () => sock, method, hostname: target.hostname, port: target.port, path: target.path, headers });
              }
              req.on("response", (resp) => {
                cleanup();
                resolve({
                  status: resp.statusCode || 0,
                  statusText: resp.statusMessage || "",
                  headers: resp.headers,
                  text: () => collectBody(resp, false),
                  stream: () => resp,
                });
              });
              req.on("error", (err) => { cleanup(); reject(err); });
              writeRequest(req, body);
            }
          });
        });
      } else {
        const connectPath = `${target.hostname}:${target.port}`;
        const connectReq = http.request({
          host: p.hostname,
          port: p.port,
          method: "CONNECT",
          path: connectPath,
          headers: { Host: connectPath },
          timeout: timeoutMs,
        });
        connectReq.on("connect", (res, socket) => {
          if (res.statusCode !== 200) {
            cleanup();
            const err = Object.assign(new Error(`proxy CONNECT failed: ${res.statusCode}`), { statusCode: res.statusCode });
            socket.destroy();
            return reject(err);
          }
          const tlsSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: false });
          const secureReq = https.request({
            createConnection: () => tlsSocket,
            method,
            hostname: target.hostname,
            port: 443,
            path: target.path,
            headers,
          });
          req = secureReq;
          secureReq.on("response", (resp) => {
            cleanup();
            resolve({
              status: resp.statusCode || 0,
              statusText: resp.statusMessage || "",
              headers: resp.headers,
              text: () => collectBody(resp, false),
              stream: () => resp,
            });
          });
          secureReq.on("error", (err) => { cleanup(); reject(err); });
          writeRequest(secureReq, body);
        });
        connectReq.on("error", (err) => { cleanup(); reject(err); });
        connectReq.on("timeout", () => { cleanup(); reject(Object.assign(new Error("proxy connect timeout"), { timeout: true })); });
        connectReq.end();
      }
    } else {
      const mod = target.protocol === "https:" ? https : http;
      const opt = {
        method,
        hostname: target.hostname,
        port: target.port,
        path: target.path,
        headers,
      };
      req = mod.request(opt, (resp) => {
        cleanup();
        resolve({
          status: resp.statusCode || 0,
          statusText: resp.statusMessage || "",
          headers: resp.headers,
          text: () => collectBody(resp, false),
          stream: () => resp,
        });
      });
      req.on("error", (err) => { cleanup(); reject(err); });
      writeRequest(req, body);
    }
  });
}

function collectBody(stream, json) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (json) {
        try { resolve(JSON.parse(buf.toString("utf8"))); }
        catch (e) { reject(Object.assign(new Error(`invalid JSON: ${e.message}`), { raw: buf.toString("utf8") })); }
      } else {
        resolve(buf.toString("utf8"));
      }
    });
    stream.on("error", reject);
  });
}

function request({ url, method = "GET", headers = {}, body, proxy, proxyStyle = "tunnel", timeoutMs = 120000, json = false, signal }) {
  const target = parseUrl(url);
  return doRequest({ target, method, headers, body, proxy, proxyStyle, timeoutMs, signal }).then(async (resp) => {
    resp.body = await resp.text();
    if (json && resp.body) {
      try { resp.json = JSON.parse(resp.body); }
      catch { resp.json = null; }
    }
    return resp;
  });
}

module.exports = { request, doRequest, parseUrl };
