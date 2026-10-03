#!/usr/bin/env bash
# setup.sh — archrouter in one command. Nothing else to type, nothing to debug.
#
#   git clone https://github.com/Monarch505/archrouter ~/archrouter
#   cd ~/archrouter && bash setup.sh
#
# or straight from the internet:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/Monarch505/archrouter/main/setup.sh)
#
# It installs Node 22 if missing (the one prerequisite that used to bite),
# fetches the repo, deploys everything, puts `archrouter` on PATH, starts the
# stack and waits until the API actually answers.
#
# Flags (all optional): --no-warp  skip WARP, serve direct
#                        --no-opencode  don't touch opencode config
#                        --dir PATH   repo location (default ~/archrouter)
#                        --port N     API port (default 20399)

set -uo pipefail

REPO_URL="${ARCHROUTER_REPO_URL:-https://github.com/Monarch505/archrouter.git}"
MIN_NODE_MAJOR=22
HEALTH_TIMEOUT=90
PATH_MARKER="# archrouter (added by setup.sh)"

WANT_WARP=1
WANT_OPENCODE=1
REPO_DIR="${ARCHROUTER_DIR:-$HOME/archrouter}"
API_PORT="${ARCHROUTER_PORT:-20399}"

# ---------------------------------------------------------------- output ----
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=""; G=""; R=""; Y=""; D=""; N=""
fi
step() { printf '\n%s==>%s %s%s%s\n' "$B" "$N" "$B" "$1" "$N"; }
ok()   { printf '  %s[ok]%s %s\n' "$G" "$N" "$1"; }
info() { printf '  %s[..]%s %s\n' "$D" "$N" "$1"; }
warn() { printf '  %s[!!]%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '\n%sFAILED:%s %s\n' "$R" "$N" "$1"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------- node bits ----
node_major() {
  have node >/dev/null 2>&1 || { echo 0; return; }
  node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0
}

node_ok() { [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ]; }

# Family of the running distro, from os-release. Echoes debian|rhel|alpine|arch|
# termux|darwin|other.
distro_family() {
  local id="" like="" f="${1:-/etc/os-release}"
  if [ -r "$f" ]; then
    id=$(sed -n 's/^ID=//p' "$f" | tr -d '"' | tr '[:upper:]' '[:lower:]')
    like=$(sed -n 's/^ID_LIKE=//p' "$f" | tr -d '"' | tr '[:upper:]' '[:lower:]')
  fi
  if [ -n "${PREFIX:-}" ] && case "$PREFIX" in *com.termux*) true;; *) false;; esac; then
    echo termux; return
  fi
  case "$id $like" in
    *debian*|*ubuntu*|*kali*) echo debian;;
    *fedora*|*rhel*|*centos*|*rocky*|*almalinux*) echo rhel;;
    *alpine*) echo alpine;;
    *arch*|*manjaro*) echo arch;;
    *darwin*|*macos*) echo darwin;;
    "") if [ "$(uname -s)" = "Darwin" ]; then echo darwin; else echo other; fi;;
    *) echo other;;
  esac
}

# How to install Node 22 for a family. Echoes a shell snippet; empty means
# "cannot automate, tell the user what to run".
node_installer_cmd() {
  case "$(distro_family "${1:-}")" in
    termux) echo 'pkg install -y nodejs || pkg install -y nodejs-lts';;
    debian) echo 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs';;
    rhel)   echo 'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && dnf install -y nodejs';;
    alpine) echo 'apk add --no-cache nodejs-current';;
    arch)   echo 'pacman -Sy --noconfirm nodejs';;
    darwin) echo 'brew install node@22';;
    *)      echo '';;
  esac
}

# Root, or sudo, or nothing — decides whether the installer needs elevation.
elevate() {
  if [ "$(id -u)" = "0" ]; then echo ""; return; fi
  if have sudo; then echo "sudo"; return; fi
  echo ""
}

