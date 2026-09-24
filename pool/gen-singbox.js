"use strict";
/*
 * gen-singbox.js — build sing-box.json for one warp instance from its
 * wgcf-profile.conf + wgcf-account.toml.
 * Usage: node gen-singbox.js <instance-dir> <socks-port>
 * Writes <instance-dir>/sing-box.json. No network needed.
 *
 * reserved[] = [0,0,0]. Device-ID-derived reserved NEVER completes the
 * handshake in sing-box (proven WSL 2026-09-22: kernel wg handshakes fine
 * with any reserved, but sing-box needs [0,0,0] + IPv4-only + MTU 1420).
 * reservedFromDeviceId kept for reference only.
 */
const fs = require("fs");
const path = require("path");

function parseIni(text) {
  const out = {};
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const mSec = line.match(/^\[(.+)\]$/);
    if (mSec) { section = mSec[1]; out[section] = out[section] || {}; continue; }
    const eq = line.indexOf("=");
    if (eq > 0 && section) out[section][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function parseTomlSimple(text, key) {
  const m = text.match(new RegExp(`^${key}\\s*=\\s*['"]([^'"]+)['"]`, "m"));
  return m ? m[1] : null;
}

function reservedFromDeviceId(deviceId) {
  const hex = String(deviceId || "").replace(/-/g, "");
  if (!/^[0-9a-fA-F]{6,}$/.test(hex)) throw new Error(`bad device_id: ${deviceId}`);
  const out = [];
  for (let i = 0; i < 6; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

async function main() {
  const [dir, portStr] = process.argv.slice(2);
  if (!dir || !portStr) { console.error("usage: node gen-singbox.js <instance-dir> <socks-port>"); process.exit(1); }
  const port = Number(portStr);
  const profile = parseIni(fs.readFileSync(path.join(dir, "wgcf-profile.conf"), "utf8"));
  const iface = profile.Interface || {};
  const peer = profile.Peer || {};
  if (!iface.PrivateKey || !peer.PublicKey) throw new Error("profile missing PrivateKey/PublicKey");
  const endpoint = peer.Endpoint || "engage.cloudflareclient.com:2408";
  const [server, serverPort] = endpoint.split(":");
  // Termux has no local stub DNS ([::1]:53 refused): sing-box may ignore
  // dns.servers when resolving the wg peer hostname. Prefer a literal IPv4
  // when the hostname resolves at generate time (build box CAN resolve);
  // fall back to the hostname (WSL has a working stub anyway).
  let peerAddr = server;
  if (!/^[\d.]+$/.test(server)) {
    try {
      const addr = await require("dns").promises.lookup(server, { family: 4 });
      if (addr && addr.address) peerAddr = addr.address;
    } catch { /* keep hostname */ }
  }
  // Proven recipe (WSL 2026-09-22): IPv4-only, MTU 1420, hostname endpoint,
  // reserved [0,0,0]. Device-ID-derived reserved NEVER handshakes in sing-box.
  // Chroot/Android fix: no default route in the main table → sing-box can't
  // auto-detect egress ("missing default interface" / "network unreachable").
  // ARCHROUTER_NET_IF pins it (e.g. wlan0). ARCHROUTER_WG_PORT overrides the
  // peer port (default 2408 from wgcf profile; Cloudflare also answers
  // 500/4500 — useful when an ISP filters 2408).
  const bindIf = (process.env.ARCHROUTER_NET_IF || "").trim();
  const wgPort = Number(process.env.ARCHROUTER_WG_PORT || serverPort || 2408);
  const addresses = ["172.16.0.2/32"];
  const cfg = {
    log: { level: "warning", output: path.join(dir, "sing-box.log") },
    // DNS through the tunnel: WARP answers 1.1.1.1 inside the tunnel, so
    // client hostnames (opencode.ai, api.ipify.org) resolve once the
    // handshake completes. The route rule steers 1.1.1.1 via warp-ep (no
    // detour field → avoids 1.14 "detour to an empty direct outbound"
    // FATAL). Peer stays a literal IPv4 → handshake needs zero DNS.
    // (No `address_resolver` needed: 1.1.1.1 is a literal IP.)
    dns: {
      servers: [{ tag: "cf", address: "1.1.1.1" }],
      final: "cf",
    },
    inbounds: [{ type: "socks", tag: "socks-in", listen: "127.0.0.1", listen_port: port }],
    outbounds: [{ type: "direct", tag: "direct" }],
    endpoints: [{
      type: "wireguard",
      tag: "warp-ep",
      address: addresses,
      private_key: iface.PrivateKey,
      peers: [{
        address: peerAddr,
        port: wgPort,
        public_key: peer.PublicKey,
        allowed_ips: ["0.0.0.0/0"],
        reserved: [0, 0, 0],
      }],
      mtu: 1420,
      // empty = auto-detect (normal Linux); set ARCHROUTER_NET_IF on
      // chroot/Android where the main table has no default route.
      ...(bindIf ? { bind_interface: bindIf } : {}),
    }],
    // All inbound traffic exits via the WARP endpoint (sing-box >= 1.13 schema;
    // legacy wireguard-outbound was removed — verified against official docs).
    route: { rules: [], final: "warp-ep", ...(bindIf ? { default_interface: bindIf } : {}) },
  };
  const outPath = path.join(dir, "sing-box.json");
  fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`wrote ${outPath} (peer=${peerAddr} reserved=[${cfg.endpoints[0].peers[0].reserved}])`);
}

main();
