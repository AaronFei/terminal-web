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
#              on the WSL box, created by a host-setup script that lives outside
#              this repo, driven by a system-wide unit). Editing this repo changes
#              nothing until the tree is mirrored across.
#              Deploy = build + rsync + restart.
#
# Before anything restarts, every deploy:
#   - runs `npm ci` when package-lock.json changed since the last install here
#     (hash kept in the untracked .deploy/lock.sha);
#   - typechecks with `npx tsc --noEmit -p .` and stops, unrestarted, on errors.
# After the restart it asks GET /api/health which commit is being served and
# requires it to be this checkout's HEAD; a server without that endpoint, or
# one that cannot tell its commit, gets the plain "does it answer" check.
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
      sed -n '2,35p' "${BASH_SOURCE[0]}"
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

# --- dependencies ------------------------------------------------------------
# node_modules is installed per machine, so a changed package-lock.json has to
# be installed before typechecking or restarting. The lock hash last installed
# here lives in .deploy/lock.sha (untracked). `npm ci` installs exactly what the
# lock says and never rewrites it.
file_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    cksum "$1" | cut -d' ' -f1,2
  fi
}
LOCK_STAMP="${REPO_ROOT}/.deploy/lock.sha"
LOCK_NOW=""
DEPS_STALE=0
if [ -f package-lock.json ]; then
  LOCK_NOW="$(file_hash package-lock.json)"
  lock_then="$(cat "${LOCK_STAMP}" 2>/dev/null || true)"
  if [ "${LOCK_NOW}" = "${lock_then}" ]; then
    say "Dependencies: package-lock.json unchanged since the last install"
  elif [ "${DRY_RUN}" -eq 1 ]; then
    DEPS_STALE=1
    say "Dry run — package-lock.json changed (or no install recorded); would run npm ci"
  else
    if [ -z "${lock_then}" ]; then
      say "Dependencies: no install recorded here yet — running npm ci"
    else
      say "Dependencies: package-lock.json changed since the last install — running npm ci"
    fi
    npm ci
    mkdir -p "$(dirname "${LOCK_STAMP}")"
    printf '%s\n' "${LOCK_NOW}" >"${LOCK_STAMP}"
  fi
fi

# --- typecheck ---------------------------------------------------------------
# Restarting into code that does not typecheck takes the terminal down for
# everyone using it, so stop here instead. Nothing has been copied or restarted
# yet; in the repo-live layout the checkout already holds the new code, but the
# running process keeps the old one until a restart.
if [ "${DEPS_STALE}" -eq 1 ]; then
  say "Dry run — skipping typecheck (node_modules would be reinstalled first)"
else
  say "Typechecking (tsc --noEmit)"
  if ! npx tsc --noEmit -p .; then
    die "typecheck failed — nothing was restarted. Fix the errors above and re-run."
  fi
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
    # Excludes match the WSL host-setup script (wsl-install-stack.sh, kept
    # outside this repo) so the two agree on what the live copy holds.
    # node_modules stays put (installed in place, with platform-specific
    # node-pty prebuilds); scripts/wsl-*.sh are host-setup helpers the server
    # never runs; .deploy is this checkout's own deploy bookkeeping.
    RSYNC_ARGS=(
      -a --delete
      --exclude node_modules
      --exclude .git
      --exclude .deploy
      --exclude logs
      --exclude 'scripts/wsl-*.sh'
    )
    # The mirror's node_modules is installed in place, so it needs its own
    # `npm ci` when the lock it was installed from differs from ours.
    MIRROR_DEPS_STALE=0
    if [ -n "${LOCK_NOW}" ] && [ -f "${APP}/package-lock.json" ] &&
      [ "$(file_hash "${APP}/package-lock.json")" != "${LOCK_NOW}" ]; then
      MIRROR_DEPS_STALE=1
    fi
    if [ "${DRY_RUN}" -eq 1 ]; then
      say "Dry run — changes that WOULD be made to ${APP}"
      rsync "${RSYNC_ARGS[@]}" --dry-run -i "${REPO_ROOT}/" "${APP}/"
      [ "${MIRROR_DEPS_STALE}" -eq 0 ] ||
        echo "    package-lock.json differs from ${APP}'s; would run npm ci there"
      say "Dry run complete; nothing was changed"
      exit 0
    fi
    say "Syncing to ${APP}"
    rsync "${RSYNC_ARGS[@]}" -i "${REPO_ROOT}/" "${APP}/" | sed 's/^/    /'
    if [ "${MIRROR_DEPS_STALE}" -eq 1 ]; then
      say "Dependencies: package-lock.json changed — running npm ci in ${APP}"
      (cd "${APP}" && npm ci) ||
        die "npm ci failed in ${APP} — not restarting; the running process still
       holds the old code. Fix the install there and re-run."
    fi
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
[ -n "${port}" ] || port="$(sed -n 's/^PORT=\([0-9][0-9]*\).*/\1/p' "${REPO_ROOT}/.env" 2>/dev/null | head -1)"
port="${port:-8090}"
case "${host}" in "" | "0.0.0.0" | "::") host="127.0.0.1" ;; esac
base="http://${host}:${port}"

