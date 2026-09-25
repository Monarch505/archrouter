# monarch-router — PORTING (9router-fix → monarch-router)

Sumber kebenaran: `Z:\.safe-space\9router-fix\PATCH-HISTORY.md` + memori
(gate model, header spec, deploy map). Hanya yang penting & bisa dipakai.
Legenda: ✅ sudah ada di opencode-router · ❌ belum · 🔶 ada tapi kurang tepat.

## P0 (wajib, Fase 2)
| ID | Patch 9router-fix | Status kini | Kerja |
|---|---|---|---|
| P0-1 | Header exact 8 header + UA penuh (`opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14`, `x-opencode-client: cli`, `x-opencode-project: global`, `Accept` per-endpoint) | 🔶 (`opencode/1.18.18`, client `desktop`, tanpa `x-opencode-project`) | Update `lib/provider.js`: release 1.18.31, UA penuh, client `cli`, tambah `x-opencode-project: global`; `Accept: text/event-stream` untuk chat, `*/*` untuk responses. Banding 8/8 vs TEMUAN-OPCODE-REQUEST. |
| P0-2 | Gate upstream: `canonical-names ⊆ tool-names` AND `stream:true` | ❌ | `lib/router.js`: **force-stream** — request client `stream:false` → tetap kirim `stream:true` ke upstream lalu collapse jadi JSON (rollback v6.7). Tanpa ini = 403 massal. |
| P0-3 | OC_EMBED canonical-14 (stub14, anti fake-call) | ❌ | Tambah `lib/ocEmbed.js` (port `oc-stub14.json` 2209B — stub `Internal compatibility entry. Do not call.` agar lolos gate tanpa risiko tool call palsu). Union ke tool client bila ada (pola v6.8). |
| P0-4 | 403-innerOpenCode + cooldown 60s / episode 3mnt (v6.5) | 🔶 (parseError ada, tanpa cooldown) | `parseError` bedakan 403-dalam-OpenCode vs limit; tambah cooldown: 403 beruntun → jeda 60s + ganti egress (warp-a↔b) + episode guard 3mnt. Sambung ke event reset pool. |

## P1 (penting, Fase 4)
| ID | Patch | Status kini | Kerja |
|---|---|---|---|
| P1-1 | Honest-close anti-fake-`[DONE]` (v6.10) | ❌ (perlu verifikasi `lib/sse.js`+relay) | SSE relay: teruskan chunk apa adanya; abnormal end (putus tanpa `finish_reason`) → tandai interrupt + balikan error, JANGAN tulis `[DONE]` palsu; tangkap `usage`. |
| P1-2 | Reasoning primer (v6.11) | ❌ | Bila body tanpa `reasoning` → default `{effort:high, summary:auto}` (pola `rb()`). Validasi: thinking-block muncul, punt-rate turun. |
| P1-3 | Endpoint `/responses` untuk muse-spark (kerja 2557) | ❌ (hanya chat+messages) | Route baru `POST /v1/responses` → forward `/zen/v1/responses` (body Response-API, bukan chat). Butuh translator request/response (ringan, bukan full 2557). |
| P1-4 | Console log kaya (timestamp, model, proxy, status, chunks, usage, rotasi) | 🔶 (logger dasar ada) | Format log satu baris per request + event rotasi/reset; `archrouter logs --tail`. |

## P2 (opsional, Fase 6)
| ID | Patch | Catatan |
|---|---|---|
| P2-1 | `/zen/v1/systemone` + `combo/Jev` (v6.12, jev judge) | Built-in `POST /api/judge {state, questions}` passthrough systemone — judge internal tanpa MCP. |
| P2-2 | `msg_` ascending / `ses_` descending + sequencing | `lib/identifier.js` sudah port binary; verifikasi arah + urutan saja. |
| P2-3 | Sampling nondeterministik note (0.95 vs 0.96) | Dokumentasi saja: retry judge bila skor batas. |

## Yang SENGAJA tidak dibawa
- Semua provider non-opencode (tokenrouter, gemini, openai-compatible generik, dsb).
- Aliasing tool-name >64 char (masalah 2557/Claude-Code generik — tidak relevan untuk opencode-only).
- Monarcryptor / enkripsi repo (repo ini plaintext; secret hanya di `data/` + env, gitignore).
- GUI desktop (WebView2/tray) — diganti dashboard web ringan.
- `warp-cli` / PowerShell / `%APPDATA%` / `.exe` — tidak ada di Linux/Termux.
