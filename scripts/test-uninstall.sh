# test-uninstall.sh — asserts archrouter uninstall does exactly what it claims
# and leaves what it promised to keep. Uses a throwaway HOME and ARCHROUTER_HOME
# so nothing real is touched, and stubs the process control.
#
# Run: bash scripts/test-uninstall.sh

set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  [ok] %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n        %s\n' "$1" "${2:-}"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has() { case "$2" in *"$3"*) ok "$1";; *) bad "$1" "'$3' missing from: $2";; esac; }
hasnt() { case "$2" in *"$3"*) bad "$1" "'$3' should not appear in: $2";; *) ok "$1";; esac; }

export HOME="$TMP/home"
# Windows resolves the home directory from USERPROFILE, not HOME. Without this
# the test would delete the real profile's shims — which it did, once.
export USERPROFILE="$TMP/home"
mkdir -p "$HOME"
export ARCHROUTER_HOME="$TMP/archrouter-home"
REPO="$REPO" ARCHROUTER_SETUP_LIB=1 . "$REPO/setup.sh"
REPO_DIR="$REPO"

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
echo shim > "$HOME/.local/bin/archrouter"
# A real shim embeds the absolute path to this repo's archrouter.js; without it
# uninstall cannot prove ownership and must keep the file. Use the same path form
# archrouter.js will compute for itself (pwd -W gives the Windows form under
# git-bash), otherwise the fixture proves nothing.
REPO_ABS="$(cd "$REPO" && (pwd -W 2>/dev/null || pwd))"
NODE_ABS="$(command -v node)"
cat > "$HOME/.local/bin/archrouter" <<EOF
#!/usr/bin/env bash
exec "$NODE_ABS" "$REPO_ABS/archrouter.js" "\$@"
EOF
chmod +x "$HOME/.local/bin/archrouter"
persist_path >/dev/null 2>&1

is "PATH block is in ~/.bashrc before uninstall" \
   "$(grep -c 'archrouter (added by setup.sh)' "$HOME/.bashrc")" "1"

# ---------------------------------------------------------------------------
# Default run: stop, remove shims, remove binaries/logs/pids, keep accounts,
# keep .env, keep the DB and the key.
# ---------------------------------------------------------------------------
out=$(node "$REPO/archrouter.js" uninstall --yes 2>&1); rc=$?
is "uninstall exits 0" "$rc" "0"
if echo "$out" | grep -qE "stopped|not running"; then ok "uninstall reports the stack state"; else bad "uninstall reports the stack state" "neither stopped nor not running in: $(echo "$out" | tr '\n' '|')"; fi
has "uninstall reports what it kept" "$out" "kept"

if [ -f "$HOME/.local/bin/archrouter" ]; then bad "shim removed" "still at ~/.local/bin/archrouter"; else ok "shim removed"; fi
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
# Idempotency: running it twice on a half-removed tree must not explode.
# ---------------------------------------------------------------------------
out2=$(node "$REPO/archrouter.js" uninstall --yes 2>&1); rc2=$?
is "uninstall is safe to run twice" "$rc2" "0"

# ---------------------------------------------------------------------------
# --purge: everything goes, including the WARP accounts.
# ---------------------------------------------------------------------------
out3=$(node "$REPO/archrouter.js" uninstall --yes --purge 2>&1); rc3=$?
is "uninstall --purge exits 0" "$rc3" "0"
if [ -f "$HOMEBASE/warp/warp-a/wgcf-account.toml" ]; then bad "purge removes the warp accounts" "warp-a account still there"; else ok "purge removes the warp accounts"; fi
if [ -f "$HOMEBASE/data/archrouter.db" ]; then bad "purge removes the api key database" "db still there"; else ok "purge removes the api key database"; fi
has "purge warns that the keys are gone for good" "$out3" "key"
has "purge explains WARP accounts must be registered again" "$out3" "warp-setup"

# ---------------------------------------------------------------------------
# Nothing outside the two roots was touched.
# ---------------------------------------------------------------------------
is "the repo was not deleted" "$([ -f "$REPO/setup.sh" ] && echo present)" "present"
if [ -f "$HOME/.bashrc" ]; then ok "~/.bashrc still exists (only our block removed)"; else bad "~/.bashrc still exists" "file gone"; fi

# ---------------------------------------------------------------------------
# A shim belonging to a DIFFERENT install must survive. Regression: an earlier
# version matched any file containing the string "archrouter.js" and happily
# deleted an unrelated, working installation's launcher.
# ---------------------------------------------------------------------------
OTHER_HOME="$TMP/other-install"
mkdir -p "$OTHER_HOME/bin"
cat > "$OTHER_HOME/bin/archrouter" <<EOF
#!/usr/bin/env bash
exec "C:/Program Files/nodejs/node.exe" "$OTHER_HOME/archrouter.js" "\$@"
EOF
chmod +x "$OTHER_HOME/bin/archrouter"
before=$(cat "$OTHER_HOME/bin/archrouter")
# Point uninstall's search at a directory that holds only the foreign shim.
FOREIGN_DIR="$TMP/foreign-bin"
mkdir -p "$FOREIGN_DIR"
cp "$OTHER_HOME/bin/archrouter" "$FOREIGN_DIR/archrouter"

node "$REPO/archrouter.js" uninstall --yes >/dev/null 2>&1
is "a foreign install's shim is left alone" "$([ -f "$OTHER_HOME/bin/archrouter" ] && echo present)" "present"
is "a foreign install's shim is byte-identical" "$(cat "$OTHER_HOME/bin/archrouter")" "$before"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1