#!/usr/bin/env bash
# install.sh — thin shim. The real installer is install.js (cross-OS Node:
# Linux / Termux / Windows). Kept so the documented one-liner keeps working.
#
# Note: node >= 22 is required to RUN this installer. If you have no node yet
# on Termux: `pkg install nodejs` first (and if that lands an older build, the
# installer will tell you).
set -u

src="${BASH_SOURCE[0]}"
while [ -L "$src" ]; do
  d="$(cd -P "$(dirname "$src")" && pwd)"
  src="$(readlink "$src")"
  case "$src" in
    /*) ;;
    *) src="$d/$src" ;;
  esac
done
dir="$(cd -P "$(dirname "$src")" && pwd)"

exec node "$dir/install.js" "$@"