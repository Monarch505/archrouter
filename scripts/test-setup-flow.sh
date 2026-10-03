#!/usr/bin/env bash
# test-setup-flow.sh — exercises the real setup.sh functions against fakes: a
# local git repo instead of GitHub, a stub install log instead of install.js,
# a throwaway HOME so your shell files are untouched.
#
# No network, no binaries, no WARP accounts, no services started.
# Run: bash scripts/test-setup-flow.sh

set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP/home"
mkdir -p "$HOME"

# Source first: setup.sh defines its own ok/info/warn/step, which would shadow
# this file's counters if they were defined before it.
ARCHROUTER_SETUP_LIB=1 . "$REPO/setup.sh"

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  [ok] %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n        %s\n' "$1" "${2:-}"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has() { case "$2" in *"$3"*) ok "$1";; *) bad "$1" "'$3' missing from: $2";; esac; }

REPO_DIR="$TMP/archrouter"
INSTALL_LOG=""

echo "setup.sh flow tests"

# ---------------------------------------------------------------- fetch_repo --
# Build a real git repo to clone from, so this path is genuinely exercised.
# Two commits, so "the remote is ahead" is a state we can reach deterministically
# instead of depending on how a shallow clone refreshes its remote refs.
BARE="$TMP/origin.git"
SEED="$TMP/seed"
mkdir -p "$SEED"
git -C "$SEED" init -q
git -C "$SEED" config user.email t@t
git -C "$SEED" config user.name t
echo one > "$SEED/one.txt"; git -C "$SEED" add -A; git -C "$SEED" commit -q -m "first"
echo two > "$SEED/two.txt"; git -C "$SEED" add -A; git -C "$SEED" commit -q -m "second"
git init -q --bare "$BARE"
git -C "$BARE" symbolic-ref HEAD refs/heads/main
git -C "$SEED" push -q "$BARE" HEAD:refs/heads/main || { bad "could not seed the test repo"; echo "1 failed"; exit 1; }

ARCHROUTER_REPO_URL="$BARE" ARCHROUTER_DIR="$REPO_DIR" fetch_repo >/dev/null 2>&1
if [ -d "$REPO_DIR/.git" ]; then ok "fetch_repo clones into the target dir"; else bad "fetch_repo clones into the target dir" "no .git at $REPO_DIR"; fi
# Guards against the test silently reaching GitHub: the clone must come from the fixture.
# (basename only — git-bash rewrites /tmp into a Windows path in the stored remote URL)
is "the clone came from the fixture repo, not GitHub" \
   "$(basename "$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null)")" "origin.git"
if [ -f "$REPO_DIR/two.txt" ]; then ok "fixture files are present after the clone"; else bad "fixture files are present after the clone" "two.txt missing"; fi

ARCHROUTER_REPO_URL="$BARE" ARCHROUTER_DIR="$REPO_DIR" fetch_repo >/dev/null 2>&1
is "fetch_repo is idempotent (second run does not fail)" "$?" "0"

# Now make the checkout genuinely older than the remote tip.
git -C "$REPO_DIR" fetch -q --unshallow origin 2>/dev/null || git -C "$REPO_DIR" fetch -q --depth=50 origin 2>/dev/null
git -C "$REPO_DIR" reset --hard -q HEAD~1
is "checkout is one commit behind origin/main" \
   "$(git -C "$REPO_DIR" rev-list --count HEAD..origin/main)" "1"

# Dirty + behind: warn, and above all do not throw the edit away.
echo "local edit" >> "$REPO_DIR/one.txt"
ARCHROUTER_REPO_URL="$BARE" ARCHROUTER_DIR="$REPO_DIR" fetch_repo >"$TMP/dirty.out" 2>&1
has "fetch_repo warns instead of discarding local edits" "$(cat "$TMP/dirty.out")" "local edits"
has "local edit survived" "$(cat "$REPO_DIR/one.txt")" "local edit"
if [ -f "$REPO_DIR/two.txt" ]; then bad "no reset happened while dirty" "two.txt appeared"; else ok "no reset happened while dirty"; fi

