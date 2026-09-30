# archrouter (monarch-router)

One-shot deploy of `monarch-router`: opencode-only router (`opencode.ai/zen/v1`)
+ WARP pool (`warp-a/b` via sing-box, SOCKS `:11801`) — on **Linux, Termux, and
native Windows**. No Docker anywhere: `wgcf` + `sing-box` run natively.

## One-liner

```bash
git clone https://github.com/Monarch505/archrouter ~/archrouter \
  && node ~/archrouter/install.js --unattended
```

```powershell
git clone https://github.com/Monarch505/archrouter $env:USERPROFILE\archrouter
cd $env:USERPROFILE\archrouter
node install.js --unattended
```

`install.sh` is a shim for the same `install.js`, so the bash one-liner keeps
working. Node ≥ 22 is the only prerequisite (Windows 10+ already ships
`curl.exe`/`tar.exe`).

What `--unattended` does: OS packages → node ≥ 22 check →
`wgcf` 2.3.0 + `sing-box` 1.14.1 (native, `~/.archrouter/bin/<arch>`, SHA256
recorded in `bin/<arch>/SHA256SUMS`) → `.env` → `archrouter` on your PATH
(`archrouter.cmd` + sh on Windows, symlink on unix) →
`archrouter warp-setup` (idempotent, keeps existing accounts) →
full stack start (`MODE=warp`: warp-a `:11810`, warp-b `:11811`,
pool `:11801`, router `:20399`, status `:9190`) → verify `/health` and the
same-egress-IP invariant.

**No autostart is installed.** Start it yourself when you need it.

Smoke test after install:

```bash
node scripts/e2e-chat.js
archrouter status     # pids, egress IPs, invariant_ok
archrouter doctor     # ports/ownership, binaries, invariant_ok, live warp trace
```

## Re-run / update (existing clone)

`git pull` does not restore lost exec bits or discard local edits — use this
instead (destroys local modifications, keeps `~/.archrouter` accounts + data):

```bash
cd ~/archrouter && git fetch origin && git reset --hard origin/main \
  && chmod +x install.sh archrouter && node install.js --unattended
```

## Daily use

```bash
archrouter start | stop | restart | status | logs [router|pool|warp-a|warp-b]
archrouter update [--check|--no-restart|--force|--full]  # self-update from GitHub + restart
archrouter rollback                                       # restore pre-update version
archrouter warp-setup [--force]   # idempotent; --force burns 2 new WARP slots
archrouter warp-reset [a|b]       # bounce one backend (pool coordinator hook)
archrouter doctor                 # env / ports / bins / upstream check
```

`update` only touches the repo (`~/archrouter`) — `.env`, WARP accounts,
DB, and logs in `~/.archrouter` are kept. `--full` also re-runs `install.js`
(use when binary versions change). Note: binary downgrade on rollback is not
handled — re-run with `--full` if a rollback misbehaves.

Config: `~/.archrouter/.env` (written on install; loaded automatically —
`ARCHROUTER_MODE=warp` default). Precedence: an env var already set in your
shell/process wins over the file. Override per-invocation via env, e.g.
`ARCHROUTER_MODE=none archrouter start` (direct, no WARP — use on
UDP-filtered networks).

Windows note: `~\.local\bin\archrouter.cmd` is written to your user PATH (no
admin, **no autostart**). Open a new terminal once after install so PATH
applies. `$env:ARCHROUTER_STAGGER_MS=0` disables the start stagger.

### Two accounts, two egress IPs

The quota upstream is **per egress IP**, so the two WARP accounts must not sit
on one IP. Cloudflare assigns that IP from a per-colo pool (not per account),
so a collision is possible and the pool handles it: it **parks** the duplicate
(never serves two accounts on one IP), bounces it until the IP differs, and puts
it back in rotation. `archrouter status` / `doctor` and `GET :9190` expose
`invariant_ok` plus `serving_ips` so you can verify it instead of trusting it.
Measured convergence on this machine: 6/6 runs, avg 2.2 bounces — see
`docs-internal/WINDOWS-BACKBONE-PROOF.md`.

Chroot/Android note: if sing-box logs `missing default interface` /
`network is unreachable` (no default route in the main table), set
`ARCHROUTER_NET_IF=wlan0` in `~/.archrouter/.env`, then
`archrouter warp-setup` (regenerates configs, keeps accounts) +
`archrouter restart`. If the ISP filters UDP 2408, try `ARCHROUTER_WG_PORT=500`.
