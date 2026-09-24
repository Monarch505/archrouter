#!/usr/bin/env bash
# install.sh — one-shot production installer for monarch-router (Linux / Termux).
#
# Usage:
#   ./install.sh [--skip-bins] [--reinstall-bins] [--offline] [--unattended]
#
# --unattended: full one-shot deploy — after install runs warp-setup
#   (idempotent, keeps existing accounts), starts the full stack
#   (warp-a/b → pool → router, MODE=warp), and verifies /health.
#   Clone-based one-liner (curl|bash breaks repo detection):
#   git clone https://github.com/Monarch505/archrouter ~/archrouter \
#     && ~/archrouter/install.sh --unattended
#
# Steps (each verified before continuing, idempotent — safe to re-run):
#   1. detect platform (linux/termux) + arch (x86_64/aarch64)
#   2. install OS deps (curl, ca-certificates, tar, xz) via pkg / apt (+sudo when needed)
#   3. ensure node >= 22 (pkg on termux; official tarball → ~/.local on linux)
#   4. download + verify wgcf + sing-box into $BASE/bin/$ARCH (kept if present+x)
#   5. create base dirs + .env from example
#   6. link launcher into PATH
#   7. run `archrouter doctor` (warp accounts expected-missing until warp-setup)
#
# NEVER: touches .wslconfig, /etc/hosts, host services, or WARP accounts.
# WARP registration stays in `archrouter warp-setup` (idempotent, keeps existing).

set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WGCF_VER="${WGCF_VER:-2.3.0}"
SINGBOX_VER="${SINGBOX_VER:-1.14.1}"
NODE_MAJOR=22

SKIP_BINS=0; REINSTALL_BINS=0; OFFLINE=0; UNATTENDED=0
for a in "$@"; do
  case "$a" in
    --skip-bins) SKIP_BINS=1 ;;
    --reinstall-bins) REINSTALL_BINS=1 ;;
    --offline) OFFLINE=1 ;;
    --unattended) UNATTENDED=1 ;;
    *) echo "[install] unknown flag: $a (see header)"; exit 1 ;;
  esac
done

log()  { echo "[install] $*"; }
ok()   { echo "[install]   [ok] $*"; }
warn() { echo "[install]   [!!] $*"; }
die()  { echo "[install] ERROR: $*" >&2; exit 1; }

# --- 1. platform + arch ---------------------------------------------------------
if [ -n "${PREFIX:-}" ] && [[ "$PREFIX" == *"com.termux"* ]]; then
  PLATFORM="termux"; TARGET_BIN="$PREFIX/bin"
else
  PLATFORM="linux"; TARGET_BIN="$HOME/.local/bin"
fi
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  WGCF_ASSET="linux_amd64"; SB_ASSET="linux-amd64" ;;
  aarch64) WGCF_ASSET="linux_arm64";  SB_ASSET="linux-arm64" ;;
  *) die "unsupported arch: $ARCH (need x86_64/aarch64)" ;;
esac
# Termux quirk: wgcf ships NO android asset — linux static build runs fine;
# sing-box HAS an android asset (required on Termux).
[ "$PLATFORM" = "termux" ] && [ "$ARCH" = "aarch64" ] && SB_ASSET="android-arm64"

BASE="${ARCHROUTER_HOME:-$HOME/.archrouter}"
BINDIR="$BASE/bin/$ARCH"
log "platform=$PLATFORM arch=$ARCH repo=$REPO base=$BASE"

# --- 2. OS deps -----------------------------------------------------------------
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
need_cmd() { command -v "$1" >/dev/null 2>&1; }

install_deps() {
  if [ "$PLATFORM" = "termux" ]; then
    need_cmd pkg && { $SUDO pkg install -y curl ca-certificates tar xz 2>&1 | tail -1 || true; }
  elif need_cmd apt-get; then
    $SUDO apt-get update -qq 2>&1 | tail -1 || true
    $SUDO apt-get install -y -qq curl ca-certificates tar xz-utils git 2>&1 | tail -1 || true
  else
    warn "no pkg/apt-get — assuming curl+tar+xz present"
  fi
  for c in curl tar; do need_cmd "$c" || die "missing required command: $c (install it, or re-run with network on)"; done
  ok "os deps (curl, tar, ca-certificates)"
}
[ "$OFFLINE" -eq 0 ] && install_deps || log "offline: skipping OS dep install"