# Clean + behind: update.
git -C "$REPO_DIR" reset --hard -q
git -C "$REPO_DIR" clean -qfd
ARCHROUTER_REPO_URL="$BARE" ARCHROUTER_DIR="$REPO_DIR" fetch_repo >"$TMP/clean.out" 2>&1
if [ -f "$REPO_DIR/two.txt" ]; then ok "clean tree is fast-forwarded to origin/main"; else bad "clean tree is fast-forwarded to origin/main" "two.txt missing; HEAD=$(git -C "$REPO_DIR" log --oneline -1 2>&1); tree=$(git -C "$REPO_DIR" ls-tree --name-only HEAD 2>&1 | tr '\n' ' '); said: $(tr '\n' '|' < "$TMP/clean.out")"; fi
is "HEAD is back on the remote tip" "$(git -C "$REPO_DIR" rev-parse HEAD)" "$(git -C "$REPO_DIR" rev-parse origin/main)"

# A non-empty directory that is not a clone: git clone refuses it, and the old
# blanket error blamed the user's internet connection for that.
NOTGIT="$TMP/not-a-clone"
mkdir -p "$NOTGIT"
echo "precious data" > "$NOTGIT/file.txt"
real_rd="$REPO_DIR"
REPO_DIR="$NOTGIT"
notgit_out=$(ARCHROUTER_REPO_URL="$BARE" fetch_repo 2>&1); notgit_rc=$?
REPO_DIR="$real_rd"
is "fetch_repo refuses a non-empty non-git directory" "$notgit_rc" "1"
has "the refusal says what is actually wrong" "$notgit_out" "not a git clone"
hasnt "the refusal does not blame the internet" "$notgit_out" "internet"
has "the refusal keeps the user's files" "$(cat "$NOTGIT/file.txt")" "precious data"

# --------------------------------------------------------------- persist_path --
persist_path >/dev/null 2>&1
is "persist_path wrote the marker to ~/.bashrc" "$?" "0"
if [ -f "$HOME/.bashrc" ]; then ok "~/.bashrc exists"; else bad "~/.bashrc exists" "missing"; fi
has "~/.bashrc carries the marker" "$(cat "$HOME/.bashrc")" "archrouter (added by setup.sh)"
before=$(grep -c "archrouter (added by setup.sh)" "$HOME/.bashrc")

persist_path >/dev/null 2>&1
after=$(grep -c "archrouter (added by setup.sh)" "$HOME/.bashrc")
is "persist_path is idempotent (no duplicate block)" "$after" "$before"

# -------------------------------------------------------------- save_first_key --
LOG="$TMP/install.log"
KEY="sk-arch-$(printf 'A%.0s' $(seq 1 32))"
cat > "$LOG" <<EOF
[install] Node.js runtime
  [ok] node v22.14.0 (>=22)
  [ok] created key 'default' — copy it now, it cannot be shown again:

    $KEY

== summary: all good ==
EOF
INSTALL_LOG="$LOG"
save_first_key >/dev/null 2>&1
KEYFILE="$HOME/.archrouter/data/first-key.txt"
if [ -s "$KEYFILE" ]; then ok "save_first_key rescued the scrolled-away key"; else bad "save_first_key rescued the scrolled-away key" "no file at $KEYFILE"; fi
is "saved key matches the real one" "$(cat "$KEYFILE")" "$KEY"
case "$(uname)" in
  CYGWIN*|MINGW*|MSYS*) ok "permission bits are not meaningful here (git bash), skipped the 600 check";;
  *) is "key file is owner-only (600)" "$(stat -c '%a' "$KEYFILE" 2>/dev/null || echo '?')" "600";;
esac

save_first_key >/dev/null 2>&1
is "save_first_key does not overwrite an existing key" "$(cat "$KEYFILE")" "$KEY"

# --------------------------------------------------------------- wait_healthy --
PORT=21987
node -e "
const http=require('http');
http.createServer((q,s)=>{s.writeHead(200,{'Content-Type':'application/json'});s.end('{\"status\":\"ok\"}');}).listen($PORT,'127.0.0.1');
" &
SRV=$!
sleep 1
API_PORT=$PORT HEALTH_TIMEOUT=10
export API_PORT HEALTH_TIMEOUT
wait_healthy >/dev/null 2>&1
is "wait_healthy succeeds against a live API" "$?" "0"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null

API_PORT=21988 HEALTH_TIMEOUT=4
export API_PORT HEALTH_TIMEOUT
wait_healthy >/dev/null 2>&1
is "wait_healthy fails (non-zero) when nothing answers" "$?" "1"

