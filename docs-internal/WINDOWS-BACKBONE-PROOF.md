# WINDOWS-BACKBONE-PROOF — 2 akun WARP, IP berbeda, di satu mesin Windows

> Status per **2026-09-30**: **LULUS (PASS)**. Semua angka di bawah hasil pengukuran nyata
> di mesin ini (Windows, native — bukan WSL, bukan Docker).
> Skrip pengukuran: `scripts/warp-ip-matrix.ps1` (terarsip, bisa dijalankan ulang).

## 1. Ringkasan

Backbone yang diminta — **dua akun WARP dengan IP publik berbeda, pada level IPv4 yang sama,
di satu mesin Windows** — terbukti bekerja, dengan mekanisme yang terukur dan bukan asumsi.

| Kriteria | Hasil |
|---|---|
WARP userspace jalan native Windows (tanpa TUN, tanpa admin) | ✅ `ip=104.28.215.130` dari kedua lane |
`wgcf register` + `generate` native Windows | ✅ 2 akun terdaftar (12:20:09 & 12:20:21) |
`pool/gen-singbox.js` **tanpa diubah** → config valid | ✅ `sing-box check` exit 0 |
Dua lane IPv4 dengan **IP berbeda** | ✅ `a=104.28.219.241` `b=104.28.215.130` |
Guard konvergensi (bounce sampai beda) | ✅ **6/6 trial**, tries `1,3,5,1,1,2` (avg **2,17**, max 5) |
`pool.js` jalan di Windows, `ip_conflict=false` | ✅ `:9190` → `parked=[]` |
Router `mode=warp` → pool → WARP → upstream | ✅ mencapai upstream (HTTP **429** = kuota upstream, bukan wiring) |

## 2. Environment

| Item | Nilai |
|---|---|
OS | Windows native, `PROCESSOR_ARCHITECTURE=AMD64` / `OSArchitecture=X64` |
Node | v24.19.0, `node:sqlite` **OK** (syarat server terpenuhi) |
Shell | PowerShell 7.6.6, admin tersedia (tapi **tidak dipakai** — semua hanya loopback) |
Port spike | warp `12810`/`12811`, pool `11801`, status `9190`, router `21399` (loopback) |
Excluded port range | hanya `50000-50059` → port spike aman |
Colo WARP | **SIN** (dari `cdn-cgi/trace`) |

### Binary (native Windows, tanpa Docker)

| File | SHA256 | Verifikasi |
|---|---|---|
`wgcf_2.3.0_windows_amd64.exe` | `5c633e265fb969c9507b68b39c5b0762e39181ce9f578ab66cb3b4edb0696ef5` | `wgcf --help` exit 0 |
`sing-box 1.14.1 windows-amd64` (`sing-box.exe`) | `b838de45bd0b2e6ddbed1977e4745622f7dffab3b293807ff4c6b1b640fed909` | `sing-box version` → 1.14.1 |

## 3. Yang TIDAK perlu diubah (hasil penting)

`pool/gen-singbox.js` dipakai **apa adanya** di Windows dan langsung sah:

```
inbound=127.0.0.1:12810   final=warp-ep
peer=162.159.192.1:2408   mtu=1420   reserved=0,0,0   addresses=172.16.0.2/32
```

Jadi **resep sing-box yang sudah terbukti (IPv4-only, `reserved [0,0,0]`, tanpa blok `dns`,
`bind_interface` hanya untuk chroot/Android) portabel ke Windows tanpa modifikasi.**

## 4. Pengukuran distinctness (inti)

Skrip: `scripts/warp-ip-matrix.ps1`. Probe memakai IP-literal + `socks5://` (DNS lokal) supaya
tidak bergantung pada resolver di dalam tunnel.

### Fase A — start serempak (a & b tanpa jeda)

| trial | ip_a | ip_b | distinct |
|---|---|---|---|
1 | 104.28.215.130 | 104.28.219.241 | ✅ |
2 | 104.28.215.130 | 104.28.219.241 | ✅ |
3 | 104.28.247.133 | 104.28.219.241 | ✅ |

**serempak distinct: 3/3.**

### Fase B — bounce satu lane (jalur yang benar-benar dipakai guard P1-5)

| trial | tries sampai distinct | ip_a | ip_b |
|---|---|---|---|
1 | 1 | 104.28.219.241 | `104.28.215.130` |
2 | 3 | 104.28.219.241 | 104.28.219.241 (×2) → `104.28.215.130` |
3 | 5 | 104.28.219.241 | 104.28.219.241 (×4) → `104.28.215.130` |
4 | 1 | 104.28.251.244 | `104.28.215.132` |
5 | 1 | 104.28.215.132 | `104.28.219.241` |
6 | 2 | 104.28.219.241 | 104.28.219.241 → `104.28.215.130` |

**bounce konvergen: 6/6 trial** (miss 0). tries-needed `1,3,5,1,1,2` → **avg 2,17, max 5**
(≈ 40–90 detik per konvergensi pada jeda 15 detik).

### Pool IP yang teramati di colo SIN

`104.28.215.130` · `104.28.215.132` · `104.28.215.133` · `104.28.219.241` · `104.28.247.133` · `104.28.251.244`
→ **6 IP unik**; tidak ada batas keras satu-IP seperti yang terlihat di sesi sebelumnya.

