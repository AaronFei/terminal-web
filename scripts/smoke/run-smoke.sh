#!/usr/bin/env bash
# One smoke pass: a scratch terminal-web server on a scratch tmux socket, a
# headless Chrome, and scripts/smoke/smoke.mjs driving the page between them.
#
# Usage:  npm run smoke          (or: bash scripts/smoke/run-smoke.sh)
#         bash scripts/smoke/run-smoke.sh --screenshots
#         npm run smoke:passkey  (or: bash scripts/smoke/run-smoke.sh --passkey)
#
# --screenshots runs screenshots.mjs instead of the test: it rewrites
# docs/screenshot.png and docs/mobile.png from the same kind of scratch server,
# with a plain `terminal-web $` prompt so nothing about your machine shows.
#
# --passkey runs passkey.mjs: sign-in through a faked Cloudflare (a cf-ray
# header) with test tokens and a virtual WebAuthn authenticator, on
# http://localhost:<port>. That driver starts and restarts the scratch server
# itself (it has to change AUTH_TOKEN mid-test), with the same isolation as
# below, and leaves its PID in <scratch>/server.pid for the cleanup here.
#
# It tests whatever bundle is in public/dist, so run `npm run build` first.
# (It never builds by itself: in a checkout a service runs from, that would
# change the live client.)
#
# Env overrides:
#   CHROME=<path>          Chrome/Chromium binary (default: the usual macOS app,
#                          else google-chrome / chromium on PATH)
#   SMOKE_PORT=<n>         scratch server port   (default 18098)
#   SMOKE_CDP_PORT=<n>     Chrome debugging port (default 9333)
#   SMOKE_KEEP=1           keep the scratch dir (server log, Chrome profile)
#   SMOKE_VERBOSE=1        also print an outline of the page's DOM
#   SMOKE_SHOTS=<dir>      --passkey: save PNGs of the login page and the
#                          Passkeys panel there
#
# Safety. Your own tmux server, and any terminal-web service running as you,
# must come through this untouched:
#   - the server runs with TERMINAL_WEB_TMUX_SOCKET=<unique name>, so every tmux
#     call it makes goes to `tmux -L <name>` (and its snapshots are off);
#   - it runs with HOME set to a scratch dir, so it can't read or write your
#     ~/.terminal-web, ~/terminal-web-uploads or resurrect snapshots, and the
#     tmux config can't load continuum and restore your sessions into it;
#   - TMUX and TMUX_PANE are unset for it and for every tmux call here, because
#     $TMUX overrides everything else and would point at your real server;
#   - it binds 127.0.0.1 on a port other than 8090;
#   - cleanup kills only the PIDs started here, never by name;
#   - the scratch tmux server is killed only after `list-sessions` on it shows
#     nothing but this test's sessions;
#   - your real tmux session list is compared before and after.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}" || exit 1

PORT="${SMOKE_PORT:-18098}"
CDP_PORT="${SMOKE_CDP_PORT:-9333}"

die() { echo "error: $*" >&2; exit 1; }

# The sessions the driver creates; anything else on the scratch socket stops
# the kill-server below.
case "${1:-}" in
  "")
    DRIVER="smoke.mjs"
    EXPECTED_SESSIONS='smoke-a|smoke-b|smoke-a__b'
    ;;
  --passkey)
    DRIVER="passkey.mjs"
    EXPECTED_SESSIONS='pk-a|web'
    ;;
  --screenshots)
    DRIVER="screenshots.mjs"
    EXPECTED_SESSIONS='api|web|logs'
    ;;
  *) die "unknown option '$1' (usage: run-smoke.sh [--screenshots|--passkey])" ;;
esac

# --- prerequisites -----------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node not found on PATH"
command -v tmux >/dev/null 2>&1 || die "tmux not found on PATH"
command -v curl >/dev/null 2>&1 || die "curl not found on PATH"
[ "${PORT}" != "8090" ] || die "SMOKE_PORT must not be 8090 (the default service port)"
[ -x node_modules/.bin/tsx ] || die "node_modules/.bin/tsx missing; run npm install"
[ -f public/dist/terminal.js ] || die "public/dist/terminal.js missing; run npm run build"