# ---------------------------------------------------------------- endings ----
# A CRLF in a shell script makes Linux fail with "bad interpreter: /bin/bash^M".
# core.autocrlf=true is common on Windows checkouts, so .gitattributes has to
# pin LF for every shell script.
attrs="$REPO/.gitattributes"
for pat in '*.sh text eol=lf' 'setup.sh text eol=lf'; do
  if grep -qxF "$pat" "$attrs" 2>/dev/null; then ok ".gitattributes pins '$pat'"
  else bad ".gitattributes pins '$pat'" "rule missing"; fi
done

crlf_offenders=""
for f in setup.sh archrouter install.sh scripts/test-setup-sh.sh scripts/test-setup-flow.sh pool/pool.js; do
  [ -f "$REPO/$f" ] || continue
  if LC_ALL=C grep -qU $'\r$' "$REPO/$f" 2>/dev/null; then crlf_offenders="$crlf_offenders $f"; fi
done
if [ -z "$crlf_offenders" ]; then ok "no CRLF in the scripts that must run under bash"
else bad "no CRLF in the scripts that must run under bash" "CRLF found in:$crlf_offenders"; fi

# The committed blobs matter as much as the working tree: that is what a Linux
# clone gets. Checked in the Node suite — a pipe through MSYS text mode adds
# CR on its own, which would make this assertion lie in both directions.

# --- deploy must not treat a non-fatal bad() as fatal, and must rescue the key
# before anything that can fail. A real install hit this: install.js exits 1 for
# a cosmetic check while the stack serves fine, and setup.sh used to abort there
# and lose the one-and-only API key.
has "deploy() does not die on a non-zero install.js exit" "$(sed -n '/^deploy()/,/^}/p' "$REPO/setup.sh")" "carrying on"
if sed -n '/^deploy()/,/^}/p' "$REPO/setup.sh" | grep -q 'die "install.js failed'; then
  bad "deploy() has no hard abort on install.js failure" "still calls die()"
else
  ok "deploy() has no hard abort on install.js failure"
fi

rescue_line=$(grep -n '^  save_first_key$' "$REPO/setup.sh" | head -1 | cut -d: -f1)
health_line=$(grep -n '^  if ! wait_healthy' "$REPO/setup.sh" | head -1 | cut -d: -f1)
if [ -n "$rescue_line" ] && [ -n "$health_line" ] && [ "$rescue_line" -lt "$health_line" ]; then
  ok "the key is rescued before the health check can fail (line $rescue_line < $health_line)"
else
  bad "the key is rescued before the health check can fail" "save_first_key at '${rescue_line:-none}', wait_healthy at '${health_line:-none}'"
fi

# --- PATH must work in the shell that ran setup, not just the next one -------
# A first real run ended at "archrouter: command not found": ~/.local/bin is in
# ~/.bashrc, which the already-open shell had not read.
if grep -q 'ensure_callable_now' "$REPO/setup.sh"; then
  ok "setup.sh makes archrouter callable in the current shell"
else
  bad "setup.sh makes archrouter callable in the current shell" "ensure_callable_now missing"
fi
if sed -n '/^ensure_callable_now()/,/^}/p' "$REPO/setup.sh" | grep -q '/usr/local/bin'; then
  ok "ensure_callable_now links into a directory already on PATH"
else
  bad "ensure_callable_now links into a directory already on PATH" "no /usr/local/bin attempt"
fi
if sed -n '/^ensure_callable_now()/,/^}/p' "$REPO/setup.sh" | grep -q 'bashrc'; then
  ok "ensure_callable_now falls back to telling the user to source ~/.bashrc"
else
  bad "ensure_callable_now falls back to telling the user to source ~/.bashrc" "no fallback message"
fi

# --- install.js must poll for /health, not sleep a fixed 3s -------------------
# On a fresh install the stack needs ~20s (8s stagger + pool + router), so the
# fixed wait reported "router /health no response" on a healthy machine.
if grep -q 'healthDeadline' "$REPO/install.js"; then
  ok "install.js polls /health until it answers"
else
  bad "install.js polls /health until it answers" "no healthDeadline"
fi
# The real invariant: the check is inside a retry loop, not a one-shot after a
# fixed sleep. A 3s interval between retries is fine.
if grep -q 'while (Date.now() < healthDeadline)' "$REPO/install.js"; then
  ok "the /health check is retried in a loop"
else
  bad "the /health check is retried in a loop" "no retry loop around the health check"