## 5. Koreksi hipotesis lama (penting)

Dokumen sebelumnya (`TASKS.md:80-82`) menyatakan root cause = *start serempak* sehingga kedua
tunnel masuk pool CGNAT yang sama, dengan resep stagger `a → sleep 8 → b → sleep 12`.

**Data hari ini memfalsifikasi sebagian hipotesis lama:**
- Start **serempak** justru menghasilkan **IP berbeda 3/3**.
- Bounce **berturutan** pun masih sering menghasilkan **IP sama** (trial 2 attempt 1-2, trial 3 attempt 1-4, trial 6 attempt 1).

Jadi yang sebenarnya berlaku: **kolisi bersifat acak** (IP dari pool per colo, ~2-3 kandidat
sering terpakai bareng), **bukan** akibat sinkronnya handshake. Stagger tetap berguna sebagai
pembatas beban, tapi **tidak boleh jadi dasar jaminan**.

**Konsekuensi desain (penting):** jaminan "tidak pernah sama IP" **tidak bisa** datang dari
konfigurasi statis. Ia harus datang dari **verifikasi + retry**:

1. probe IP tiap lane,
2. bila sama → **park** satu lane (keluar dari RR, keeper tetap melayani),
3. bounce yang parked sampai IP-nya beda,
4. otomatis kembali ke RR begitu IP-nya unik,
5. **status menampilkan `invariant_ok` + `serving_ips`** supaya bisa diverifikasi kapan pun,
   bukan "d Hopefully".

Guard P1-5 (sudah ada, `pool/pool.js`) persis mengimplementasikan 1-4. Yang belum ada adalah
`invariant_ok` di status (Gate 1) dan **stagger saat start** di launcher Windows (Gate 1).

## 6. Lever yang diuji dan DITOLAK (IPv4)

| Lever | Hasil |
|---|---|
Daftar akun baru (`wgcf register`) | IP tetap sama → identitas akun **tidak** menentukan IP |
Port peer lain (`500`, `4500`) | Pool IP sama → tidak ada pool terpisah |
Peer IP lain (`162.159.193.1`) | **Tidak bisa dipakai** — tunnel diam, tidak ada traffic |
Lane IPv6 (rencana awal) | Dibatalkan — tidak diperlukan; user juga menetapkan cukup IPv4 |

## 7. Bukti wire-up ekosistem di Windows

```
warp-a :12810  104.28.219.241
warp-b :12811  104.28.215.130
pool   :11801  (backends a/b, health 10s)   → :9190  ip_conflict=false  parked=[]
router :21399  mode=warp  → /health {"status":"ok"}, 84 model
POST /v1/chat/completions → HTTP 429 {"type":"rate_limit_error"}
```

Catatan: `429` **bukti rantai berhasil** — request keluar lewat router → pool → tunnel WARP →
`socks5h://127.0.0.1:11801` → opencode.ai, dan upstream menjawab batas kuota. Wiring Windows
tidak bermasalah; limitnya milik upstream, dihitung per egress IP (lihat `REFERENCE-SYNC.md`).

**Port koreksi:** `server/lib/configStore.js` meng-hardcode `warp.poolSocks =
socks5h://127.0.0.1:11801` dan `warp.statusUrl = http://127.0.0.1:9190`. Spike yang memakai
port lain akan gagal dengan `ECONNREFUSED` — bukan bug, hanya port yang tidak cocok.

## 8. Yang tersisa untuk Gate 1 (platform Windows)

1. `archrouter` → runtime Node lintas-OS (`archrouter.mjs`), bash jadi shim; start pakai
   `spawn(detached)`, cek port via `net.connect`, stop via pid + `taskkill /T /F`.
2. `server/lib/store.js:18` — `process.env.HOME` → `os.homedir()` + `ARCHROUTER_HOME`
   (di Windows `HOME` kosong → DB jatuh ke folder repo).
3. `install.mjs` — deteksi OS/arch, unduh wgcf `.exe` + sing-box `.zip`, verifikasi SHA256,
   tulis `.env`, `archrouter.cmd` ke user PATH. **Tanpa autostart.**
4. `doctor` — preflight dial UDP 2408 sebelum daftar akun.
5. `pool/pool.js` — `invariant_ok` + `serving_ips` di status; stagger saat start.
6. Jalankan 3 test suite di Windows: `test-pool-distinct-ip` 14/14, `test-pool-rotation` 11/11,
   `test-p0` 32/32 (port tes jadi env-overridable karena excluded range Windows dinamis).

## 9. Repro

```powershell
pwsh -File scripts\warp-ip-matrix.ps1 `
  -SingBox "$env:USERPROFILE\.archrouter-spike\bin\x64\sing-box.exe" `
  -DirA "$env:USERPROFILE\.archrouter-spike\warp\warp-a" `
  -DirB "$env:USERPROFILE\.archrouter-spike\warp\warp-b" `
  -PortA 12810 -PortB 12811 -SerempakTrials 3 -BounceTrials 6 -MaxBounce 8 `
  -OutCsv "$env:USERPROFILE\.archrouter-spike\logs\ip-matrix.csv"
```
