#!/usr/bin/env bash
# Retire a mirror deployment so this git checkout becomes the only live copy.
#
# Why this exists: scripts/service.sh already installs terminal-web repo-live on
# macOS (launchd) and Linux (systemd --user) — the service runs straight out of
# the checkout. One host deviates: the WSL box set up by
# scripts/wsl-install-stack.sh runs a *system-wide* unit out of a separate
# /opt/terminal-web copy kept in sync by rsync. That split is what lets the live
# UI silently drift from the repo. This script closes the gap on such a host and
# is a deliberate no-op everywhere else.
#
# Usage:
#   sudo bash scripts/use-repo-as-live.sh              # mirror -> repo-live
#   sudo bash scripts/use-repo-as-live.sh --rollback   # back to the mirror
#   bash scripts/use-repo-as-live.sh --status          # report only (no root)
#
# It overrides the unit with a systemd drop-in rather than editing the unit
# file, so the original stays byte-for-byte intact and rollback is a file
# deletion. The old mirror is renamed, never deleted; remove it yourself once
# you trust the new layout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OS="$(uname -s)"
UNIT="${UNIT:-terminal-web}"
LABEL="${LABEL:-com.aaronfei.terminal-web}"
DROPIN_DIR="/etc/systemd/system/${UNIT}.service.d"
DROPIN="${DROPIN_DIR}/repo-live.conf"

say() { printf '\n==> %s\n' "$*"; }
die() {
  echo "error: $*" >&2
  exit 1
}

MODE="switch"
case "${1-}" in
  --rollback) MODE="rollback" ;;
  --status) MODE="status" ;;
  -h | --help)
    sed -n '2,22p' "${BASH_SOURCE[0]}"
    exit 0
    ;;
  "") ;;
  *) die "unknown option '${1}' (try --help)" ;;
esac

# --- where does this machine actually serve from? ----------------------------
LIVE_DIR=""
KIND="none" # launchd | systemd-user | systemd-system | none

detect_live() {
  if [ "${OS}" = "Darwin" ]; then
    local plist="${HOME}/Library/LaunchAgents/${LABEL}.plist"
    [ -f "${plist}" ] || return 0
    LIVE_DIR="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "${plist}" 2>/dev/null || true)"
    KIND="launchd"
    return 0
  fi
  command -v systemctl >/dev/null 2>&1 || return 0
  if [ "$(systemctl --user show "${UNIT}" -p LoadState --value 2>/dev/null || true)" = "loaded" ]; then
    LIVE_DIR="$(systemctl --user show "${UNIT}" -p WorkingDirectory --value 2>/dev/null || true)"
    KIND="systemd-user"
    return 0
  fi
  if [ "$(systemctl show "${UNIT}" -p LoadState --value 2>/dev/null || true)" = "loaded" ]; then
    LIVE_DIR="$(systemctl show "${UNIT}" -p WorkingDirectory --value 2>/dev/null || true)"
    KIND="systemd-system"
    return 0
  fi
}

detect_live
RETIRED="${LIVE_DIR}.retired"

show_status() {
  say "Live copy on this machine"
  echo "    os:        ${OS}"
  echo "    service:   ${KIND}"
  echo "    serves:    ${LIVE_DIR:-<no service found>}"
  echo "    this repo: ${REPO_ROOT}"
  if [ -n "${LIVE_DIR}" ] && [ "${LIVE_DIR}" = "${REPO_ROOT}" ]; then
    echo "    layout:    repo-live (already the single copy)"
  elif [ -n "${LIVE_DIR}" ]; then
    echo "    layout:    mirror (repo is NOT what runs)"
  fi
  [ -f "${DROPIN}" ] && echo "    drop-in:   present (${DROPIN})"
  [ -n "${LIVE_DIR}" ] && [ -d "${RETIRED}" ] && echo "    retired:   ${RETIRED} (kept for rollback)"
  return 0
}

if [ "${MODE}" = "status" ]; then
  show_status
  exit 0
fi

# --- refuse politely where there is nothing to fix ---------------------------
if [ "${KIND}" = "none" ]; then
  show_status
  die "no terminal-web service is installed here — install one with:
       bash scripts/service.sh install"
fi

if [ "${KIND}" = "launchd" ] || [ "${KIND}" = "systemd-user" ]; then
  show_status
  say "Nothing to do — scripts/service.sh installs this host repo-live already.
    This script only exists for the system-wide + mirror layout (the WSL box).
    Nothing was changed."
  exit 0
fi

if [ "${MODE}" = "switch" ] && [ "${LIVE_DIR}" = "${REPO_ROOT}" ]; then
  show_status
  say "Already repo-live. Nothing was changed."
  exit 0
fi

[ "$(id -u)" -eq 0 ] || die "must run as root (it writes under /etc/systemd) — use: sudo bash $0 $*"

# --- rollback ----------------------------------------------------------------
if [ "${MODE}" = "rollback" ]; then
  [ -f "${DROPIN}" ] || die "no drop-in at ${DROPIN} — this host was not switched by this script"
  # The drop-in records what it displaced, so rollback does not have to guess.
  prev="$(sed -n 's/^# previous-live-dir: //p' "${DROPIN}" | head -1)"
  if [ -n "${prev}" ] && [ ! -d "${prev}" ] && [ -d "${prev}.retired" ]; then
    say "Restoring ${prev}.retired -> ${prev}"
    mv "${prev}.retired" "${prev}"
  fi
  say "Removing drop-in"
  rm -f "${DROPIN}"
  rmdir "${DROPIN_DIR}" 2>/dev/null || true
  systemctl daemon-reload
  systemctl restart "${UNIT}"
  detect_live
  show_status
  say "Rolled back."
  exit 0
