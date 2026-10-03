# test-uninstall.sh — asserts archrouter uninstall does exactly what it claims
# and leaves what it promised to keep. Uses a throwaway HOME, USERPROFILE and
# ARCHROUTER_HOME so nothing real is touched.
#
# Every run executes a DISPOSABLE COPY of the repo in $TMP, never the real one:
# uninstall removes the repo by default, so pointing it at the working tree
# would delete the very code under test (and its git history).
#
# Run: bash scripts/test-uninstall.sh

set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- what the live machine looks like BEFORE the sandbox takes over --------
# Windows resolves the home directory from USERPROFILE, not HOME. Without
# isolating both this suite would delete the real profile's shims — which it
# did, once. Snapshot them so the end of the run can prove they survived.
REAL_HOME="$(cd "${USERPROFILE:-$HOME}" 2>/dev/null && pwd || echo "$HOME")"
shim_state() {
  local s="" f
  for f in .local/bin/archrouter .local/bin/archrouter.cmd; do
    if [ -e "$REAL_HOME/$f" ] || [ -L "$REAL_HOME/$f" ]; then s="${s}present "; else s="${s}absent "; fi
  done
  printf '%s' "$s"
}
before_real=$(shim_state)

export HOME="$TMP/home"
export USERPROFILE="$TMP/home"
mkdir -p "$HOME"
export ARCHROUTER_HOME="$TMP/archrouter-home"
REPO="$REPO" ARCHROUTER_SETUP_LIB=1 . "$REPO/setup.sh"
REPO_DIR="$REPO"

# Counters AFTER the source: setup.sh exports its own ok() (plain printer) and
# would shadow ours, which once made this suite report "0 passed" while every
# line was green.
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  [ok] %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n        %s\n' "$1" "${2:-}"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has() { case "$2" in *"$3"*) ok "$1";; *) bad "$1" "'$3' missing from: $2";; esac; }
hasnt() { case "$2" in *"$3"*) bad "$1" "'$3' should not appear in: $2";; *) ok "$1";; esac; }

# --- a disposable repo that looks exactly like the real one ----------------
# Unique per call via mktemp: the counter would be lost inside $(...) (each
# capture is a subshell), which once made every run reuse the same directory
# and let git's "nothing to commit" chatter leak into the captured path.
fresh_repo() {
  local d
  d=$(mktemp -d "$TMP/reporepo-XXXXXX") || return 1
  mkdir -p "$d/server"
  cp "$REPO/archrouter.js" "$d/archrouter.js"
  : > "$d/server/server.js"
  {
    git -C "$d" init -q
    git -C "$d" add -A
    git -C "$d" -c user.email=test@test -c user.name=test commit -qm init
  } >/dev/null 2>&1
  printf '%s' "$d"
}

# A real shim embeds the absolute path to that repo's archrouter.js; without it
# uninstall cannot prove ownership and must keep the file. Use the same path
# form archrouter.js computes for itself (pwd -W gives the Windows form under
# git-bash), otherwise the fixture proves nothing.
plant_shim() {
  local repo_abs node_abs
  repo_abs="$(cd "$1" && (pwd -W 2>/dev/null || pwd))"
  node_abs="$(command -v node)"
  cat > "$HOME/.local/bin/archrouter" <<EOF
#!/usr/bin/env bash
exec "$node_abs" "$repo_abs/archrouter.js" "\$@"
EOF
  chmod +x "$HOME/.local/bin/archrouter"
}

echo "archrouter uninstall"

# ---------------------------------------------------------------------------
# Build a realistic tree: binaries, two WARP accounts, db, env, logs, shim, and
# the PATH block setup.sh writes.
# ---------------------------------------------------------------------------
HOMEBASE="$ARCHROUTER_HOME"
mkdir -p "$HOMEBASE/bin/aarch64" "$HOMEBASE/warp/warp-a" "$HOMEBASE/warp/warp-b" \
         "$HOMEBASE/data/logs" "$HOME/.local/bin"
echo bin > "$HOMEBASE/bin/aarch64/sing-box"
echo acctA > "$HOMEBASE/warp/warp-a/wgcf-account.toml"
echo acctB > "$HOMEBASE/warp/warp-b/wgcf-account.toml"
echo cfg > "$HOMEBASE/warp/warp-a/sing-box.json"
echo db  > "$HOMEBASE/data/archrouter.db"
echo key > "$HOMEBASE/data/first-key.txt"
echo pid > "$HOMEBASE/data/router.pid"
echo log > "$HOMEBASE/data/logs/router.log"
echo "ARCHROUTER_MODE=warp" > "$HOMEBASE/.env"
persist_path >/dev/null 2>&1

is "PATH block is in ~/.bashrc before uninstall" \
   "$(grep -c 'archrouter (added by setup.sh)' "$HOME/.bashrc")" "1"

# ---------------------------------------------------------------------------
# Default run: stop, remove shims, remove binaries/logs/pids, keep accounts,
# keep .env, keep the DB and the key.
# ---------------------------------------------------------------------------
R1=$(fresh_repo)
plant_shim "$R1"

# A shim belonging to a DIFFERENT install lives in the same scanned directory
# and must survive. Regression: an earlier version matched any file containing
# the string "archrouter.js" and happily deleted an unrelated, working
# installation's launcher.
OTHER_INSTALL="$TMP/other-install"
mkdir -p "$OTHER_INSTALL"
cat > "$HOME/.local/bin/archrouter.cmd" <<EOF
@echo off
"C:\Program Files\nodejs\node.exe" "$OTHER_INSTALL\archrouter.js" %*
EOF
foreign_before=$(cat "$HOME/.local/bin/archrouter.cmd")