install_node() {
  step "Node.js $MIN_NODE_MAJOR+"
  if node_ok; then
    ok "node $(node -v) already present"
    return 0
  fi
  if have node; then
    warn "node $(node -v) is too old (need >= $MIN_NODE_MAJOR) — replacing it"
  else
    info "node not found — installing it for you"
  fi

  local sudo_cmd cmd family
  sudo_cmd=$(elevate)
  family=$(distro_family)

  if [ "$family" = "darwin" ] && have brew; then
    eval "$(node_installer_cmd)" || true
  elif [ "$family" = "termux" ]; then
    eval "$(node_installer_cmd)"
  else
    if ! have curl; then
      case "$family" in
        debian) $sudo_cmd apt-get update -qq && $sudo_cmd apt-get install -y -qq curl ca-certificates;;
        rhel)   $sudo_cmd dnf install -y -q curl ca-certificates;;
        alpine) $sudo_cmd apk add --no-cache curl ca-certificates;;
        arch)   $sudo_cmd pacman -Sy --noconfirm curl ca-certificates;;
      esac
    fi
    cmd=$(node_installer_cmd)
    if [ -n "$cmd" ]; then
      info "running: $cmd"
      eval "$sudo_cmd $cmd" || true
    fi
  fi

  # A fresh install can land somewhere the current shell is not looking yet.
  local p
  for p in /usr/local/bin /usr/bin "$HOME/.local/bin"; do
    if [ -x "$p/node" ]; then
      case ":$PATH:" in *":$p:"*) ;; *) PATH="$p:$PATH";; esac
    fi
  done
  export PATH

  if node_ok; then
    ok "node $(node -v) ready"
    return 0
  fi

  # Last resort, and the only one that works without root.
  warn "still no node $MIN_NODE_MAJOR+ — falling back to nvm (no root needed)"
  if have curl; then
    export NVM_DIR="$HOME/.nvm"
    mkdir -p "$NVM_DIR"
    if curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh -o "$NVM_DIR/install.sh"; then
      bash "$NVM_DIR/install.sh" >/dev/null 2>&1 || true
      # shellcheck disable=SC1091
      [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
      nvm install 22 >/dev/null 2>&1 || true
      nvm use 22 >/dev/null 2>&1 || true
    fi
  fi
  if node_ok; then
    ok "node $(node -v) ready via nvm"
    return 0
  fi

  cat >&2 <<EOF

  Node $MIN_NODE_MAJOR+ could not be installed automatically.
  Install it, then run this script again:

    Debian/Ubuntu/Kali : curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
    Fedora/RHEL        : curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && dnf install -y nodejs
    Alpine             : apk add nodejs-current
    Termux             : pkg install nodejs
    Arch               : pacman -S nodejs
    any/unknown        : curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22

EOF
  return 1
}

# ------------------------------------------------------------------ repo ----
have git || die "git is required and was not found. Install it, then re-run:
    Debian/Ubuntu/Kali : sudo apt-get install -y git
    Fedora/RHEL        : sudo dnf install -y git
    Alpine             : sudo apk add git
    Arch               : sudo pacman -S git"

fetch_repo() {
  step "Source"
  # Resolved per call so ARCHROUTER_REPO_URL can point at a mirror or a test repo.
  local repo_url="${ARCHROUTER_REPO_URL:-$REPO_URL}"
  if [ -d "$REPO_DIR/.git" ]; then
    ok "already cloned at $REPO_DIR"
    git -C "$REPO_DIR" fetch -q origin || warn "could not reach GitHub — staying on the local copy"
    local head remote
    remote=$(git -C "$REPO_DIR" rev-parse --verify origin/main 2>/dev/null) || return 0
    head=$(git -C "$REPO_DIR" rev-parse HEAD)
    if [ "$head" = "$remote" ]; then ok "up to date ($(git -C "$REPO_DIR" rev-parse --short HEAD))"; return 0; fi
    if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then
      warn "local edits in the repo — keeping them and not overwriting"
      return 0
    fi
    git -C "$REPO_DIR" reset --hard -q "$remote" && ok "updated to $(git -C "$REPO_DIR" rev-parse --short HEAD)"
    return 0
  fi

  local parent
  parent=$(dirname "$REPO_DIR")
  mkdir -p "$parent" || die "cannot create $parent"
  info "cloning $repo_url -> $REPO_DIR"
  git clone --depth 1 "$repo_url" "$REPO_DIR" || die "git clone failed. Check your internet connection."
  ok "cloned"
}