fi

# --- switch ------------------------------------------------------------------
MIRROR_DIR="${LIVE_DIR}"
RETIRED="${MIRROR_DIR}.retired"

say "Pre-flight"
echo "    mirror in use: ${MIRROR_DIR}"
echo "    switching to:  ${REPO_ROOT}"
[ -d "${REPO_ROOT}/node_modules" ] || die "${REPO_ROOT}/node_modules missing — run 'npm install' in the repo first"
[ -f "${REPO_ROOT}/node_modules/tsx/dist/cli.mjs" ] || die "tsx not installed in the repo — run 'npm install'"
[ -f "${REPO_ROOT}/src/server.ts" ] || die "${REPO_ROOT}/src/server.ts missing"
[ -f "${REPO_ROOT}/public/dist/terminal.js" ] || die "client bundle missing — run 'npm run build' in the repo first"

# node-pty ships per-platform prebuilds; loading the native .node off an unusual
# filesystem (a 9p-mounted Windows drive, a network share) is the one thing that
# could plausibly break a repo-live switch. Prove it before touching systemd.
say "Verifying node-pty can spawn from ${REPO_ROOT}"
(cd "${REPO_ROOT}" && timeout 30 node -e "
const pty = require('node-pty');
const p = pty.spawn('/bin/echo', ['ok'], {name:'xterm-256color', cols:80, rows:24});
p.onExit(({exitCode}) => process.exit(exitCode));
setTimeout(() => { console.error('node-pty spawn timed out'); process.exit(1); }, 10000);
") || die "node-pty could not spawn from ${REPO_ROOT} — aborting, nothing was changed"
echo "    ok"

NODE_BIN="$(command -v node)"
[ -n "${NODE_BIN}" ] || die "node not found on PATH"

# If the repo lives on a separate mount, systemd must wait for it. Derive the
# mount point instead of hardcoding one, so this works for a Windows drive under
# WSL, an external disk, or a plain / checkout alike.
mount_point_for() {
  if command -v findmnt >/dev/null 2>&1; then
    findmnt -no TARGET --target "$1" 2>/dev/null
  else
    df -P "$1" 2>/dev/null | awk 'NR==2 {print $6}'
  fi
}
MP="$(mount_point_for "${REPO_ROOT}")"
MOUNT_LINE=""
if [ -n "${MP}" ] && [ "${MP}" != "/" ]; then
  MOUNT_LINE="RequiresMountsFor=${MP}"
  echo "    repo is on mount ${MP}; unit will wait for it"
fi

say "Writing drop-in ${DROPIN}"
mkdir -p "${DROPIN_DIR}"
cat > "${DROPIN}" <<EOF
# Generated by scripts/use-repo-as-live.sh — makes the git checkout the live
# copy. Delete this file and daemon-reload to fall back to the stock unit.
# previous-live-dir: ${MIRROR_DIR}
[Unit]
${MOUNT_LINE}

[Service]
WorkingDirectory=${REPO_ROOT}
# Loading node_modules off a slow filesystem can take ~10s versus ~0.5s on a
# local disk; be explicit so a slow day does not trip the start timeout.
TimeoutStartSec=180
ExecStart=
ExecStart=${NODE_BIN} ${REPO_ROOT}/node_modules/tsx/dist/cli.mjs ${REPO_ROOT}/src/server.ts
EOF

say "Reloading systemd and restarting ${UNIT}"
systemctl daemon-reload
systemctl restart "${UNIT}"

# --- verify ------------------------------------------------------------------
say "Verifying"
state="$(systemctl is-active "${UNIT}" || true)"
echo "    unit: ${state}"
[ "${state}" = "active" ] || die "unit is ${state} — roll back with: sudo bash $0 --rollback"

wd="$(systemctl show "${UNIT}" -p WorkingDirectory --value)"
echo "    WorkingDirectory: ${wd}"
[ "${wd}" = "${REPO_ROOT}" ] || die "unit still serves ${wd} — roll back with: sudo bash $0 --rollback"

unit_env="$(systemctl show "${UNIT}" -p Environment --value 2>/dev/null || true)"
env_val() { printf '%s' "${unit_env}" | tr ' ' '\n' | sed -n "s/^$1=//p" | head -1; }
host="$(env_val HOST)"
port="$(env_val PORT)"
[ -n "${port}" ] || port="$(sed -n 's/^PORT=\([0-9]\+\).*/\1/p' "${REPO_ROOT}/.env" 2>/dev/null | head -1)"
port="${port:-8090}"
case "${host}" in "" | "0.0.0.0" | "::") host="127.0.0.1" ;; esac

ok=0
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://${host}:${port}/" 2>/dev/null || true)"
  if [ -n "${code}" ] && [ "${code}" != "000" ]; then
    echo "    http://${host}:${port}/ -> ${code}"
    ok=1
    break
  fi
  sleep 0.5
done
[ "${ok}" -eq 1 ] || die "port ${port} never responded — roll back with: sudo bash $0 --rollback"

# Only retire the mirror once the new layout is proven to serve traffic.
if [ -d "${MIRROR_DIR}" ]; then
  say "Retiring ${MIRROR_DIR} -> ${RETIRED}"
  rm -rf "${RETIRED}"
  mv "${MIRROR_DIR}" "${RETIRED}"
  echo "    kept for rollback; delete when happy: sudo rm -rf ${RETIRED}"
fi

detect_live
show_status
say "Done — ${REPO_ROOT} is now the only live copy.
    Deploying from here on is just: bash scripts/deploy.sh"
