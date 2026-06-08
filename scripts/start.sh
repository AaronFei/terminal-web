#!/usr/bin/env bash
# Start terminal-web in "production-ish" mode:
#   - ensure the client bundle is built
#   - bind the server to the Tailscale IP when available
#   - launch the server (npm start -> tsx src/server.ts)
#
# Usage: bash scripts/start.sh   (or ./scripts/start.sh after chmod +x)
set -euo pipefail

# Resolve the repo root from this script's location so it works no matter
# where it's invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# --- Load optional .env (KEY=VALUE lines) ------------------------------------
# This script (and scripts/dev.sh) load .env; running `npm start` directly does
# NOT auto-load it, so export the vars in your shell in that case.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# --- Prerequisite checks (warn, don't hard-fail) -----------------------------
if ! command -v tmux >/dev/null 2>&1; then
  echo "WARNING: 'tmux' not found on PATH. The server spawns tmux per connection;" >&2
  echo "         install it (e.g. 'brew install tmux') or sessions will fail." >&2
fi

if ! command -v tailscale >/dev/null 2>&1; then
  echo "WARNING: 'tailscale' not found on PATH. Falling back to a non-Tailnet host." >&2
  echo "         Without Tailscale the server is reachable to anyone who can reach" >&2
  echo "         the bound address, and there is NO app-level auth." >&2
fi

# --- Build the client bundle if missing --------------------------------------
if [ ! -f "public/dist/terminal.js" ]; then
  echo "Client bundle not found (public/dist/terminal.js); building..."
  npm run build
fi

# --- Detect the Tailscale IPv4 and choose HOST/PORT --------------------------
# HOST/PORT may already be set in the environment (or via the .env loaded
# above). We only auto-fill HOST from Tailscale when it isn't already set.
PORT="${PORT:-8090}"

if [ -z "${HOST:-}" ] && command -v tailscale >/dev/null 2>&1; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  if [ -n "${TS_IP}" ]; then
    HOST="${TS_IP}"
    echo "Detected Tailscale IPv4: ${HOST}"
  else
    echo "Could not determine Tailscale IPv4 (is 'tailscale up' running?)." >&2
  fi
fi

export PORT
if [ -n "${HOST:-}" ]; then
  export HOST
fi

# --- Announce the reachable URL ----------------------------------------------
DISPLAY_HOST="${HOST:-0.0.0.0}"
echo "Starting terminal-web on http://${DISPLAY_HOST}:${PORT}"
if [ "${DISPLAY_HOST}" = "0.0.0.0" ]; then
  echo "(HOST not set to a specific IP; the server will log the concrete URLs it binds.)"
fi

# --- Run the server ----------------------------------------------------------
exec npm start
