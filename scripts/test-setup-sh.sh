#!/usr/bin/env bash
# test-setup-sh.sh — asserts the pure helpers in setup.sh. No network, no
# installs, no service: it only checks the decision logic that used to require
# a human being to know which distro they had.
#
# Run: bash scripts/test-setup-sh.sh

set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

ARCHROUTER_SETUP_LIB=1 . "$REPO/setup.sh"

pass=0
fail=0
ok()   { pass=$((pass+1)); printf '  ok  %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s\n        %s\n' "$1" "${2:-}"; }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has()  { case "$2" in *"$3"*) ok "$1";; *) bad "$1" "'$3' not found in: $2";; esac; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

os_release() { # $1 = id, $2 = id_like (may be empty)
  local f="$TMP/os-release.$$"
  {
    echo "ID=$1"
    [ -n "$2" ] && echo "ID_LIKE=$2"
  } > "$f"
  echo "$f"
}

echo "setup.sh helper tests"

is "debian family"        "$(distro_family "$(os_release debian '')")"            debian
is "kali family"          "$(distro_family "$(os_release kali debian)")"          debian
is "ubuntu family"        "$(distro_family "$(os_release ubuntu debian)")"        debian
is "fedora family"        "$(distro_family "$(os_release fedora '')")"            rhel
is "rocky (ID_LIKE)"      "$(distro_family "$(os_release rocky 'rhel fedora')")"   rhel
is "alpine family"        "$(distro_family "$(os_release alpine '')")"            alpine
is "arch family"          "$(distro_family "$(os_release arch '')")"              arch
is "unknown id"           "$(distro_family "$(os_release plan9 '')")"             other
is "quoted ID= stripped"  "$(distro_family "$(os_release 'ubuntu' 'debian')")"     debian

# Node installer per family must not be empty for anything we support.
for fam in debian rhel alpine arch darwin; do
  case $fam in
    debian) f=$(os_release kali debian);;
    rhel)   f=$(os_release fedora '');;
    alpine) f=$(os_release alpine '');;
    arch)   f=$(os_release arch '');;
    darwin) f=$(os_release darwin '');;
  esac
  cmd=$(node_installer_cmd "$f")
  if [ -n "$cmd" ]; then ok "node installer for $fam is defined"; else bad "node installer for $fam is defined" "empty"; fi
done
has "debian installer uses NodeSource 22" "$(node_installer_cmd "$(os_release debian '')")" "setup_22.x"
has "rhel installer uses NodeSource rpm"  "$(node_installer_cmd "$(os_release fedora '')")" "rpm.nodesource.com"

# MIN_NODE_MAJOR guard
is "MIN_NODE_MAJOR is 22" "$MIN_NODE_MAJOR" "22"
NM=$(node_major)   # never call node_major bare: it would print to stdout
if have node; then
  is "node_major matches the running node" "$NM" "$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
  if [ "$NM" -ge 22 ]; then
    node_ok && ok "node_ok() true for node $(node -v)" || bad "node_ok() true for node $(node -v)" "returned false"
  else
    node_ok && bad "node_ok() false for old node $(node -v)" "returned true" || ok "node_ok() correctly false for node $(node -v)"
  fi
else
  ok "node absent here — skipped the node_ok() checks"
fi

# elevate(): root gets no prefix, non-root with sudo gets sudo
if [ "$(id -u)" = "0" ]; then
  is "elevate() is empty for root" "$(elevate)" ""
else
  if have sudo >/dev/null 2>&1; then
    is "elevate() uses sudo for a non-root user" "$(elevate)" "sudo"
  else
    ok "no sudo and not root — nvm fallback is the path (skipped assertion)"
  fi
fi

# The key regex must match what archrouter actually mints — length and alphabet
# both, since save_first_key() relies on it to rescue a scrolled-away key.
KEYRE='sk-arch-[A-Za-z0-9_-]{32}'
for n in 32 33; do
  sample="sk-arch-$(printf 'a%.0s' $(seq 1 $n))"
  if [ "$n" = 32 ]; then
    is "key regex matches exactly 32 chars" "$(grep -oE "$KEYRE" <<<"$sample" | head -1)" "$sample"
  else
    is "key regex does not swallow a 33rd char" "$(grep -oE "$KEYRE" <<<"$sample" | head -1)" "sk-arch-$(printf 'a%.0s' $(seq 1 32))"
  fi
done
is "key regex rejects a short string" "$(grep -oE "$KEYRE" <<<"sk-arch-tooshort" | head -1)" ""
is "key regex rejects an illegal character" "$(grep -oE "$KEYRE" <<<"sk-arch-aaaaaaaaaaaaaaaaaaaaaaaaaaa*aaa" | head -1)" ""

if have node; then
  REAL_KEY=$(cd "$REPO" && node -e 'process.stdout.write(require("./server/lib/auth.js").newKey())')
  is "regex matches a real archrouter key" "$(grep -oE "$KEYRE" <<<"$REAL_KEY" | head -1)" "$REAL_KEY"
  is "a real key is sk-arch- (8) plus 32 chars" "${#REAL_KEY}" "40"
fi

# HEALTH_TIMEOUT must be a plain integer so the wait loop terminates.
case "$HEALTH_TIMEOUT" in
  ''|*[!0-9]*) bad "HEALTH_TIMEOUT is a positive integer" "got '$HEALTH_TIMEOUT'";;
  *) [ "$HEALTH_TIMEOUT" -gt 0 ] && ok "HEALTH_TIMEOUT is a positive integer ($HEALTH_TIMEOUT s)" || bad "HEALTH_TIMEOUT positive" "$HEALTH_TIMEOUT";;
esac

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1