# --- 3. node >= 22 ---------------------------------------------------------------
node_major() { node -v 2>/dev/null | sed 's/^v//;s/\..*//'; }
ensure_node() {
  if need_cmd node; then
    V="$(node_major)"
    if [ -n "$V" ] && [ "$V" -ge "$NODE_MAJOR" ] 2>/dev/null; then ok "node $(node -v)"; return 0; fi
    warn "node $(node -v 2>/dev/null || echo missing) < $NODE_MAJOR → upgrading"
  fi
  [ "$OFFLINE" -eq 1 ] && die "offline and no node >= $NODE_MAJOR"
  if [ "$PLATFORM" = "termux" ]; then
    pkg install -y nodejs 2>&1 | tail -2 || die "pkg install nodejs failed"
  else
    # Official tarball → ~/.local (no sudo, no distro lag). Resolve latest v22 LTS.
    local ver
    ver="$(curl -sL --max-time 20 https://nodejs.org/dist/index.json \
      | grep -o '"version":"v22[^"]*"' | head -1 | cut -d'"' -f4)"
    [ -n "$ver" ] || die "could not resolve node v22 version (network? try: sudo apt install nodejs)"
    local asset="linux-x64"; [ "$ARCH" = "aarch64" ] && asset="linux-arm64"
    local tgz="/tmp/archrouter-node-$ver.tgz"
    log "downloading node $ver ($asset) ..."
    curl -sL --max-time 120 -o "$tgz" "https://nodejs.org/dist/$ver/node-$ver-$asset.tar.xz" \
      || die "node download failed"
    rm -rf "$HOME/.local/node" && mkdir -p "$HOME/.local"
    tar -xJf "$tgz" -C "$HOME/.local" || die "node extract failed"
    mv "$HOME/.local/node-$ver-$asset" "$HOME/.local/node" || die "node install failed"
    rm -f "$tgz"
    mkdir -p "$HOME/.local/bin"
    ln -sf "$HOME/.local/node/bin/node" "$HOME/.local/bin/node"
    ln -sf "$HOME/.local/node/bin/npm"  "$HOME/.local/bin/npm"
    ln -sf "$HOME/.local/node/bin/npx"  "$HOME/.local/bin/npx" 2>/dev/null || true
    export PATH="$HOME/.local/bin:$PATH"
  fi
  need_cmd node || die "node still missing after install"
  V="$(node_major)"; [ "$V" -ge "$NODE_MAJOR" ] || die "node $(node -v) < $NODE_MAJOR"
  ok "node $(node -v)"
  node -e "require('node:sqlite');console.log('[install]   [ok] node:sqlite')" \
    || warn "node:sqlite unavailable → JSON fallback (D6)"
}
ensure_node

# --- 4. bins --------------------------------------------------------------------
fetch_bins() {
  [ "$SKIP_BINS" -eq 1 ] && { log "bins skipped (--skip-bins)"; return 0; }
  mkdir -p "$BINDIR"
  if [ "$OFFLINE" -eq 1 ]; then
    for b in wgcf sing-box; do
      [ -x "$BINDIR/$b" ] && ok "bin $b (cached)" || warn "bin $b missing (offline — copy manually to $BINDIR/)"
    done
    return 0
  fi
  # wgcf (single static binary — curl -f so a 404 never lands as a "binary")
  if [ -x "$BINDIR/wgcf" ] && [ "$REINSTALL_BINS" -eq 0 ]; then
    ok "bin wgcf (cached)"
  else
    log "downloading wgcf v$WGCF_VER ($WGCF_ASSET) ..."
    curl -fsSL --max-time 120 -o "$BINDIR/wgcf" \
      "https://github.com/ViRb3/wgcf/releases/download/v$WGCF_VER/wgcf_${WGCF_VER}_${WGCF_ASSET}" \
      || { rm -f "$BINDIR/wgcf"; die "wgcf download failed (check asset name for $ARCH)"; }
    chmod +x "$BINDIR/wgcf"
  fi
  [ "$(wc -c <"$BINDIR/wgcf")" -gt 100000 ] \
    || { rm -f "$BINDIR/wgcf"; die "wgcf too small — bad download, re-run with --reinstall-bins"; }
  "$BINDIR/wgcf" --help >/dev/null 2>&1 || die "wgcf failed to run (wrong arch?)"
  ok "bin wgcf v$WGCF_VER"
  # sing-box (tarball, binary inside versioned dir)
  if [ -x "$BINDIR/sing-box" ] && [ "$REINSTALL_BINS" -eq 0 ]; then
    ok "bin sing-box (cached)"
  else
    log "downloading sing-box v$SINGBOX_VER ($SB_ASSET) ..."
    tmpd="$(mktemp -d)"
    curl -sL --max-time 180 -o "$tmpd/sb.tgz" \
      "https://github.com/SagerNet/sing-box/releases/download/v$SINGBOX_VER/sing-box-${SINGBOX_VER}-${SB_ASSET}.tar.gz" \
      || { rm -rf "$tmpd"; die "sing-box download failed"; }
    tar -xzf "$tmpd/sb.tgz" -C "$tmpd" || { rm -rf "$tmpd"; die "sing-box extract failed"; }
    found="$(find "$tmpd" -name sing-box -type f | head -1)"
    [ -n "$found" ] || { rm -rf "$tmpd"; die "sing-box binary not found in tarball"; }
    cp "$found" "$BINDIR/sing-box" && chmod +x "$BINDIR/sing-box"
    rm -rf "$tmpd"
  fi
  "$BINDIR/sing-box" version >/dev/null 2>&1 || die "sing-box failed to run (wrong arch?)"
  ok "bin sing-box v$SINGBOX_VER"
}
fetch_bins

# --- 5. base dirs + env -----------------------------------------------------------
mkdir -p "$BASE/data/logs" "$BASE/warp/warp-a" "$BASE/warp/warp-b"
[ -f "$BASE/.env" ] || cp "$REPO/.env.example" "$BASE/.env"
ok "base=$BASE (+ .env)"

# --- 6. launcher link ---------------------------------------------------------------
mkdir -p "$TARGET_BIN"
ln -sf "$REPO/archrouter" "$TARGET_BIN/archrouter"
chmod +x "$REPO/archrouter" "$TARGET_BIN/archrouter"
ok "linked $TARGET_BIN/archrouter"
case ":$PATH:" in *":$TARGET_BIN:"*) ;; *) warn "$TARGET_BIN not in PATH — add it or use full path" ;; esac

