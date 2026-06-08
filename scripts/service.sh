#!/usr/bin/env bash
# Manage terminal-web as a per-user launchd service on macOS so it starts at
# login and restarts on crash.
#
# Usage:
#   bash scripts/service.sh install     # write the plist + load + start
#   bash scripts/service.sh uninstall   # stop + unload + remove the plist
#   bash scripts/service.sh restart     # restart the running service
#   bash scripts/service.sh status      # show launchd state + a curl probe
#   bash scripts/service.sh logs        # tail the service logs
#
# Env overrides for `install`:
#   HOST=<ip>   bind address (default: Tailscale IPv4, else 0.0.0.0)
#   PORT=<n>    listen port  (default: 8090)
set -euo pipefail

LABEL="com.aaronfei.terminal-web"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

die() { echo "error: $*" >&2; exit 1; }

cmd_install() {
  command -v node >/dev/null 2>&1 || die "node not found on PATH"
  command -v tmux >/dev/null 2>&1 || echo "warning: tmux not found; sessions will fail until installed" >&2

  local node_bin node_dir ts_dir tailscale_ip host port path_env tsx_cli
  node_bin="$(command -v node)"
  node_dir="$(dirname "${node_bin}")"
  tsx_cli="${REPO_ROOT}/node_modules/tsx/dist/cli.mjs"
  [ -f "${tsx_cli}" ] || die "tsx not installed — run 'npm install' first (${tsx_cli} missing)"

  # Build the bundle if it's missing so the service can serve assets.
  [ -f "${REPO_ROOT}/public/dist/terminal.js" ] || (cd "${REPO_ROOT}" && npm run build)

  tailscale_ip=""
  if command -v tailscale >/dev/null 2>&1; then
    tailscale_ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  fi
  host="${HOST:-${tailscale_ip:-0.0.0.0}}"
  port="${PORT:-8090}"

  # PATH for launchd's minimal environment: node's dir, tailscale's dir, base.
  ts_dir=""
  if command -v tailscale >/dev/null 2>&1; then ts_dir="$(dirname "$(command -v tailscale)")"; fi
  path_env="${node_dir}"
  [ -n "${ts_dir}" ] && [ "${ts_dir}" != "${node_dir}" ] && path_env="${path_env}:${ts_dir}"
  path_env="${path_env}:/usr/bin:/bin:/usr/sbin:/sbin"

  mkdir -p "${REPO_ROOT}/logs" "${HOME}/Library/LaunchAgents"

  cat > "${PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${node_bin}</string>
        <string>${tsx_cli}</string>
        <string>${REPO_ROOT}/src/server.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${path_env}</string>
        <key>HOST</key>
        <string>${host}</string>
        <key>PORT</key>
        <string>${port}</string>
        <key>DEFAULT_SESSION</key>
        <string>web</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${REPO_ROOT}/logs/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>${REPO_ROOT}/logs/launchd.err.log</string>
</dict>
</plist>
PLIST

  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "${DOMAIN}" "${PLIST}"
  launchctl kickstart -k "${DOMAIN}/${LABEL}"
  echo "installed and started: ${LABEL}"
  echo "  bound to http://${host}:${port}/"
  echo "  plist:   ${PLIST}"
  echo "  logs:    ${REPO_ROOT}/logs/launchd.{out,err}.log"
}

cmd_uninstall() {
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
  rm -f "${PLIST}"
  echo "uninstalled: ${LABEL}"
}

cmd_restart() {
  launchctl kickstart -k "${DOMAIN}/${LABEL}"
  echo "restarted: ${LABEL}"
}

cmd_status() {
  launchctl print "${DOMAIN}/${LABEL}" 2>/dev/null | grep -E "state =|pid =|last exit code" || \
    echo "service not loaded"
  # Probe the bound address if we can read it from the plist.
  if [ -f "${PLIST}" ]; then
    local host port
    host="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:HOST' "${PLIST}" 2>/dev/null || echo '')"
    port="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:PORT' "${PLIST}" 2>/dev/null || echo 8090)"
    [ -n "${host}" ] && echo "probe: http://${host}:${port}/ -> $(curl -sS -o /dev/null -w '%{http_code}' "http://${host}:${port}/" 2>&1 || echo 'unreachable')"
  fi
}

cmd_logs() {
  tail -n 40 -f "${REPO_ROOT}/logs/launchd.out.log" "${REPO_ROOT}/logs/launchd.err.log"
}

case "${1:-}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  *) echo "usage: bash scripts/service.sh {install|uninstall|restart|status|logs}" >&2; exit 1 ;;
esac