out=$(node "$R1/archrouter.js" uninstall --yes 2>&1); rc=$?
is "uninstall exits 0" "$rc" "0"
if echo "$out" | grep -qE "stopped|not running"; then ok "uninstall reports the stack state"; else bad "uninstall reports the stack state" "neither stopped nor not running in: $(echo "$out" | tr '\n' '|')"; fi
has "uninstall reports what it kept" "$out" "kept"

if [ -f "$HOME/.local/bin/archrouter" ]; then bad "shim removed" "still at ~/.local/bin/archrouter"; else ok "shim removed"; fi
is "a foreign install's shim is left alone" \
   "$([ -f "$HOME/.local/bin/archrouter.cmd" ] && echo present || echo missing)" "present"
is "a foreign install's shim is byte-identical" "$(cat "$HOME/.local/bin/archrouter.cmd")" "$foreign_before"

if [ -f "$HOMEBASE/bin/aarch64/sing-box" ]; then bad "binaries removed" "sing-box still there"; else ok "binaries removed"; fi
if [ -f "$HOMEBASE/data/logs/router.log" ]; then bad "logs removed" "router.log still there"; else ok "logs removed"; fi
if [ -f "$HOMEBASE/data/router.pid" ]; then bad "stale pid files removed" "router.pid still there"; else ok "stale pid files removed"; fi

if [ -f "$HOMEBASE/warp/warp-a/wgcf-account.toml" ]; then ok "warp-a account kept by default"; else bad "warp-a account kept by default" "gone"; fi
if [ -f "$HOMEBASE/warp/warp-b/wgcf-account.toml" ]; then ok "warp-b account kept by default"; else bad "warp-b account kept by default" "gone"; fi
if [ -f "$HOMEBASE/.env" ]; then ok ".env kept by default"; else bad ".env kept by default" "gone"; fi
if [ -f "$HOMEBASE/data/archrouter.db" ]; then ok "api key database kept by default"; else bad "api key database kept by default" "gone"; fi
if [ -f "$HOMEBASE/data/first-key.txt" ]; then ok "saved key kept by default"; else bad "saved key kept by default" "gone"; fi

# The PATH block must go, otherwise a later install leaves it duplicated.
is "PATH block removed from ~/.bashrc" \
   "$(grep -c 'archrouter (added by setup.sh)' "$HOME/.bashrc" || true)" "0"
hasnt "uninstall tells the user how to reinstall" "$(echo "$out" | tr '\n' '|')" "rm -rf"
has "uninstall points at the reinstall command" "$out" "setup.sh"

# ---------------------------------------------------------------------------
# Idempotency: running it again on a half-removed tree must not explode.
# ---------------------------------------------------------------------------
R2=$(fresh_repo)
out2=$(node "$R2/archrouter.js" uninstall --yes 2>&1); rc2=$?
is "uninstall is safe to run twice" "$rc2" "0"

# ---------------------------------------------------------------------------
# --purge: everything goes, including the WARP accounts.
# ---------------------------------------------------------------------------
R3=$(fresh_repo)
out3=$(node "$R3/archrouter.js" uninstall --yes --purge 2>&1); rc3=$?
is "uninstall --purge exits 0" "$rc3" "0"
if [ -f "$HOMEBASE/warp/warp-a/wgcf-account.toml" ]; then bad "purge removes the warp accounts" "warp-a account still there"; else ok "purge removes the warp accounts"; fi
if [ -f "$HOMEBASE/data/archrouter.db" ]; then bad "purge removes the api key database" "db still there"; else ok "purge removes the api key database"; fi
has "purge warns that the keys are gone for good" "$out3" "key"
has "purge explains WARP accounts must be registered again" "$out3" "warp-setup"

# ---------------------------------------------------------------------------
# Nothing outside the two roots was touched: the real repo, this machine's
# real profile, and files we only removed a block from.
# ---------------------------------------------------------------------------
is "the real repo was not deleted" "$([ -f "$REPO/archrouter.js" ] && echo present || echo missing)" "present"
is "the real repo's git history was not deleted" "$([ -d "$REPO/.git" ] && echo present || echo missing)" "present"
is "the live profile's shims are untouched" "$(shim_state)" "$before_real"
if [ -f "$HOME/.bashrc" ]; then ok "~/.bashrc still exists (only our block removed)"; else bad "~/.bashrc still exists" "file gone"; fi

# --- update/rollback must not declare failure on a slow boot -----------------
# Real report: `archrouter update` reset to the new commit, started everything,
# then slept 2.5s, saw no /health and told the user to roll back a perfectly
# good update. Both paths have to poll instead.
if grep -q 'async function waitHealthy' "$REPO/archrouter.js"; then
  ok "archrouter.js has a polling health helper"
else
  bad "archrouter.js has a polling health helper" "waitHealthy missing"
fi
if grep -q 'sleep(2500)' "$REPO/archrouter.js"; then
  bad "no fixed 2.5s sleep before the health check" "sleep(2500) still present"
else
  ok "no fixed 2.5s sleep before the health check"
fi
for label in "router after update" "router after rollback"; do
  if grep -q "waitHealthy(90000, \"$label\")" "$REPO/archrouter.js"; then
    ok "both restart paths poll ($label)"
  else
    bad "both restart paths poll ($label)" "call not found"
  fi
done

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
