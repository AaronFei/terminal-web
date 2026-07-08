#!/usr/bin/env bash
# Manage terminal-web as a background service that starts on login/boot and
# restarts on crash. Auto-detects the platform:
#   - macOS  -> launchd  (~/Library/LaunchAgents/<label>.plist)
#   - Linux  -> systemd  (~/.config/systemd/user/<unit>.service)
#
# Usage:
#   bash scripts/service.sh install     # write unit + load + start
#   bash scripts/service.sh uninstall   # stop + unload + remove
#   bash scripts/service.sh restart     # restart the running service
#   bash scripts/service.sh status      # show state + a curl probe
#   bash scripts/service.sh logs        # tail the service logs
#
# Env overrides for `install`:
#   HOST=<ip>   bind address (default: Tailscale IPv4, else 0.0.0.0)
#   PORT=<n>    listen port  (default: 8090)
set -euo pipefail

LABEL="com.aaronfei.terminal-web" # macOS launchd label
UNIT="terminal-web"               # Linux systemd unit name
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OS="$(uname -s)"

die() { echo "error: $*" >&2; exit 1; }

# --- shared: resolve node/tsx/host/port/path and build if needed -------------
resolve_env() {
  command -v node >/dev/null 2>&1 || die "node not found on PATH"
  command -v tmux >/dev/null 2>&1 || \
    echo "warning: tmux not found; sessions will fail until installed" >&2

  NODE_BIN="$(command -v node)"
  NODE_DIR="$(dirname "${NODE_BIN}")"
  TSX_CLI="${REPO_ROOT}/node_modules/tsx/dist/cli.mjs"
  [ -f "${TSX_CLI}" ] || die "tsx not installed — run 'npm install' first (${TSX_CLI} missing)"

  [ -f "${REPO_ROOT}/public/dist/terminal.js" ] || (cd "${REPO_ROOT}" && npm run build)

  TS_IP=""
  if command -v tailscale >/dev/null 2>&1; then
    TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  fi
  HOST_VAL="${HOST:-${TS_IP:-0.0.0.0}}"
  PORT_VAL="${PORT:-8090}"
  # Optional shared access token (only injected into the unit when set).
  AUTH_TOKEN_VAL="${AUTH_TOKEN:-}"

  TS_DIR=""
  if command -v tailscale >/dev/null 2>&1; then TS_DIR="$(dirname "$(command -v tailscale)")"; fi
  PATH_ENV="${NODE_DIR}"
  [ -n "${TS_DIR}" ] && [ "${TS_DIR}" != "${NODE_DIR}" ] && PATH_ENV="${PATH_ENV}:${TS_DIR}"
  PATH_ENV="${PATH_ENV}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

  mkdir -p "${REPO_ROOT}/logs"
}

# ============================ macOS / launchd ================================
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
mac_domain() { echo "gui/$(id -u)"; }

mac_install() {
  resolve_env
  mkdir -p "${HOME}/Library/LaunchAgents"
  local auth_plist=""
  [ -n "${AUTH_TOKEN_VAL}" ] && auth_plist="
        <key>AUTH_TOKEN</key>
        <string>${AUTH_TOKEN_VAL}</string>"
  cat > "${PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${TSX_CLI}</string>
        <string>${REPO_ROOT}/src/server.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${PATH_ENV}</string>
        <key>HOST</key>
        <string>${HOST_VAL}</string>
        <key>PORT</key>
        <string>${PORT_VAL}</string>
        <key>DEFAULT_SESSION</key>
        <string>web</string>${auth_plist}
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
  local dom; dom="$(mac_domain)"
  launchctl bootout "${dom}/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "${dom}" "${PLIST}"
  launchctl kickstart -k "${dom}/${LABEL}"
  echo "installed and started (launchd): ${LABEL}"
  echo "  bound to http://${HOST_VAL}:${PORT_VAL}/"
  echo "  logs:    ${REPO_ROOT}/logs/launchd.{out,err}.log"
}

mac_uninstall() {
  launchctl bootout "$(mac_domain)/${LABEL}" 2>/dev/null || true
  rm -f "${PLIST}"
  echo "uninstalled (launchd): ${LABEL}"
}

mac_restart() {
  launchctl kickstart -k "$(mac_domain)/${LABEL}"
  echo "restarted (launchd): ${LABEL}"
}

