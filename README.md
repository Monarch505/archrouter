# archrouter (monarch-router)

One-shot deploy of `monarch-router`: opencode-only router (`opencode.ai/zen/v1`)
+ WARP pool (`warp-a/b` via sing-box, SOCKS `:11801`) — on **Linux, Termux, and
native Windows**. No Docker anywhere: `wgcf` + `sing-box` run natively.

## One-liner

Install, start, done — one command. It installs Node 22 if you do not have it,
registers the WARP accounts, starts the stack and waits until the API answers.

```bash
git clone https://github.com/Monarch505/archrouter ~/archrouter && cd ~/archrouter && bash setup.sh
```

Or without cloning by hand:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Monarch505/archrouter/main/setup.sh)
```

Windows:

```powershell
git clone https://github.com/Monarch505/archrouter $env:USERPROFILE\archrouter
cd $env:USERPROFILE\archrouter
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

Works on Debian/Ubuntu/Kali, Fedora/RHEL, Alpine, Arch, Termux, macOS and
Windows 10+. No Docker, no systemd, no autostart, no root required (it uses
`sudo`/`nvm` when it needs to).

`setup.sh` prints your API key once and also keeps a copy in
`~/.archrouter/data/first-key.txt` (mode 600) so a scrolled-away terminal cannot
lock you out. Useful flags: `--no-warp` (serve direct, skip WARP),
`--no-opencode`, `--dir PATH`, `--port N`.

Doing it by hand instead:

```bash
git clone https://github.com/Monarch505/archrouter ~/archrouter
cd ~/archrouter
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

## Re-run / update (existing clone)
`git pull` does not restore lost exec bits or discard local edits — use this
instead (destroys local modifications, keeps `~/.archrouter` accounts + data):

```bash
cd ~/archrouter && git fetch origin && git reset --hard origin/main \
  && chmod +x install.sh archrouter && node install.js --unattended
```

## Uninstalling

```bash
archrouter uninstall            # asks first
archrouter uninstall --yes      # non-interactive
archrouter uninstall --yes --purge   # also destroy WARP accounts + API keys
```

A plain uninstall stops the stack and removes the launcher, the PATH block it
added to your rc files (`.bashrc`, `.profile`, `.zshrc`), the downloaded
binaries, the logs, the stale pid files — **and the repo clone itself**, so the
next install starts from a fresh `git clone`. Run it from outside the repo
directory (`cd ~` first): your shell cannot follow a directory that is gone.
If the checkout still had uncommitted changes, the summary says so right before
they go.

It **keeps** your two WARP accounts, `.env` and the API key database, so a
reinstall keeps working and opencode stays connected — re-registering WARP costs
new Cloudflare slots, and existing keys would go dead.

`--purge` deletes those too. Afterwards you need `archrouter warp-setup` again
and every client holding a key must be reconnected.

Reinstall with:

```bash
git clone https://github.com/Monarch505/archrouter && cd archrouter && bash setup.sh
```

`opencode.json` is never touched, and a shim that belongs to a different
archrouter install is left alone.

## Daily use

```bash
archrouter start | stop | restart | status | logs [router|pool|warp-a|warp-b]
archrouter update [--check|--no-restart|--force|--full]  # self-update from GitHub + restart
archrouter rollback                                       # restore pre-update version
archrouter warp-setup [--force]   # 2 WARP accounts + sing-box configs (idempotent; --force burns 2 new slots)
archrouter warp-reset [a|b]       # bounce one backend (pool coordinator hook)
archrouter key [name]             # mint another API key
archrouter connect-opencode [--no-models|--no-key]  # point opencode at this router
archrouter uninstall [--yes|--purge]  # remove what install put on the machine
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

### Free models only

archrouter serves **only the free tier**. A model must end in `-free` to be
served at all: paid ids (`claude-*`, `gemini-*`, `big-p`, `muse-spark-1.3`
without the suffix, …) never appear in `GET /v1/models` and are refused with
`400 model_not_free` if a client asks for one by hand, so a typo cannot burn
quota. Combos must point at a `-free` model too. `ARCHROUTER_FREE_ONLY=0`
lifts the rule if you ever need it.

Free models are not all on the same path: `muse-spark-*-contributor-free`
answers only on `/v1/responses`, `jev-1.13-free` only on `/v1/messages`, the
rest on `/v1/chat/completions`. `GET /v1/models` reports the correct one per
model in `capabilities.kind`.

### Pointing opencode at it

```bash
archrouter connect-opencode
```

This writes the `archrouter` provider into `~/.config/opencode/opencode.json`
**with a static `models` block** (ids + effort levels from `modelCaps`), plus
`options.apiKey` when a key can be resolved — `ARCHROUTER_KEY`, else the key
printed at install, else the one `/connect` already saved.

The static block is not a shortcut, it is the only shape opencode honours.
opencode builds its picker from models.dev plus the `models` map in
`opencode.json`, and it never calls a custom provider's `/v1/models`;
auto-discovery is hardcoded to Ollama, LM Studio and vLLM at their default
ports. A provider written with only `npm` + `baseURL` shows up as
`Provider not found` with an empty list — verified on opencode 1.18.3. General
discovery is still an open PR (`anomalyco/opencode#42660`), so nothing to wait
for. `--no-models` exists only to clean up an older install; it writes a
provider opencode cannot use.

The cost is that a new upstream free model needs another `connect-opencode`
run. Check it with:

```bash
opencode models archrouter
```

The catalog is the full live list, so a few entries will fail when picked —
recorded rather than hidden:

| model | what happens in opencode |
| --- | --- |
| `muse-spark-*-contributor-free`, `jev-1.13-free` | 500 — they only answer on `/v1/responses` and `/v1/messages`, while `@ai-sdk/openai-compatible` posts to `/v1/chat/completions` |
| `ling-3.0-flash-fin-free` | 400 `Endpoint is unavailable` (upstream, reproducible 3/3) |
| `ling-3.1-flash-free` | 429 `Endpoint is unavailable` (upstream, reproducible 3/3) |

The other 7 are confirmed working through opencode.

### API keys

Keys live in the dashboard (`http://127.0.0.1:20399/` → **API keys**), not in
the CLI. A fresh install prints one `default` key once; only its SHA-256 is
stored, so it cannot be recovered — create another if you lose it.

Send it as `Authorization: Bearer sk-arch-…` or `x-archrouter-key: sk-arch-…`.
`?key=` in the URL is refused on purpose (URLs end up in logs and history).

**Require a key** is a three-way switch, stored in SQLite so it survives
restarts and applied without one:

| mode | behaviour |
| --- | --- |
| `auto` (default) | a key is required as soon as an enabled key exists; open before that, so a fresh install cannot lock itself out |
| `on` | a key is always required |
| `off` | never required, even with keys present |

Each key also has its own Enable/Disable, so you can pause one client without
rotating its secret. `ARCHROUTER_REQUIRE_AUTH=1|0` overrides the stored mode
for that process and `--no-auth` forces it open; both win over the dashboard
setting, and `archrouter doctor` shows which one is in effect.
