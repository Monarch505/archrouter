# monarch-router — PORTS-AND-ENV

## 1. Port (semua BARU, hindari set Windows)
| Port | Peran | Set Windows yang dihindari |
|---|---|---|
| `20399` | archrouter API + dashboard + `/health` | 20128 (gateway), 20299 (ocrouter+OcRouter mati) |
| `11801` | warp-pool SOCKS5 (dipakai router mode `warp`) | 10801 (proxypool), 10802 (NormalProxies) |
| `11810` | sing-box warp-a SOCKS backend | 10800 (WARP win) |
| `11811` | sing-box warp-b SOCKS backend | 10800 (WARP win) |
| `9190` | pool status API (`/`, `/health`, `/api/report`) | 9090 (proxypool), 9091 (v2), 9097 |
| (tidak dipakai) | mitm 8080 — hanya dev di Windows | 8080 |

Semua bind `127.0.0.1` default; `--host` untuk LAN bila perlu (+ auth wajib bila non-loopback).

## 2. Path
| Lokasi | Linux | Termux |
|---|---|---|
| Base data | `$HOME/.archrouter` (XDG alternatif: `~/.config/archrouter` + `~/.local/share/archrouter`) | `$HOME/.archrouter` (`$HOME=/data/data/com.termux/files/home`) |
| Launcher | `~/.local/bin/archrouter` (tambah ke PATH bila belum) | `$PREFIX/bin/archrouter` (`$PREFIX=/data/data/com.termux/files/usr`) |
| SQLite | `<base>/data/archrouter.db` | sama (relatif base) |
| Logs | `<base>/data/logs/` (`router-*.log`, `pool-*.log`) | sama |
| PID files | `<base>/data/*.pid` (tanpa systemd) | sama (tanpa systemd) |
| warp-a | `<base>/warp/warp-a/` (`HOME` isolasi, `wgcf-account.toml`, `wgcf-profile.conf`, `sing-box.json`) | sama |
| warp-b | `<base>/warp/warp-b/` | sama |
| Biner | `<base>/bin/<arch>/` (`wgcf`, `sing-box`) | sama, arch `android-arm64` |
| API key dkk | `<base>/.env` (gitignore; `ARCHROUTER_KEY`, `WARP_LICENSE` opsional) | sama |

## 3. Dependensi target
| Butuh | Linux | Termux |
|---|---|---|
| Node.js ≥ 22 (`node:sqlite`) | distro package / nodejs.org | `pkg install nodejs` (cek versi; bila <22 → fallback JSON store, D6) |
| `wgcf` | unduh rilis `linux-amd64` saat install | unduh rilis `android-arm64` saat install |
| `sing-box` | unduh rilis `linux-amd64` | unduh rilis `android-arm64` |
| root / tun | **tidak perlu** (sing-box userspace) | **tidak perlu** |
| systemd | opsional (user unit disediakan, default: nohup+pidfile) | tidak ada → nohup+pidfile (+ `termux-wake-lock` opsional) |
| Go / cargo / build tool | **tidak perlu** di target (biner prebuilt) | sama |

## 4. Variabel env (`.env`, jangan commit)
```
ARCHROUTER_PORT=20399
ARCHROUTER_HOST=127.0.0.1
ARCHROUTER_KEY=isi-bebas-untuk-client-lokal   # opsional, default permissive-loopback
ARCHROUTER_MODE=warp                          # none|warp
WARP_LICENSE=(opsional, Warp+ dari app 1.1.1.1 → bind ke akun wgcf bila mau plus)
```

## 5. Cek konflik saat install (`doctor` + install.sh)
`ss -ltn` untuk 20399/11801/11810/11811/9190; bila terisi → tawarkan `--port-base` offset
atau abort dengan pesan jelas. JANGAN diam-diam pilih port acak.
