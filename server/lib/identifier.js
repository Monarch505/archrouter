"use strict";
/*
 * identifier.js — exact port of the opencode.exe ID generator
 * (extracted from binary opencode v1.18.18, byte ~151959460).
 *
 * Original binary flow:
 *   cI = {session:"ses", message:"msg", permission:"per", user:"usr", part:"prt", pty:"pty"}, Dje = 26
 *   ascending(r)  = iR(r,false,r)   -> Lje(e, false)
 *   descending(r) = iR(r,true,r)    -> Lje(e, true)
 *   Lje(e,t): ts=Date.now(); if(ts!==rR){rR=ts;O_=0}; O_+=1
 *             i=BigInt(ts)*4096n+BigInt(O_); t&&(i=~i)
 *             s=new Uint8Array(6); s[o]=Number(i>>BigInt(40-8*o)&255n)
 *             return cI[e]+"_"+Aje(s)+Pje(Dje-12)
 *   Aje(s): lowercase hex per byte (padStart 2)
 *   Pje(n): 14 base62 chars from crypto.getRandomValues
 */

const PREFIX = { session: "ses", message: "msg", permission: "per", user: "usr", part: "prt", pty: "pty" };
const SUFFIX_LEN = 26;
const RAND_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastTs = 0;
let counter = 0;

function randomBase62(n) {
  const rand = new Uint8Array(n);
  if (typeof globalThis !== "undefined" && globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(rand);
  } else {
    for (let i = 0; i < n; i++) rand[i] = Math.floor(Math.random() * 256);
  }
  let s = "";
  for (let i = 0; i < n; i++) s += RAND_CHARS[rand[i] % 62];
  return s;
}

function toHex(buf) {
  let s = "";
  for (let i = 0; i < buf.length; i++) s += buf[i].toString(16).padStart(2, "0");
  return s;
}

function create(prefix, descending, opts = {}) {
  const ts = opts.time != null ? opts.time : Date.now();
  let c;
  if (opts.counter != null) {
    c = opts.counter;
  } else {
    if (ts !== lastTs) { lastTs = ts; counter = 0; }
    counter += 1;
    c = counter;
  }
  let v = BigInt(ts) * 4096n + BigInt(c);
  if (descending) v = ~v;
  const buf = new Uint8Array(6);
  for (let i = 0; i < 6; i++) buf[i] = Number(v >> BigInt(40 - 8 * i) & 255n);
  return PREFIX[prefix] + "_" + toHex(buf) + randomBase62(SUFFIX_LEN - 12);
}

module.exports = {
  create,
  ascending: (r, opts) => create(r, false, opts),
  descending: (r, opts) => create(r, true, opts),
  PREFIX,
  SUFFIX_LEN,
};