mac_status() {
  launchctl print "$(mac_domain)/${LABEL}" 2>/dev/null \
    | grep -E "state =|pid =|last exit code" || echo "service not loaded"
  if [ -f "${PLIST}" ]; then
    local host port
    host="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:HOST' "${PLIST}" 2>/dev/null || echo '')"
    port="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:PORT' "${PLIST}" 2>/dev/null || echo 8090)"
    [ -n "${host}" ] && echo "probe: http://${host}:${port}/ -> $(curl -sS -o /dev/null -w '%{http_code}' "http://${host}:${port}/" 2>&1 || echo unreachable)"
  fi
}

mac_logs() {
  tail -n 40 -f "${REPO_ROOT}/logs/launchd.out.log" "${REPO_ROOT}/logs/launchd.err.log"
}

# ============================ Linux / systemd ================================
UNIT_FILE="${HOME}/.config/systemd/user/${UNIT}.service"

linux_install() {
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found (this helper targets systemd on Linux)"
  resolve_env
  mkdir -p "${HOME}/.config/systemd/user"
  local auth_unit=""
  [ -n "${AUTH_TOKEN_VAL}" ] && auth_unit="Environment=AUTH_TOKEN=${AUTH_TOKEN_VAL}"
  cat > "${UNIT_FILE}" <<UNITFILE
[Unit]
Description=terminal-web — web terminal (xterm.js + node-pty + tmux)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Only kill the main node process on stop/restart, NOT the whole cgroup. The
# tmux server (and users' running programs — e.g. Claude) is spawned as a cgroup
# child; the systemd default KillMode=control-group would SIGTERM it on every
# restart, wiping live sessions. KillMode=process leaves it alive so node
# reconnects to the same tmux on restart — matching launchd's behaviour on macOS.
KillMode=process
WorkingDirectory=${REPO_ROOT}
Environment=PATH=${PATH_ENV}
Environment=HOST=${HOST_VAL}
Environment=PORT=${PORT_VAL}
Environment=DEFAULT_SESSION=web
${auth_unit}
ExecStart=${NODE_BIN} ${TSX_CLI} ${REPO_ROOT}/src/server.ts
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNITFILE

  systemctl --user daemon-reload
  systemctl --user enable "${UNIT}.service"
  # restart (not just `enable --now`, which is a no-op when already running) so
  # a changed unit — e.g. a new AUTH_TOKEN — actually takes effect.
  systemctl --user restart "${UNIT}.service"

  # Let the service keep running after logout / across reboots without an
  # active login session. May require privileges; warn (don't fail) if denied.
  if ! loginctl enable-linger "$(id -un)" 2>/dev/null; then
    echo "note: could not enable linger automatically; for boot-without-login run:" >&2
    echo "      sudo loginctl enable-linger $(id -un)" >&2
  fi

  echo "installed and started (systemd --user): ${UNIT}.service"
  echo "  bound to http://${HOST_VAL}:${PORT_VAL}/"
  echo "  logs:    journalctl --user -u ${UNIT} -f   (or: scripts/service.sh logs)"
}

linux_uninstall() {
  systemctl --user disable --now "${UNIT}.service" 2>/dev/null || true
  rm -f "${UNIT_FILE}"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "uninstalled (systemd --user): ${UNIT}.service"
}

linux_restart() {
  systemctl --user restart "${UNIT}.service"
  echo "restarted (systemd --user): ${UNIT}.service"
}

linux_status() {
  systemctl --user --no-pager status "${UNIT}.service" 2>&1 \
    | grep -E "Active:|Main PID:|Loaded:" || echo "service not loaded"
  if [ -f "${UNIT_FILE}" ]; then
    local host port
    host="$(sed -n 's/^Environment=HOST=//p' "${UNIT_FILE}" | head -1)"
    port="$(sed -n 's/^Environment=PORT=//p' "${UNIT_FILE}" | head -1)"
    port="${port:-8090}"
    [ -n "${host}" ] && echo "probe: http://${host}:${port}/ -> $(curl -sS -o /dev/null -w '%{http_code}' "http://${host}:${port}/" 2>&1 || echo unreachable)"
  fi
}

linux_logs() {
  journalctl --user -u "${UNIT}" -n 40 -f
}

# ============================ dispatch =======================================
case "${OS}" in
  Darwin) PLATFORM=mac ;;
  Linux)  PLATFORM=linux ;;
  *) die "unsupported OS '${OS}' (this helper supports macOS and Linux)" ;;
esac

case "${1:-}" in
  install)   "${PLATFORM}_install" ;;
  uninstall) "${PLATFORM}_uninstall" ;;
  restart)   "${PLATFORM}_restart" ;;
  status)    "${PLATFORM}_status" ;;
  logs)      "${PLATFORM}_logs" ;;
  *) echo "usage: bash scripts/service.sh {install|uninstall|restart|status|logs}" >&2; exit 1 ;;
esac
