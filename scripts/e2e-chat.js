"use strict";
// scripts/e2e-chat.js — one-shot chat completion check against local router.
// Usage: node e2e-chat.js [--host 127.0.0.1] [--port 20399] [--model oc/mimo-v2.5-free] [--prompt "..."]
const http = require("http");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const host = arg("host", "127.0.0.1");
const port = Number(arg("port", "20399"));
const model = arg("model", "oc/mimo-v2.5-free");
const prompt = arg("prompt", "jawab dengan tepat satu kata: e2e-ok");

const body = JSON.stringify({
  model,
  messages: [{ role: "user", content: prompt }],
  max_tokens: 8,
  stream: false,
});

const req = http.request({
  host, port, path: "/v1/chat/completions", method: "POST",
  headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
}, (r) => {
  let s = "";
  r.on("data", (c) => { s += c; });
  r.on("end", () => {
    console.log(`STATUS:${r.statusCode}`);
    try {
      const d = JSON.parse(s);
      const content = d.choices && d.choices[0] && d.choices[0].message
        ? d.choices[0].message.content : "";
      console.log(`CONTENT:${JSON.stringify(String(content).slice(0, 200))}`);
      console.log(`USAGE:${JSON.stringify(d.usage || null)}`);
    } catch {
      console.log(`RAW:${s.slice(0, 300)}`);
    }
  });
});
req.on("error", (e) => { console.log(`ERR:${e.message}`); process.exit(1); });
req.setTimeout(150000, () => { console.log("ERR:timeout"); req.destroy(); });
req.end(body);