if [ -z "${CHROME:-}" ]; then
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    google-chrome google-chrome-stable chromium chromium-browser; do
    if [ -x "${c}" ]; then CHROME="${c}"; break; fi
    if command -v "${c}" >/dev/null 2>&1; then CHROME="$(command -v "${c}")"; break; fi
  done
fi
[ -n "${CHROME:-}" ] && [ -x "${CHROME}" ] || die "no Chrome/Chromium found; set CHROME=/path/to/chrome"

port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$1/" 2>/dev/null
  fi
}
port_busy "${PORT}" && die "port ${PORT} is in use; set SMOKE_PORT"
port_busy "${CDP_PORT}" && die "port ${CDP_PORT} is in use; set SMOKE_CDP_PORT"

# --- scratch state -----------------------------------------------------------
SOCK="tw-smoke-$$-${RANDOM}"
SCR="$(mktemp -d "${TMPDIR:-/tmp}/tw-smoke.XXXXXX")" || die "mktemp failed"
mkdir -p "${SCR}/home"
# Rc files in the scratch HOME: zsh then doesn't offer its new-user setup, and
# the prompt shows no user or host name (screenshots). git's log decorations
# would show the local branch names, so they are off.
printf '%s\n' "PROMPT='%F{cyan}terminal-web%f \$ '" 'export CLICOLOR=1' >"${SCR}/home/.zshrc"
printf '%s\n' "PS1='terminal-web \$ '" >"${SCR}/home/.bashrc"
printf '[log]\n\tdecorate = no\n' >"${SCR}/home/.gitconfig"
echo "socket: -L ${SOCK}"
echo "scratch: ${SCR}"
echo "bundle: public/dist/terminal.js, $(wc -c <public/dist/terminal.js | tr -d ' ') bytes"

# Your real tmux server, read only: its session list now, to compare at the end.
# (No server running is fine; the error text is compared the same way.)
tmux list-sessions -F '#S' >"${SCR}/real-before" 2>&1

SERVER_PID=""
CHROME_PID=""
cleanup() {
  # Our PIDs only. The server's children (tsx runs node as a child) are looked
  # up before it goes, so they can be checked afterwards.
  local kids="" p
  # passkey.mjs runs its own server and removes server.pid once it has stopped
  # it; a file still there means the driver died with the server up.
  if [ -z "${SERVER_PID}" ] && [ -f "${SCR}/server.pid" ]; then
    p="$(cat "${SCR}/server.pid")"
    case "${p}" in
      '' | *[!0-9]*) ;;
      *) SERVER_PID="${p}"; echo "driver left server pid ${p} running; stopping it" ;;
    esac
  fi
  [ -z "${CHROME_PID}" ] || kill "${CHROME_PID}" 2>/dev/null
  if [ -n "${SERVER_PID}" ]; then
    kids="$(pgrep -P "${SERVER_PID}" 2>/dev/null || true)"
    kill "${SERVER_PID}" 2>/dev/null
  fi
  # Up to 5 s for both to go on their own.
  for _ in $(seq 1 20); do
    { [ -n "${CHROME_PID}" ] && kill -0 "${CHROME_PID}" 2>/dev/null; } ||
      { [ -n "${SERVER_PID}" ] && kill -0 "${SERVER_PID}" 2>/dev/null; } || break
    sleep 0.25
  done
  for p in ${kids}; do
    kill -0 "${p}" 2>/dev/null && { echo "server child ${p} still up; killing"; kill "${p}" 2>/dev/null; }
  done
  [ -z "${CHROME_PID}" ] || ! kill -0 "${CHROME_PID}" 2>/dev/null || { echo "chrome still up; SIGKILL"; kill -9 "${CHROME_PID}"; }
  [ -z "${SERVER_PID}" ] || ! kill -0 "${SERVER_PID}" 2>/dev/null || { echo "server still up; SIGKILL"; kill -9 "${SERVER_PID}"; }

  # The scratch tmux server: only if it holds nothing but this test's sessions.
  local listed unexpected
  listed="$(env -u TMUX -u TMUX_PANE tmux -L "${SOCK}" list-sessions -F '#S' 2>/dev/null || true)"
  if [ -n "${listed}" ]; then
    echo "sessions on -L ${SOCK}: $(printf '%s' "${listed}" | tr '\n' ' ')"
    unexpected="$(printf '%s\n' "${listed}" | grep -v -x -E "${EXPECTED_SESSIONS}" || true)"
    if [ -z "${unexpected}" ]; then
      env -u TMUX -u TMUX_PANE tmux -L "${SOCK}" kill-server && echo "killed scratch tmux server -L ${SOCK}"
    else
      echo "UNEXPECTED sessions on -L ${SOCK}, not killing it: ${unexpected}"
    fi
  fi

  tmux list-sessions -F '#S' >"${SCR}/real-after" 2>&1
  if cmp -s "${SCR}/real-before" "${SCR}/real-after"; then
    echo "real tmux sessions unchanged ($(wc -l <"${SCR}/real-before" | tr -d ' ') lines)"
  else
    echo "REAL TMUX SESSIONS CHANGED:"
    diff "${SCR}/real-before" "${SCR}/real-after"
    REAL_CHANGED=1
  fi

  if [ -n "${SMOKE_KEEP:-}" ]; then
    echo "kept ${SCR} (server.log, chrome.log)"
  else
    rm -rf "${SCR}"
  fi
}
REAL_CHANGED=0

