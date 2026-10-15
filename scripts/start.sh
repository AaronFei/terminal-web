#!/usr/bin/env bash
# Start terminal-web in "production-ish" mode:
#   - ensure the client bundle is built
#   - bind the server to the Tailscale IP when available (otherwise HOST must
#     be set; it never falls back to 0.0.0.0 on its own)
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
  echo "WARNING: 'tailscale' not found on PATH; set HOST to choose a bind address." >&2
  echo "         Off the tailnet the server is reachable to anyone who can reach" >&2
  echo "         the bound address; AUTH_TOKEN only gates Cloudflare-fronted requests." >&2
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

# Never fall back to 0.0.0.0 on our own (the server would): that quietly
# exposes the terminal on every interface. Binding all of them must be asked
# for with HOST=0.0.0.0.
if [ -z "${HOST:-}" ]; then
  echo "ERROR: no Tailscale IPv4 detected and HOST not set; refusing to bind 0.0.0.0" >&2
  echo "       on my own. Bring Tailscale up, or pick the bind address:" >&2
  echo "         HOST=<ip> bash scripts/start.sh" >&2
  echo "         HOST=0.0.0.0 bash scripts/start.sh   # all interfaces, on purpose" >&2
  exit 1
fi

export PORT
export HOST

# --- Announce the reachable URL ----------------------------------------------
echo "Starting terminal-web on http://${HOST}:${PORT}"
if [ "${HOST}" = "0.0.0.0" ]; then
  echo "(HOST=0.0.0.0 binds every interface; the server will log the concrete URLs it binds.)"
fi

# --- Run the server ----------------------------------------------------------
exec npm start