# ----------------------------------------------------------------- PATH ----
persist_path() {
  step "PATH"
  local changed=0 rc
  for rc in "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$rc" ] || touch "$rc" 2>/dev/null || continue
    grep -qF "$PATH_MARKER" "$rc" && continue
    {
      echo ""
      echo "$PATH_MARKER"
      echo 'case ":$PATH:" in'
      echo '  *":$HOME/.local/bin:"*) ;;'
      echo '  *) PATH="$HOME/.local/bin:$PATH" ;;'
      echo 'esac'
      echo 'export PATH'
    } >> "$rc" && changed=1
  done
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) PATH="$HOME/.local/bin:$PATH"; export PATH; changed=1;;
  esac
  [ "$changed" = "1" ] && ok "~/.local/bin added to PATH (new terminals too)" || ok "PATH already set"
}

# --------------------------------------------------------------- deploy ----
deploy() {
  step "Deploy (warp accounts, binaries, stack)"
  chmod +x "$REPO_DIR/archrouter" "$REPO_DIR/install.sh" 2>/dev/null || true

  local log="$HOME/.archrouter/data/logs/install.log"
  mkdir -p "$(dirname "$log")"

  # tee, never head/tail: this prints the one-and-only API key and truncating
  # the pipeline would kill the installer mid-flight.
  ( cd "$REPO_DIR" && node install.js --unattended 2>&1 | tee "$log" )
  local rc=${PIPESTATUS[0]}
  INSTALL_LOG="$log"

  # install.js exits 1 when it counted any bad() line, which can be a cosmetic
  # check (a port probe, an upstream ping) while the stack is in fact serving.
  # The health check decides, not the exit code — aborting here used to throw
  # away a working install.
  if [ "$rc" -ne 0 ]; then
    warn "install.js reported a problem (exit $rc) — carrying on, the health check below decides"
    warn "details: grep '\\[!!\\]' $log"
  else
    ok "install.js finished"
  fi
}

# The key is shown once by design. A user who scrolls past it would be locked
# out with no way back, so keep a private copy.
save_first_key() {
  local dest="$HOME/.archrouter/data/first-key.txt"
  mkdir -p "$(dirname "$dest")"
  if [ -s "$dest" ]; then
    ok "a first-run key was already saved at $dest"
    return 0
  fi
  [ -n "${INSTALL_LOG:-}" ] && [ -r "$INSTALL_LOG" ] || return 0
  local key
  key=$(grep -oE 'sk-arch-[A-Za-z0-9_-]{32}' "$INSTALL_LOG" 2>/dev/null | head -1)
  [ -n "$key" ] || return 0
  ( umask 077; printf '%s\n' "$key" > "$dest" )
  chmod 600 "$dest" 2>/dev/null || true
  ok "API key saved to $dest (only you can read it)"
}

# Node is guaranteed present by this point, so it is the primary probe: curl
# can be missing, aliased or a broken wrapper (git-bash ships one that exits
# 127), and a false "API is down" here would abort a perfectly good setup.
probe_health() {
  node -e "
    const u = process.argv[1];
    const req = require('http').get(u, (r) => process.exit(r.statusCode === 200 ? 0 : 1));
    req.on('error', () => process.exit(1));
    req.setTimeout(3000, () => { req.destroy(); process.exit(1); });
  " "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && return 0
  if have curl; then
    curl -fsS --max-time 3 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && return 0
  fi
  return 1
}

wait_healthy() {
  step "Waiting for the API"
  local i=0
  while [ $i -lt "$HEALTH_TIMEOUT" ]; do
    if probe_health; then ok "API answers on :$API_PORT"; return 0; fi
    i=$((i + 2))
    [ $((i % 10)) -eq 0 ] && info "still waiting ($i s)"
    sleep 2
  done
  warn "API did not answer within ${HEALTH_TIMEOUT}s"
  return 1
}