# --- 7. doctor ----------------------------------------------------------------------
log "running doctor (warp accounts expected-missing until warp-setup) ..."
if "$TARGET_BIN/archrouter" doctor; then
  DOCTOR_OK=1
  ok "doctor clean — next: ARCHROUTER_MODE=warp archrouter start"
else
  DOCTOR_OK=0
  log "next: archrouter warp-setup && ARCHROUTER_MODE=warp archrouter start"
fi

# --- 8. unattended one-shot -------------------------------------------------------
# Full deploy: warp-setup (idempotent, keeps existing accounts) → start full
# stack (warp-a/b → pool → router, MODE=warp) → verify /health endpoints.
if [ "$UNATTENDED" -eq 1 ]; then
  [ "$OFFLINE" -eq 1 ] && die "--unattended needs network (drop --offline)"
  log "unattended: warp-setup (idempotent) ..."
  "$TARGET_BIN/archrouter" warp-setup || die "warp-setup failed"
  log "unattended: starting full stack ..."
  ARCHROUTER_MODE=warp "$TARGET_BIN/archrouter" start || die "start failed"
  sleep 3
  log "unattended: verifying ..."
  curl -s --max-time 5 "http://127.0.0.1:${ARCHROUTER_PORT:-20399}/health" \
    && echo && ok "router /health reachable" \
    || warn "router /health not responding yet — check: archrouter status && archrouter logs router"
  curl -s --max-time 5 "http://127.0.0.1:${ARCHROUTER_STATUS_PORT:-9190}/health" \
    && echo && ok "pool /health reachable" \
    || warn "pool /health not responding yet — check: archrouter status && archrouter logs pool"
  "$TARGET_BIN/archrouter" status
  ok "unattended deploy done — smoke test: node $REPO/scripts/e2e-chat.js"
fi