fi
if grep -q 'ARCHROUTER_HEALTH_TIMEOUT_MS' "$REPO/install.js"; then
  ok "the retry budget is overridable (ARCHROUTER_HEALTH_TIMEOUT_MS)"
else
  bad "the retry budget is overridable" "no env override"
fi

# --- install.js must persist PATH itself, zsh included ----------------------
# Its Linux branch used to print `add to PATH: export ...` and nothing else, so
# `node install.js` runs (the documented manual path) never survived a new
# terminal — and neither did any zsh session, since only bash rcs were known.
if grep -q 'function persistPathPosix' "$REPO/install.js"; then
  ok "install.js writes the PATH block itself"
else
  bad "install.js writes the PATH block itself" "persistPathPosix missing"
fi
if grep -q '\.zshrc' "$REPO/install.js"; then
  ok "install.js covers zsh"
else
  bad "install.js covers zsh" "no .zshrc reference"
fi
# One marker shared with setup.sh is what makes double-append impossible.
if grep -q 'PATH_MARKER = "# archrouter (added by setup.sh)"' "$REPO/install.js"; then
  ok "install.js uses the exact marker setup.sh writes"
else
  bad "install.js uses the exact marker setup.sh writes" "marker mismatch"
fi
if grep -q 'persistPathPosix()' "$REPO/install.js"; then
  ok "the POSIX shim path actually calls persistPathPosix"
else
  bad "the POSIX shim path actually calls persistPathPosix" "never called"
fi

# --- --no-warp must reach install.js and survive into .env -------------------
# WANT_WARP was assigned by the parser and never read anywhere: the flag
# skipped nothing and pinned nothing, so `setup.sh --no-warp` produced a stack
# that still tried to start WARP.
STUB="$TMP/stub-repo"
mkdir -p "$STUB"
cat > "$STUB/install.js" <<'EOF'
require("fs").writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
EOF
export STUB_ARGV_FILE="$TMP/stub-argv.txt"
REAL_REPO_DIR="$REPO_DIR"
REPO_DIR="$STUB"
WANT_WARP=0 deploy >/dev/null 2>&1
is "deploy() forwards --no-warp when WANT_WARP=0" \
   "$(cat "$STUB_ARGV_FILE" 2>/dev/null)" '["--unattended","--no-warp"]'
is "deploy() exports ARCHROUTER_MODE=none for the run" "${ARCHROUTER_MODE:-}" "none"
unset ARCHROUTER_MODE
WANT_WARP=1 deploy >/dev/null 2>&1
is "deploy() does NOT forward --no-warp by default" \
   "$(cat "$STUB_ARGV_FILE" 2>/dev/null)" '["--unattended"]'
REPO_DIR="$REAL_REPO_DIR"

# install.js side: the flag must gate warp-setup and rewrite .env, otherwise
# the next `archrouter start` reads ARCHROUTER_MODE=warp from .env.example.
if grep -q 'const NO_WARP = has("--no-warp")' "$REPO/install.js"; then
  ok "install.js reads the --no-warp flag"
else
  bad "install.js reads the --no-warp flag" "NO_WARP not defined from argv"
fi
if grep -q 'skipping warp-setup' "$REPO/install.js"; then
  ok "install.js skips warp-setup under --no-warp"
else
  bad "install.js skips warp-setup under --no-warp" "no NO_WARP gate on warp-setup"
fi
if grep -qF 'ARCHROUTER_MODE=none' "$REPO/install.js" && grep -qF 'text.replace(/^ARCHROUTER_MODE=' "$REPO/install.js"; then
  ok "install.js rewrites ARCHROUTER_MODE in .env under --no-warp"
else
  bad "install.js rewrites ARCHROUTER_MODE in .env under --no-warp" "no .env rewrite"
fi

# --- --port must be written into .env, not just exported for this shell ------
# The export died with the terminal: .env (from .env.example, 20399) won in
# every later one, so --port silently reverted.
if grep -q 'PORT_GIVEN' "$REPO/setup.sh"; then
  ok "setup.sh tracks whether --port was passed"
else
  bad "setup.sh tracks whether --port was passed" "PORT_GIVEN missing"
fi
if grep -qE 'set_env_var .* ARCHROUTER_PORT' "$REPO/setup.sh"; then
  ok "setup.sh writes ARCHROUTER_PORT into .env"
else
  bad "setup.sh writes ARCHROUTER_PORT into .env" "no set_env_var call"
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1