# --- scratch server ----------------------------------------------------------
# (passkey.mjs starts its own, with the same environment.)
if [ "${DRIVER}" != "passkey.mjs" ]; then
  env -u TMUX -u TMUX_PANE -u AUTH_TOKEN -u ALLOWED_HOSTS -u DEFAULT_SESSION -u UPLOAD_DIR \
    HOME="${SCR}/home" TERMINAL_WEB_TMUX_SOCKET="${SOCK}" HOST=127.0.0.1 PORT="${PORT}" \
    node_modules/.bin/tsx src/server.ts >"${SCR}/server.log" 2>&1 &
  SERVER_PID=$!
  echo "server pid ${SERVER_PID} on http://127.0.0.1:${PORT}"
  up=0
  for _ in $(seq 1 80); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then up=1; break; fi
    kill -0 "${SERVER_PID}" 2>/dev/null || break
    sleep 0.25
  done
  if [ "${up}" -ne 1 ]; then
    echo "server did not come up; its log:" >&2
    cat "${SCR}/server.log" >&2
    cleanup
    exit 1
  fi
fi

# --- headless Chrome ---------------------------------------------------------
"${CHROME}" --headless=new --remote-debugging-port="${CDP_PORT}" \
  --user-data-dir="${SCR}/chrome" --no-first-run --no-default-browser-check \
  --window-size=1200,800 about:blank >"${SCR}/chrome.log" 2>&1 &
CHROME_PID=$!
echo "chrome pid ${CHROME_PID}"
up=0
for _ in $(seq 1 80); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${CDP_PORT}/json/version" 2>/dev/null; then up=1; break; fi
  kill -0 "${CHROME_PID}" 2>/dev/null || break
  sleep 0.25
done
if [ "${up}" -ne 1 ]; then
  echo "Chrome did not open its debugging port; its log:" >&2
  cat "${SCR}/chrome.log" >&2
  cleanup
  exit 1
fi

# --- the test ----------------------------------------------------------------
echo
if [ "${DRIVER}" = "passkey.mjs" ]; then
  # localhost, not 127.0.0.1: WebAuthn needs a hostname for its RP ID, and
  # http://localhost counts as a secure context.
  node "${SCRIPT_DIR}/${DRIVER}" "${REPO_ROOT}" "${CDP_PORT}" "http://localhost:${PORT}" "${SOCK}" "${SCR}"
else
  node "${SCRIPT_DIR}/${DRIVER}" "${REPO_ROOT}" "${CDP_PORT}" "http://127.0.0.1:${PORT}" "${SOCK}"
fi
SMOKE_EXIT=$?
echo

cleanup
if [ "${REAL_CHANGED}" -ne 0 ]; then exit 1; fi
exit "${SMOKE_EXIT}"
