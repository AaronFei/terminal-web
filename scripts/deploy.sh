#!/usr/bin/env bash
# Build the client bundle and deploy it to whichever copy this machine serves.
#
# Two layouts exist in the wild, so this auto-detects rather than assuming:
#
#   repo-live  The service runs straight out of this checkout. This is what
#              scripts/service.sh installs on both macOS (launchd) and Linux
#              (systemd --user), so it is the normal case. Deploy = build +
#              restart; there is nothing to copy.
#
#   mirror     The service runs from a separate directory (e.g. /opt/terminal-web
#              on the WSL box, created by scripts/wsl-install-stack.sh, driven by
#              a system-wide unit). Editing this repo changes nothing until the
#              tree is mirrored across. Deploy = build + rsync + restart.
#
# Usage:
#   bash scripts/deploy.sh                 # build + deploy + restart + verify
#   bash scripts/deploy.sh --dry-run       # report only; change nothing
#   bash scripts/deploy.sh --no-build      # deploy the existing public/dist
#   bash scripts/deploy.sh --no-restart    # put files in place, leave the
#                                          #   old process running
#
# Env overrides:
#   APP_DIR=<path>   mirror target, when detection cannot find the live copy
#   UNIT=<name>      systemd unit name   (default: terminal-web)
#   LABEL=<label>    launchd label       (default: com.aaronfei.terminal-web)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OS="$(uname -s)"
UNIT="${UNIT:-terminal-web}"
LABEL="${LABEL:-com.aaronfei.terminal-web}"

DO_BUILD=1
DO_RESTART=1
DRY_RUN=0

for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    --no-build) DO_BUILD=0 ;;
    --no-restart) DO_RESTART=0 ;;
    -h | --help)
      sed -n '2,30p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "error: unknown option '${arg}' (try --help)" >&2
      exit 2
      ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() {
  echo "error: $*" >&2
  exit 1
}

cd "${REPO_ROOT}"

# --- detect the live copy ----------------------------------------------------
# LIVE_DIR    where the running service serves from ("" if no service found)
# RESTART_VIA service-sh | sudo-systemd | none
LIVE_DIR=""
RESTART_VIA="none"
UNIT_ENV=""

detect_live() {
  if [ "${OS}" = "Darwin" ]; then
    local plist="${HOME}/Library/LaunchAgents/${LABEL}.plist"
    [ -f "${plist}" ] || return 0
    LIVE_DIR="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "${plist}" 2>/dev/null || true)"
    # PlistBuddy is the only reliable reader for the nested env dict.
    local h p
    h="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:HOST' "${plist}" 2>/dev/null || true)"
    p="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:PORT' "${plist}" 2>/dev/null || true)"
    UNIT_ENV="HOST=${h} PORT=${p}"
    RESTART_VIA="service-sh"
    return 0
  fi

  command -v systemctl >/dev/null 2>&1 || return 0

  # A user unit is what service.sh installs, so it wins over a system unit if
  # both somehow exist.
  if [ "$(systemctl --user show "${UNIT}" -p LoadState --value 2>/dev/null || true)" = "loaded" ]; then
    LIVE_DIR="$(systemctl --user show "${UNIT}" -p WorkingDirectory --value 2>/dev/null || true)"
    UNIT_ENV="$(systemctl --user show "${UNIT}" -p Environment --value 2>/dev/null || true)"
    RESTART_VIA="service-sh"
    return 0
  fi

  if [ "$(systemctl show "${UNIT}" -p LoadState --value 2>/dev/null || true)" = "loaded" ]; then
    LIVE_DIR="$(systemctl show "${UNIT}" -p WorkingDirectory --value 2>/dev/null || true)"
    UNIT_ENV="$(systemctl show "${UNIT}" -p Environment --value 2>/dev/null || true)"
    # A system unit needs root to restart; service.sh only speaks --user.
    RESTART_VIA="sudo-systemd"
    return 0
  fi
}

detect_live

if [ -z "${LIVE_DIR}" ]; then
  MODE="none"
elif [ "${LIVE_DIR}" = "${REPO_ROOT}" ]; then
  MODE="repo-live"
else
  MODE="mirror"
fi

# --- report what is about to ship -------------------------------------------
# Deploying uncommitted work is allowed — often the point of a test deploy — but
# it must never be silent. An unnoticed dirty tree is exactly how a live UI ends
# up differing from what GitHub shows.
say "Source: ${REPO_ROOT}"
if git rev-parse --git-dir >/dev/null 2>&1; then
  echo "    HEAD:   $(git log -1 --format='%h %s')"
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [ -n "${upstream}" ]; then
    echo "    vs ${upstream}: $(git rev-list --count "${upstream}..HEAD") ahead, $(git rev-list --count "HEAD..${upstream}") behind"
  fi
  dirty="$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
  if [ "${dirty}" -gt 0 ]; then
    echo "    WARNING: ${dirty} tracked file(s) modified but not committed —"
    echo "             what you deploy will NOT match GitHub."
    git status --short --untracked-files=no | sed 's/^/               /'
  fi
