# monarch-router — PLAN (master)

## 1. Tujuan
Satu aplikasi compact, plug-and-play, untuk **Linux dan Termux**, satu perintah runnable:
`archrouter`. Isinya: opencode-router (hanya model opencode, bukan semua provider 9router)
+ proxy-pool + warpy-pool (diadopsi metodenya, **tanpa** GUI desktop) + patch fix penting
dari 9router-fix. Windows **nanti dulu** — semua path/env/port ditulis untuk Linux/Termux.

## 2. Sumber yang dipakai
| Sumber | Yang diambil |
|---|---|
| `Z:\.safe-space\opencode-router` (Node, zero-dep) | Basis kode: server, router, provider, proxyPool, combos, SQLite store, dashboard. Tinggal dilanjut + ditambal (belum selesai). |
| `Z:\.safe-space\9router-fix` (patch v6.3→v6.12 + jev) | Hanya patch penting (lihat `PORTING.md`). Bukan semua provider. |
| `Z:\TailScale-Mod\Monarch\proxypool` (Go, Windows) | **Metode** warpy-pool: pool SOCKS5, reset coordinator (mutex+cooldown+active probe), 3 jalur deteksi (log/router-event, health probe, `/api/report`). Diimplementasi ulang slim di Node — bukan port GUI. |

## 3. Non-goals (tegas)
- Bukan semua provider 9router — **hanya opencode** (`opencode.ai/zen/v1`).
- Bukan aplikasi desktop — tanpa WebView2/tray/window. CLI + dashboard web saja.
- Bukan Windows — path `%APPDATA%`, `warp-cli`, `.exe`, PowerShell tidak dipakai.
- Bukan fork vansrouter/9router — standalone, tidak menyentuh installasi lama.

## 4. Keputusan arsitektur (proposed → konfirmasi)
| # | Keputusan | Alasan |
|---|---|---|
| D1 | Runtime tetap **Node.js** (port opencode-router), bukan Go | Kode basis sudah Node zero-dep; Termux `pkg install nodejs` ready; pool/coordinator ditulis ulang slim di Node (~300 baris, bukan 38KB Go). |
| D2 | Backend WARP = **sing-box per instance** (userspace, tanpa root) | `warp-cli` butuh systemd/dbus (mati di Termux/minimal Linux). `wgcf` hanya generate config; yang jalan sebagai SOCKS backend adalah sing-box dengan outbound WireGuard-WARP — tanpa butuh interface tun/root. |
| D3 | **2 instance WARP terisolasi** (`warp-a/`, `warp-b/`) | Masing-masing: HOME sendiri, `wgcf-account.toml` sendiri, `sing-box.json` sendiri, port SOCKS sendiri. Reset satu instance → satunya tetap serve (zero-downtime, sama seperti desain Windows). Ini pengganti "cargo/env isolasi". |
| D4 | Satu perintah `archrouter` (bash launcher) | Subcommand: `start|stop|restart|status|logs|warp-setup|warp-reset [a|b]|doctor`. Atur PATH saat install (`~/.local/bin` atau `$PREFIX/bin`). |
| D5 | Blok port baru, tidak tabrakan Windows (lihat `PORTS-AND-ENV.md`) | API 20399, pool SOCKS 11801, warp 11810/11811, status 9190. |
| D6 | `node:sqlite` dipertahankan, fallback JSON | `node:sqlite` butuh Node ≥ 22. Jika Termux hanya sediakan Node lama → fallback file JSON (store.js dibuat pluggable sejak awal). |
| D7 | Dashboard web tetap ada (single `index.html`) | Dipangkas: monitor + pool + log + config. Tanpa Settings tab desktop. |

## 5. Fase kerja
| Fase | Isi | Output |
|---|---|---|
| 0 | Rencana ini (dokumen) | `PLAN.md`, `ARCHITECTURE.md`, `PORTING.md`, `PORTS-AND-ENV.md`, `TASKS.md` ✅ sekarang |
| 1 | Skeleton + launcher + install | `archrouter`, `install.sh`, tree dir, `doctor` cek env |
| 2 | Port opencode-router → `server/` + patch P0 | Header exact, force-stream, OC_EMBED-14, 403-cooldown |
| 3 | Warp pool (`warp-a/b`, sing-box, coordinator slim) | `archrouter warp-setup`, pool SOCKS 11801, `/api/report` |
| 4 | Patch P1 + dashboard ramping | Honest-close, reasoning primer, `/v1/responses`, log console |
| 5 | E2E di Linux + Termux | Matriks uji, `TASKS.md` dicentang, rilis paket |
| 6 | Opsional (P2) | Built-in judge (`/api/judge` via systemone), packaging lanjutan |

## 6. Yang perlu konfirmasi darimu (3 hal)
1. Blok port usulan (20399/11801/11810/11811/9190) — OK atau mau angka lain? (9190)
2. Runtime Node (pakai basis opencode-router) — OK, atau mau full Go? (Node)
3. Dashboard: pangkas ringan (rekomendasi) atau bawa penuh seperti `web/index.html` sekarang? (pangkas ringan)
