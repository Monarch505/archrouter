# REFERENCE-SYNC — port fix dari `9router-fix` ke archrouter

> **Tujuan**: satu tempat untuk melacak fix apa dari sumber referensi
> `Z:\.safe-space\9router-fix` (PATCH-HISTORY.md = source of truth) yang sudah /
> belum dicangkok ke archrouter. Saat reference merilis fix baru (v6.13, dst.),
> checklist di bawah adalah jalur port-nya.
>
> **Aturan**: archrouter adalah fork independen (CommonJS, gaya `server/lib/*`).
> Jangan tempel mentah chunk 4574.js — pahami patch-nya lalu tulis ulang dalam
> gaya archrouter + tambah test di `server/test-p0.js`.

## Checklist port fix baru

1. Baca entri versi baru di `9router-fix/PATCH-HISTORY.md` (+ blok
   `78223.v*-block.js` bila ada) — pahami *apa yang diubah & buktinya*.
2. Diff vs archrouter: `provider.js` (header/parseError), `router.js`
   (attempt/force-stream/collapse), `ocEmbed.js` (tools gate/enrich),
   `routes/*` (endpoint).
3. Cangkok dalam gaya archrouter: komentar `P0-x` / kutipan versi reference,
   fungsi kecil & unit-testable.
4. `node server/test-p0.js` harus lulus penuh; jalankan E2E (curl via :20399).
5. Commit+push archrouter → `archrouter update` di remote → verif HEAD.
6. Update tabel di bawah + `docs-internal/TASKS.md`.

## Matriks port (reference → archrouter)

| Reference | Isi patch | archrouter | Lokasi archrouter | Bukti |
|---|---|---|---|---|
| v1 | 7 header exact + rotateIdentity + parseError 429/403 → poolScoped | ✅ | `provider.js` buildHeaders/rotateIdentity/parseError | test-p0 P0-1 |
| v6.3 | `x-opencode-request: msg_`, client default `cli`, UA Bun fallback | 🔶 | `provider.js` — session=`ses_`↓, request=`usr_`↑ (bukan `msg_`) | header P0-1 8/8; catatan: reference pakai `ocMsg` utk request header |
| v6.4 | UA fallback `provider-utils/4.0.40` | ✅ | `provider.js` uaSuffix default | test-p0 |
| v6.5 | 403-innerOpenCode: #1 egress-refresh, #2+ rotate+cooldown 60s, episode 3mnt, in-cooldown no-spin | ✅ | `provider.js` parseError + `router.js` attempt loop | test-p0 P0-4 |
| v6.6 | enrich body: union tools + defaults absent-only (max_tokens 32000, stream_options.include_usage, tool_choice auto) | ✅ | `ocEmbed.js` enrich() + `router.js` finalBody=enrich | test-p0 (13 lulus) |
| v6.7 | force-stream: client stream:false → upstream stream:true + collapse SSE → JSON | ✅ | `router.js` P0-2 + `Router.collapseSSE` | test-p0 P0-2 (reject empty = honest) |
| v6.8 | union tanpa gerbang `<75` (always union missing-canonical, client-wins) | ✅ | `ocEmbed.js` unionWith selalu jalan | test-p0 P0-3 |
| v6.9 | OC_EMBED 75 → stub14 (`oc-stub14.json`, "Do not call.") | ✅ | `ocEmbed.js` STUB_NAMES 14 | test-p0 P0-3 stub14 |
| v6.10 | honest close: upstream kosong/cut → interrupt+error, TANPA forged finish | ✅ (collapse) / 🔶 (stream) | `collapseSSE` reject empty ✅; SSE relay path `sse.js`/`chatCompletions.js` belum honest-close penuh (P1-1) | test-p0 "reject empty" |
| v6.11 | primer reasoning: effort absen → `{effort:"high",summary:"auto"}` utk responses models | ❌ | (P1-2) — hanya relevan utk /responses path | — |
| v6.12 | systemone branch: `/jev/i` → `/zen/v1/systemone`, passthrough+relay tanpa gate | 🔶 | `buildUrlFor("systemone")` ✅ tapi belum ada route/gate detect | — |
| v5–v6 | responses converter (`rb`/`rssse`) utk muse family → `/zen/v1/responses` | ❌ | (P1-3) route `/v1/responses` belum | — |

**Legend**: ✅ selesai · 🔶 sebagian · ❌ belum (terdaftar sebagai P1 di TASKS.md)

## Fakta gate upstream (terverifikasi ulang 2026-09-25)

- **Header**: `x-opencode-session` + UA lengkap (`opencode/1.18.31
  ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14`) WAJIB — tanpa keduanya
  → 403 pasti (bukan flaky). Router sudah kirim keduanya (`provider.buildHeaders`).
- **Body**: `canonical-14 ⊆ tool-names` DAN `stream:true` untuk chat biasa.
  Bukan header/size/TLS.
- **Quirk title-agent (root cause hang `pentestcode run`)**: ada kombinasi
  content × tools yang DIKONFIRMASI deterministik (bukan rate-limit):

  | content | +tools | −tools |
  |---|---|---|
  | chat biasa / tanpa system | **200** | 403 |
  | system title-agent ("You are a title generator…") | **403** | **200** |

  Jadi kedua "arah" diperlukan: chat tanpa stub → 403, title dengan stub → 403.
  403 title memicu cooldown 60–120s × attempt → melewati timeout client
  (90–150s) → tampak "hang"/EXIT:124.
- **Fix archrouter** (`router.js` GATE-FALLBACK): thin client (tools bukan
  milik klien) menyimpan `strippedBody` (tanpa tools/tool_choice); saat 403
  pertama → retry SEGERA tanpa tools, tanpa cooldown/rotate. Chat biasa lolos
  di attempt 1; title lolos di attempt 2 (~1s).
- Quirk: ada model (mis. space-bunny) lolos bahkan tanpa tools — gate
  tampaknya model-scoped; jangan jadikan alasan melepas union.
- 429 `ip-limit` = kuota egress per-IP (bukan bug router); pool reset umumnya
  ganti IP (`.130`→`.132/.133`) tapi kadang `same_ip_count` naik — kalau
  kedua instance satu IP, 429 menumpuk sampai reset berikutnya.

## Temuan / log perubahan

- 2026-09-25: scaffold dibuat; v6.6 enrich dicangkok (commit `ca788ee`).
- 2026-09-25: root cause hang `pentestcode run` ditemukan via replay snapshot
  403 (bisect content × tools, deterministik 3x) → GATE-FALLBACK dicangkok
  (commit `b15b229`); verifikasi E2E **5/5 EXIT:0** (timeout 180).
- 2026-09-25: debug snapshot body 403 dihapus (commit `1e54ac7`) — log `[gate]`
  dipertahankan utk observasi.
- Sisa: P1 (honest-close stream, primer reasoning, responses/systemone route),
  `x-opencode-request: msg_` (v6.3 🔶), deepseek-v4-flash-free mati di
  config pentestcode.