fi

case "${MODE}" in
  repo-live) echo "    layout: repo-live (service runs from this checkout; no copy step)" ;;
  mirror) echo "    layout: mirror -> ${LIVE_DIR}" ;;
  none) echo "    layout: no installed service found on this machine" ;;
esac
echo "    os:     ${OS}"

if [ "${MODE}" = "mirror" ]; then
  APP="${APP_DIR:-${LIVE_DIR}}"
  [ -d "${APP}" ] || die "mirror target ${APP} does not exist"
  [ -w "${APP}" ] || die "mirror target ${APP} is not writable by $(id -un)"
fi

# --- build -------------------------------------------------------------------
# public/dist is gitignored, so it exists only where it was built; rebuilding
# keeps the bundle in step with web/ instead of shipping a stale one.
if [ "${DO_BUILD}" -eq 1 ]; then
  say "Building client bundle"
  npm run build
else
  say "Skipping build (--no-build)"
  [ -f public/dist/terminal.js ] ||
    die "public/dist/terminal.js missing — drop --no-build for the first deploy"
fi

# --- place the files ---------------------------------------------------------
case "${MODE}" in
  repo-live)
    say "No copy needed — the service serves ${REPO_ROOT} directly"
    if [ "${DRY_RUN}" -eq 1 ]; then
      say "Dry run complete; would restart ${UNIT} only"
      exit 0
    fi
    ;;
  none)
    say "Nothing to deploy to — no service is installed here.
    Install one with: bash scripts/service.sh install"
    exit 0
    ;;
  mirror)
    command -v rsync >/dev/null 2>&1 || die "rsync not found on PATH"
    # Excludes match scripts/wsl-install-stack.sh so the two agree on what the
    # live copy holds. node_modules stays put (installed in place, with
    # platform-specific node-pty prebuilds); scripts/wsl-*.sh are host-setup
    # helpers the server never runs.
    RSYNC_ARGS=(
      -a --delete
      --exclude node_modules
      --exclude .git
      --exclude logs
      --exclude 'scripts/wsl-*.sh'
    )
    if [ "${DRY_RUN}" -eq 1 ]; then
      say "Dry run — changes that WOULD be made to ${APP}"
      rsync "${RSYNC_ARGS[@]}" --dry-run -i "${REPO_ROOT}/" "${APP}/"
      say "Dry run complete; nothing was changed"
      exit 0
    fi
    say "Syncing to ${APP}"
    rsync "${RSYNC_ARGS[@]}" -i "${REPO_ROOT}/" "${APP}/" | sed 's/^/    /'
    ;;
esac

# --- restart -----------------------------------------------------------------
if [ "${DO_RESTART}" -eq 0 ]; then
  say "Skipping restart (--no-restart) — files are updated but the running
    process still holds the old code."
  exit 0
fi

say "Restarting"
case "${RESTART_VIA}" in
  service-sh) bash "${SCRIPT_DIR}/service.sh" restart ;;
  sudo-systemd)
    echo "    system-wide unit — sudo may prompt for your password"
    sudo systemctl restart "${UNIT}"
    ;;
  *) die "no way to restart the service on this machine" ;;
esac

# --- verify ------------------------------------------------------------------
say "Verifying"

# Prefer the host/port the service is actually configured with: HOST may be a
# Tailscale address, in which case 127.0.0.1 is not listening.
env_val() { printf '%s' "${UNIT_ENV}" | tr ' ' '\n' | sed -n "s/^$1=//p" | head -1; }
host="$(env_val HOST)"
port="$(env_val PORT)"
[ -n "${port}" ] || port="$(sed -n 's/^PORT=\([0-9]\+\).*/\1/p' "${REPO_ROOT}/.env" 2>/dev/null | head -1)"
port="${port:-8090}"
case "${host}" in "" | "0.0.0.0" | "::") host="127.0.0.1" ;; esac

# A repo on a slow filesystem (e.g. a 9p-mounted Windows drive under WSL) can
# take ~10s to load node_modules, so allow 30s before declaring failure.
ok=0
for _ in $(seq 1 60); do
  # Any HTTP status means the listener is up; / answers 401 without a token,
  # which is a healthy response here.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
    "http://${host}:${port}/" 2>/dev/null || true)"
  if [ -n "${code}" ] && [ "${code}" != "000" ]; then
    echo "    http://${host}:${port}/ -> ${code}"
    ok=1
    break
  fi
  sleep 0.5
done

if [ "${ok}" -ne 1 ]; then
  echo "    http://${host}:${port}/ did not respond within 30s" >&2
  echo "    logs: bash scripts/service.sh logs" >&2
  exit 1
fi

say "Deployed. Hard-refresh the browser (Ctrl+Shift+R) to drop the cached bundle."
