# monarch-router — TASKS (checklist fase)

## Fase 0 — Rencana ✅
- [x] `PLAN.md`, `ARCHITECTURE.md`, `PORTING.md`, `PORTS-AND-ENV.md`, `TASKS.md`
- [x] Keputusan locked (2026-09-22): port OK apa adanya (20399/11801/11810/11811/9190),
      runtime Node, dashboard pangkas ringan. Target uji sementara: WSL Debian
      (`wsl -d debian`); Termux belakangan. Catatan: WSL networking=None
      (mirrored gagal 0x8007054f) → provision offline via Windows, E2E upstream
      menunggu network WSL diperbaiki user.

## Fase 1 — Skeleton + launcher + install ✅ (2026-09-22, tested WSL Debian)
- [x] Tree dir sesuai ARCHITECTURE §2 (+ `.gitignore`: `data/`, `.env`, `bin/`)
- [x] `archrouter` (bash): `start|stop|restart|status|logs|warp-setup|warp-reset [a|b]|doctor|version`
- [x] `install.sh`: deteksi Linux/Termux (`$PREFIX`), arch (`x86_64`/`aarch64`), cek `node -v`,
      unduh wgcf+sing-box ke `bin/`, symlink launcher, tulis `.env` contoh
- [x] `doctor`: node OK, port bebas (20399/11801/11810/11811/9190), biner ada+x, warp akun ada
- [x] Deploy ke WSL `~/monarch-router`, syntax OK, doctor jalan (5 ok / 8 problem = expected pre-Fase 2/3)
- [x] Node v22.23.2 provisioned offline (`~/.local/node` + symlink `~/.local/bin`), `node:sqlite` OK

## Fase 2 — Server + patch P0 ✅ (2026-09-22, tested WSL Debian)
- [x] Port `opencode-router/server.js + lib/ + routes/ + web/` → `server/`
- [x] P0-1 header exact 8/8 (release 1.18.31, UA penuh, `cli`, `x-opencode-project: global`)
- [x] P0-2 force-stream (client `stream:false` → upstream `stream:true` + collapse via `collapseSSE`)
- [x] P0-3 `lib/ocEmbed.js` stub14 exact (14 nama dari oc-stub14.json) + union client-wins
- [x] P0-4 403-cooldown (60s + episode 3mnt + streak backoff) + `reportLimit` wiring tetap
- [x] `store.js` DB → `<base>/data/archrouter.db`; config defaults port 20399 + blok `proxy.warp`
- [x] Uji: `server/test-p0.js` 8/8 lolos; boot WSL `/health` 200; POST chat → honest 502
      (`EAI_AGAIN`, no-network expected); log OC_EMBED + force-stream OK; DB di
      `~/.archrouter/data/`, repo bersih. Catatan: `Copy-Item` multi-path ke UNC
      tidak reliabel — copy satu file per perintah. `pkill -f` pola harus di call
      terpisah (self-match kill shell bila satu command mengandung string target).

## Fase 3 — Warp pool ✅ (2026-09-22, E2E WSL Debian lolos)
- [x] Bins `wgcf v2.3.0` + `sing-box v1.14.1`; `wgcf register` ×2 (Windows);
      `wgcf generate` → profile; `pool/gen-singbox.js` (resep final: IPv4-only,
      MTU 1420, hostname endpoint, `reserved [0,0,0]` — device-ID-derived TIDAK
      handshake di sing-box; IPv6/dual-stack juga gagal)
- [x] `pool/pool.js`: RR, health probe (FIX TLS+SNI wrap — custom
      createConnection bypass TLS implisit), coordinator (mutex+cooldown 30s+
      verify), status `/` + `/health` + `POST /api/report`, crash-handler
      (log FATAL sblm exit)
- [x] `archrouter` launcher: `start` full stack (warp-a/b → pool → router via
      setsid, pidfile per proses), `stop`, `status`, `warp-setup` (idempotent,
      `--force` bila re-register), `warp-reset [a|b]` (hook koordinator)
- [x] E2E: warp-a `104.28.245.124` warp=on, warp-b `104.28.204.161` warp=on,
      pool RR OK, kill warp-a → failover warp-b, `archrouter warp-reset a` OK,
      router `--mode warp` chat `oc/mimo-v2.5-free` → 200 via WARP
- [x] `.wslconfig` NAT sementara → **mirrored dikembalikan 2026-09-22**
      (backup `.wslconfig.bak-2026-09-22`; `wsl --shutdown`; verif: NET:200,
      IP publik `103.120.170.102`, WSL→host `127.0.0.1:20128` reachable).
      Catatan NAT-mode: handshake wg hanya jalan di NAT (mirrored difilter
      host Cloudflare One); pool/router/setsid/pidfile/killproc/warp-status
      scripts teruji di NAT. Di mirrored, stack WSL berhenti (expected) —
      deploy docel pakai `warp-setup` + `start` ulang.

## Termux (HP) — record deploy 2026-09-24
- [x] SSH `u0_a275@<dhcp-ip> -p 8022` (pass nethunter; IP roaming: .116 → .102 → .30)
- [x] Node v26.4.0 via `pkg install nodejs` + `node:sqlite` OK (abaikan `apt full-upgrade` gantung — lock dpkg, jangan kill session SSH)
- [x] Repo 37 file → `~/monarch-router`; bins `~/.archrouter/bin/aarch64` (wgcf linux-arm64 static + sing-box android-arm64 v1.14.1)
- [x] `wgcf register` GAGAL di HP (Go resolver pakai `[::1]:53` refused) → register di Windows + upload `wgcf-account.toml` + `wgcf-profile.conf`
- [x] `gen-singbox.js` resolve peer hostname → IPv4 literal saat generate (`peer=162.159.192.1`); tanpa blok `dns` (1.14 FATAL detour)
- [x] Router `mode=none` jalan: `/health` ok, 80 models, E2E `oc/mimo-v2.5-free` → 200 direct
- [ ] BLOCKER warp pool di HP: jaringan seluler/AP filter SEMUA UDP egress (2408/500/53 SILENCE, TCP ok) → handshake WireGuard mustahil. Solusi: pool direct-fallback + `--auto-reset` (di bawah); pool warp aktif otomatis di jaringan yang lolos UDP

## Fase 4 — Patch P1 + dashboard
- [ ] P1-1 honest-close SSE (tanpa `[DONE]` palsu, usage tertangkap)
- [ ] P1-2 reasoning primer (default effort high + summary auto)
- [ ] P1-3 route `POST /v1/responses` → `/zen/v1/responses` (translator ringan)
- [ ] P1-4 log console kaya + `archrouter logs`
- [ ] Dashboard pangkas: status, pool, log (SSE), config, test box
- [ ] Uji: muse-spark via `/v1/responses` 200; thinking-block muncul di log

## Fase 5 — E2E Linux + Termux
- [ ] Matriks: {Ubuntu/Debian, Termux} × {direct, warp} × {chat stream/non-stream, messages, responses, models}
- [ ] 24 jam soak: pantau reset count, success rate, same-IP, episode-cooldown tidak macet
- [ ] Paket rilis: `install.sh` satu perintah dari repo bersih

## Fase 6 — Opsional (P2)
- [ ] `POST /api/judge` via systemone (`combo/Jev`)
- [ ] Verifikasi `identifier.js` (arah msg_/ses_ + sequencing)
- [ ] Packaging lanjutan (systemd unit, termux service script)
