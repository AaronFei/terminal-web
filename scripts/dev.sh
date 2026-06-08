#!/usr/bin/env bash
# Development mode for terminal-web:
#   - esbuild rebuilds the client bundle on change (background watcher)
#   - tsx restarts the server on change (foreground)
#
# Usage: bash scripts/dev.sh   (invoked by 'npm run dev')
set -euo pipefail

# Resolve the repo root so relative paths/processes behave regardless of CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# Load optional .env (KEY=VALUE lines) so dev runs honor the same overrides as
# scripts/start.sh. Running `tsx`/`npm start` directly does NOT auto-load it.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Start the esbuild watcher in the background; it keeps public/dist in sync.
node esbuild.mjs --watch &
ESBUILD_PID=$!

# Make sure the background watcher dies when this script exits (Ctrl-C,
# server crash, etc.) so we don't leak a watcher process.
cleanup() {
  # Ignore errors if it's already gone.
  kill "${ESBUILD_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Run the server in the foreground with auto-restart on file changes.
# When this exits, the trap above tears down the esbuild watcher.
tsx watch src/server.ts