# ------------------------------------------------------------- opencode ----
wire_opencode() {
  step "opencode"
  if ! have opencode; then
    info "opencode is not installed here — skipped (nothing to wire)"
    return 0
  fi
  ( cd "$REPO_DIR" && node archrouter.js connect-opencode ) \
    && ok "provider entry written to your opencode.json" \
    || warn "could not write opencode.json — run: archrouter connect-opencode"
}

# ----------------------------------------------------------------- main ----
main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-warp) WANT_WARP=0; shift;;
      --no-opencode) WANT_OPENCODE=0; shift;;
      --dir) REPO_DIR="$2"; shift 2;;
      --port) API_PORT="$2"; export ARCHROUTER_PORT="$2"; shift 2;;
      -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
      *) die "unknown option '$1' (try --help)";;
    esac
  done

  printf '%sarchrouter setup%s — one command, then it just runs.%s\n' "$B" "$B" "$N"
  [ "$(id -u)" = "0" ] && info "running as root — fine, no service is installed"

  # ~/.local/bin is on PATH for future shells but not the one running this script,
# so `archrouter` would be "command not found" the moment setup finishes. Linking
# into a directory that is already on PATH fixes it for this shell too.
ensure_callable_now() {
  if command -v archrouter >/dev/null 2>&1; then
    ok "archrouter is callable in this shell"
    return 0
  fi
  local target
  for target in /usr/local/bin /usr/bin; do
    if [ -d "$target" ] && [ -w "$target" ]; then
      if ln -sf "$HOME/.local/bin/archrouter" "$target/archrouter" 2>/dev/null; then
        case ":$PATH:" in *":$target:"*) ;; *) PATH="$target:$PATH"; export PATH;; esac
        ok "linked archrouter into $target so it works right now"
        return 0
      fi
    fi
  done
  warn "archrouter will only be callable in a NEW terminal — run this once:"
  printf '      source %s/.bashrc\n' "$HOME"
  printf '      (or use: node %s/archrouter.js status)\n' "$REPO_DIR"
  return 1
}

install_node || exit 1
  fetch_repo
  persist_path
  deploy
  # Rescue the key before anything that can fail. It is printed once and only
  # its hash is stored, so a failure after this point must not cost it.
  save_first_key
  CALLABLE=1
  ensure_callable_now || CALLABLE=0

  if ! wait_healthy; then
    printf '\n%sStill not answering. Diagnostics:%s\n' "$Y" "$N"
    ( cd "$REPO_DIR" && node archrouter.js doctor ) || true
    die "setup did not reach a healthy state"
  fi

  step "Status"
  ( cd "$REPO_DIR" && node archrouter.js status ) || true

  [ "$WANT_OPENCODE" = "1" ] && wire_opencode

  local dash="http://127.0.0.1:$API_PORT/"
  printf '\n%s%sDONE%s  archrouter is running.\n\n' "$G" "$B" "$N"
  if [ "${CALLABLE:-1}" = "0" ]; then
    printf '  %sfirst: source %s/.bashrc  (or open a new terminal)%s\n\n' "$Y" "$HOME" "$N"
  fi
  cat <<EOF
  dashboard   $dash
  models      only the -free tier; paid ids are refused
  opencode    /connect -> Other -> archrouter -> paste the key printed above
              (already did that? it is saved in your opencode session)

  archrouter status      # pids, egress IPs, invariant_ok
  archrouter doctor      # full health check
  archrouter stop        # stop everything (there is no autostart)
  archrouter update      # pull a newer version and restart

  If the key scrolled away: create another with  archrouter key
EOF
}

# Sourcing this file with ARCHROUTER_SETUP_LIB=1 exposes the helpers only.
if [ "${ARCHROUTER_SETUP_LIB:-0}" != "1" ]; then
  main "$@"
fi