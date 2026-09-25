# monarch-router — ARCHITECTURE

## 1. Alur data
```
[CLIENT: opencode CLI / Kimi / Cline]
   │  POST :20399/v1/chat/completions  (OpenAI)
   │  POST :20399/v1/messages          (Anthropic)
   │  POST :20399/v1/responses         (✅ P1-3, untuk muse-spark)
   │  GET  :20399/                     (dashboard)
   ▼
[archrouter API :20399]  (Node, port dari opencode-router server.js)
   │  [1] resolve model (strip oc/, combos)
   │  [2] sanitasi (assistant kosong → 400 reasoning) + force-stream + OC_EMBED-14
   │  [3] header exact opencode.exe (lihat PORTING.md P0-1)
   │  [4] pilih egress: direct | warp-pool (:11801)
   ▼
[warp-pool SOCKS5 :11801]  (Node slim, adopsi metode warpy-pool)
   │  round-robin → warp-a :11810 | warp-b :11811
   │  deteksi: router-event (429/limit) + health probe + POST :9190/api/report
   │  reset: re-register instance yg kena (HOME isolasi) → verify → serve lagi
   ▼
[sing-box warp-a :11810]  [sing-box warp-b :11811]
   │  outbound WireGuard → engage.cloudflare.com:2408 (WARP)
   │  config dari `wgcf generate`, akun dari `wgcf register` per-instance
   ▼
[opencode.ai/zen/v1]  → 200 SSE → relay jujur ke client (honest-close, P1)
```

## 2. Struktur direktori (target)
```
monarch-router/
├── PLAN.md  ARCHITECTURE.md  PORTING.md  PORTS-AND-ENV.md  TASKS.md
├── archrouter                 # launcher bash (start/stop/status/logs/warp-*/doctor)
├── install.sh                 # deteksi Linux/Termux, cek node, unduh bin, warp-setup, PATH
├── server/                    # port opencode-router (Node zero-dep, opencode-only)
│   ├── server.js              # entry (dipanggil launcher)
│   ├── lib/                   # provider.js identifier.js transport.js router.js
│   │                          # proxyPool.js(+warp mode) sse.js anthropic.js
│   │                          # models.js store.js configStore.js requestLog.js logger.js
│   ├── routes/                # chatCompletions.js messages.js responses.js(✅ P1-3)
│   │                          # models.js dashboard.js
│   └── web/index.html         # dashboard pangkas
├── pool/                      # warp-pool slim (Node): pool.js coordinator.js health.js api.js
├── warp/
│   ├── warp-a/                # HOME isolasi: wgcf-account.toml wgcf-profile.conf sing-box.json
│   └── warp-b/                # (sama, akun + port berbeda)
├── bin/
│   ├── linux-x64/             # wgcf, sing-box (prebuilt)
│   └── android-arm64/         # wgcf, sing-box (prebuilt, Termux)
└── data/                      # sqlite (proxies/combos/settings), logs/, pidfiles (runtime, gitignore)
```

## 3. Komponen vs sumber
| Komponen | Dari | Kerja baru |
|---|---|---|
| `server/` | opencode-router 90% | Patch P0/P1 (PORTING.md), mode `warp`, rapi path Linux |
| `pool/` | metode proxypool (`pool.go`+`coordinator.go`) | Tulis ulang slim Node: round-robin, cooldown, active-probe, `/api/report`, status `:9190` |
| `warp-*/` | `wgcf register/generate` | Isolasi HOME+port per instance, template `sing-box.json` |
| `archrouter`+`install.sh` | baru | Launcher + installer + `doctor` |
| `bin/` | release upstream wgcf/sing-box | Unduh saat install (bukan commit biner) |

## 4. Reset coordinator (slim, Node)
Satu mutex + cooldown (default 30s) + active-probe (default timeout 5s).
Sumber reset: (a) router lapor 429/limit via event internal, (b) health probe gagal
3x beruntun (~90s), (c) `POST :9190/api/report {"event":"freeusagelimit"}`.
Reset = `wgcf` re-register akun instance tsb (atau putar key) → restart sing-box-nya
→ probe `https://api.ipify.org` via SOCKS-nya → catat event + IP baru.
Instance lain tidak disentuh → zero-downtime.

## 5. Prinsip compact
Satu repo, satu perintah, nol service eksternal wajib. Yang opsional (systemd unit,
termux-services, API key global) tetap opsional. Default jalan dengan
`./install.sh && archrouter warp-setup && archrouter start`.