# What should be running: this checkout's HEAD (for a mirror, the HEAD it was
# rsynced from). If the source defines /api/health, a server without it is
# still the old process, not merely older code.
expected=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  expected="$(git rev-parse --short HEAD 2>/dev/null || true)"
fi
src_has_health=0
grep -rqs -- '/api/health' "${REPO_ROOT}/src" && src_has_health=1

body_file="$(mktemp)"
trap 'rm -f "${body_file}"' EXIT

# A repo on a slow filesystem (e.g. a 9p-mounted Windows drive under WSL) can
# take ~10s to load node_modules, so allow 30s for the listener to come up,
# then up to 20s more for the served commit to become HEAD (the old process
# can still be answering while it shuts down).
result=""  # match | nocommit | nohead | nohealth | mismatch | stale
polls=0
first_answer=0 # poll number of the first HTTP answer, 0 = none yet
served=""
code=""
while :; do
  polls=$((polls + 1))
  code="$(curl -s -o "${body_file}" -w '%{http_code}' --max-time 2 \
    "${base}/api/health" 2>/dev/null || true)"
  if [ -z "${code}" ] || [ "${code}" = "000" ]; then
    [ "${first_answer}" -gt 0 ] || [ "${polls}" -lt 60 ] || break
  else
    [ "${first_answer}" -gt 0 ] || first_answer="${polls}"
    # {"ok":true,"commit":"<sha>"|null,...} -> "<sha>" | null | "" (not health)
    commit_raw="$(tr -d '\n' <"${body_file}" |
      sed -nE 's/.*"commit"[[:space:]]*:[[:space:]]*("[^"]*"|null).*/\1/p')"
    if [ "${code}" = "200" ] && [ -n "${commit_raw}" ]; then
      served="$(printf '%s' "${commit_raw}" | tr -d '"')"
      if [ "${commit_raw}" = "null" ] || [ -z "${served}" ]; then
        result="nocommit"
        break
      elif [ -z "${expected}" ]; then
        result="nohead"
        break
      fi
      # Compare as prefixes: two short SHAs of the same commit can differ in
      # length (core.abbrev grows with the repo).
      case "${served}" in "${expected}"*) result="match"; break ;; esac
      case "${expected}" in "${served}"*) result="match"; break ;; esac
      result="mismatch"
    elif [ "${src_has_health}" -eq 0 ]; then
      result="nohealth"
      break
    else
      result="stale"
    fi
  fi
  [ "${first_answer}" -eq 0 ] || [ $((polls - first_answer)) -lt 40 ] || break
  sleep 0.5
done

# Today's check, for servers that cannot report their commit: any HTTP status
# from / means the listener is up (/ answers 401 without a token, which is a
# healthy response here).
listener_check() {
  local c
  c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "${base}/" 2>/dev/null || true)"
  echo "    ${base}/ -> ${c:-000}"
}

case "${result}" in
  match)
    echo "    ${base}/api/health -> commit ${served} (matches HEAD ${expected})"
    ;;
  nocommit)
    echo "    ${base}/api/health -> commit unknown (e.g. a mirror without .git);"
    echo "    fell back to checking that the server answers:"
    listener_check
    ;;
  nohead)
    echo "    ${base}/api/health -> commit ${served}; this checkout has no git HEAD"
    echo "    to compare against, so only checked that the server answers."
    ;;
  nohealth)
    echo "    ${base}/api/health -> HTTP ${code} (this code has no /api/health);"
    echo "    fell back to checking that the server answers:"
    listener_check
    ;;
  mismatch)
    echo "    ${base}/api/health still serves commit ${served}, expected ${expected} (HEAD)," >&2
    echo "    20s after the server answered — the restart did not pick up this checkout." >&2
    echo "    logs: bash scripts/service.sh logs" >&2
    exit 1
    ;;
  stale)
    echo "    ${base}/api/health -> HTTP ${code}, but this checkout defines /api/health:" >&2
    echo "    the old process is still serving 20s after the restart." >&2
    echo "    logs: bash scripts/service.sh logs" >&2
    exit 1
    ;;
  *)
    echo "    ${base}/ did not respond within 30s" >&2
    echo "    logs: bash scripts/service.sh logs" >&2
    exit 1
    ;;
esac

say "Deployed. Hard-refresh the browser (Ctrl+Shift+R) to drop the cached bundle."
