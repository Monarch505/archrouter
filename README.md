# archrouter (monarch-router)

One-shot deploy of `monarch-router`: opencode-only router (`opencode.ai/zen/v1`)
+ WARP pool (`warp-a/b` via sing-box, SOCKS `:11801`) on Linux with root.

## One-liner (fresh machine, root or sudo user)

```bash
git clone https://github.com/Monarch505/archrouter ~/archrouter \
  && ~/archrouter/install.sh --unattended
```

What `--unattended` does: OS deps → node ≥ 22 (`~/.local/node`) →
`wgcf` 2.3.0 + `sing-box` 1.14.1 (`~/.archrouter/bin/<arch>`) →
`archrouter warp-setup` (idempotent, keeps existing accounts) →
full stack start (`MODE=warp`: warp-a `:11810`, warp-b `:11811`,
pool `:11801`, router `:20399`, status `:9190`) → verify `/health`.

Smoke test after install:

```bash
node ~/archrouter/scripts/e2e-chat.js
archrouter status
```

## Re-run / update (existing clone)

`git pull` does not restore lost exec bits or discard local edits — use this
instead (destroys local modifications, keeps `~/.archrouter` accounts + data):

```bash
cd ~/archrouter && git fetch origin && git reset --hard origin/main \
  && chmod +x install.sh archrouter && ./install.sh --unattended
```

## Daily use

```bash
archrouter start | stop | restart | status | logs [router|pool|warp-a|warp-b]
archrouter warp-setup [--force]   # idempotent; --force burns 2 new WARP slots
archrouter warp-reset [a|b]       # bounce one backend (pool coordinator hook)
archrouter doctor                 # env / ports / bins / upstream check
```

Config: `~/.archrouter/.env` (copied from `.env.example` on install;
sourced automatically — `ARCHROUTER_MODE=warp` default).
Override per-invocation via env, e.g. `ARCHROUTER_MODE=none archrouter start`
(direct, no WARP — use on UDP-filtered networks).

Docs: `PLAN.md` `ARCHITECTURE.md` `PORTING.md` `PORTS-AND-ENV.md` `TASKS.md`.
