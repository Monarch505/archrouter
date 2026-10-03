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

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok  %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n        %s\n' "$1" "${2:-}"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has() { case "$2" in *"$3"*) ok "$1";; *) bad "$1" "'$3' missing from: $2";; esac; }

export HOME="$TMP/home"
mkdir -p "$HOME"
REPO_DIR="$TMP/archrouter"

ARCHROUTER_SETUP_LIB=1 . "$REPO/setup.sh"
REPO_DIR="$TMP/archrouter"   # sourcing reset it; point it at the sandbox
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

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1