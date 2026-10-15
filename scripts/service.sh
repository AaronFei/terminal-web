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
# Env overrides for `install`. Anything not given is carried over from the
# unit/plist that is already installed, so a reinstall from a bare shell keeps
# the token, the bind address and hand-added PATH entries:
#   HOST=<ip>          bind address (default: installed value, else the
#                      Tailscale IPv4; with neither, install refuses to run —
#                      pass HOST=0.0.0.0 to bind every interface on purpose)
#   PORT=<n>           listen port  (default: installed value, else 8090)
#   DEFAULT_SESSION=   default tmux session (default: installed, else web)
#   AUTH_TOKEN=<t>     shared token for Cloudflare-fronted requests (default:
#                      installed value; an empty value counts as not given)
#   SERVICE_PATH=<p>   PATH for the service (default: installed value, with the
#                      node and tailscale dirs added if missing)
#
# Where the token lives (never in a group/world-readable file):
#   - Linux: ~/.config/terminal-web/env (0600), loaded with EnvironmentFile=.
#            Edit it and `restart` to change the token; delete the AUTH_TOKEN
#            line and `restart` to drop it.
#   - macOS: inline in the plist, which install writes 0600 (launchd has no
#            EnvironmentFile). To drop the token: uninstall, then install.
# Any other env found in the installed unit/plist is kept as is.
set -euo pipefail

LABEL="com.aaronfei.terminal-web" # macOS launchd label
UNIT="terminal-web"               # Linux systemd unit name
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OS="$(uname -s)"

# Private settings (AUTH_TOKEN) for the systemd unit. 0600, dir 0700.
ENV_FILE="${HOME}/.config/terminal-web/env"
# launchd's stdout/err logs are never rotated by launchd itself; keep one
# previous generation once a log passes this size.
LOG_MAX_BYTES=$((10 * 1024 * 1024))
# Env keys install writes itself, in the order they appear in the unit/plist.
MANAGED_KEYS="PATH HOST PORT DEFAULT_SESSION"

die() { echo "error: $*" >&2; exit 1; }

# --- installed settings (carry-over) -----------------------------------------
# OLD_KEYS lists every env key found in the installed unit/plist, in order;
# each value is held in OLDENV_<key>. (bash 3.2 has no associative arrays.)
OLD_KEYS=""
OLD_SRC=""         # where they came from, for the messages
OLD_TOKEN=""       # AUTH_TOKEN found in the installed config / env file
OLD_TOKEN_SRC=""

old_set() {
  case "$1" in [A-Za-z_]*) ;; *) return 0 ;; esac
  case "$1" in *[!A-Za-z0-9_]*) return 0 ;; esac
  if [ "$1" = "AUTH_TOKEN" ]; then
    OLD_TOKEN="$2"
    OLD_TOKEN_SRC="${OLD_SRC}"
    return 0
  fi
  printf -v "OLDENV_$1" '%s' "$2"
  case " ${OLD_KEYS} " in *" $1 "*) ;; *) OLD_KEYS="${OLD_KEYS:+${OLD_KEYS} }$1" ;; esac
}
old_get() { local n="OLDENV_$1"; printf '%s' "${!n-}"; }

# Lines like "  HOST: 100.64.0.9 (carried over from ...)" collected for the
# install summary, so the user sees exactly what was kept.
CARRIED=""
carried() { CARRIED="${CARRIED}  $1
"; }

# Strip one pair of surrounding quotes, as hand-edited env files often have.
unquote() {
  local v="$1"
  case "${v}" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "${v}"
}

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
  TS_DIR=""
  if command -v tailscale >/dev/null 2>&1; then
    TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
    TS_DIR="$(dirname "$(command -v tailscale)")"
  fi

  local old

  # HOST: explicit > installed > Tailscale. Never fall back to 0.0.0.0 on our
  # own: that would quietly expose the terminal on every interface.
  old="$(old_get HOST)"
  if [ -n "${HOST:-}" ]; then
    HOST_VAL="${HOST}"
  elif [ -n "${old}" ]; then
    HOST_VAL="${old}"
    carried "HOST: ${HOST_VAL} (carried over from ${OLD_SRC})"
    if [ -n "${TS_IP}" ] && [ "${TS_IP}" != "${HOST_VAL}" ]; then
      echo "note: installed HOST=${HOST_VAL} differs from the Tailscale IPv4 ${TS_IP};" >&2
      echo "      keeping ${HOST_VAL} (re-run with HOST=${TS_IP} to switch)" >&2
    fi
  elif [ -n "${TS_IP}" ]; then
    HOST_VAL="${TS_IP}"
  else
    die "no Tailscale IPv4 detected and HOST not set.
       Refusing to fall back to 0.0.0.0 (every interface) on my own.
       Bring Tailscale up ('tailscale up') and re-run, or pick the bind address:
         HOST=<ip> bash scripts/service.sh install
         HOST=0.0.0.0 bash scripts/service.sh install   # all interfaces, on purpose"
  fi
  case "${HOST_VAL}" in
    0.0.0.0 | "::")
      echo "warning: HOST=${HOST_VAL} binds every interface, not just the tailnet" >&2 ;;
  esac

  old="$(old_get PORT)"
  if [ -n "${PORT:-}" ]; then PORT_VAL="${PORT}"
  elif [ -n "${old}" ]; then PORT_VAL="${old}"; carried "PORT: ${PORT_VAL} (carried over)"
  else PORT_VAL="8090"; fi

  old="$(old_get DEFAULT_SESSION)"
  if [ -n "${DEFAULT_SESSION:-}" ]; then SESSION_VAL="${DEFAULT_SESSION}"
  elif [ -n "${old}" ]; then SESSION_VAL="${old}"; carried "DEFAULT_SESSION: ${SESSION_VAL} (carried over)"
  else SESSION_VAL="web"; fi

  # Optional shared access token. An empty AUTH_TOKEN counts as "not given":
  # dropping the token by accident would open the Cloudflare path.
  if [ -n "${AUTH_TOKEN:-}" ]; then
    AUTH_TOKEN_VAL="${AUTH_TOKEN}"
  elif [ -n "${OLD_TOKEN}" ]; then
    AUTH_TOKEN_VAL="${OLD_TOKEN}"
    carried "AUTH_TOKEN: <set, not shown> (carried over from ${OLD_TOKEN_SRC})"
  else
    AUTH_TOKEN_VAL=""
  fi

  # PATH: keep the installed one (it may hold hand-added dirs) and only make
  # sure node and tailscale are still reachable through it.
  old="$(old_get PATH)"
  if [ -n "${SERVICE_PATH:-}" ]; then
    PATH_ENV="${SERVICE_PATH}"
  elif [ -n "${old}" ]; then
    PATH_ENV="${old}"
    local added=""
    case ":${PATH_ENV}:" in *":${NODE_DIR}:"*) ;; *) PATH_ENV="${NODE_DIR}:${PATH_ENV}"; added="${added} ${NODE_DIR}" ;; esac
    if [ -n "${TS_DIR}" ]; then
      case ":${PATH_ENV}:" in *":${TS_DIR}:"*) ;; *) PATH_ENV="${PATH_ENV}:${TS_DIR}"; added="${added} ${TS_DIR}" ;; esac
    fi
    carried "PATH: ${PATH_ENV} (carried over${added:+; added${added}})"
  else
    PATH_ENV="${NODE_DIR}"
    [ -n "${TS_DIR}" ] && [ "${TS_DIR}" != "${NODE_DIR}" ] && PATH_ENV="${PATH_ENV}:${TS_DIR}"
    PATH_ENV="${PATH_ENV}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  fi

  # Anything else that was in the installed env (hand-added) is kept verbatim.
  EXTRA_KEYS=""
  local k
  for k in ${OLD_KEYS}; do
    case " ${MANAGED_KEYS} " in *" ${k} "*) continue ;; esac
    EXTRA_KEYS="${EXTRA_KEYS:+${EXTRA_KEYS} }${k}"
  done
  [ -z "${EXTRA_KEYS}" ] || carried "other env: ${EXTRA_KEYS} (carried over)"

  mkdir -p "${REPO_ROOT}/logs"
}

print_carried() {
  if [ -n "${CARRIED}" ]; then
    echo "  kept from the previous install:"
    printf '%s' "${CARRIED}" | sed 's/^/  /'
  fi
}

# ============================ macOS / launchd ================================
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
PLISTBUDDY="/usr/libexec/PlistBuddy"
mac_domain() { echo "gui/$(id -u)"; }

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

mac_read_installed() {
  [ -f "${PLIST}" ] || return 0
  OLD_SRC="${PLIST}"
  local keys k v
  # plutil prints the env dict as XML; PlistBuddy then reads each value
  # unescaped. Only <key> lines matter here.
  keys="$(plutil -extract EnvironmentVariables xml1 -o - "${PLIST}" 2>/dev/null \
    | sed -n 's#^[[:space:]]*<key>\(.*\)</key>[[:space:]]*$#\1#p' || true)"
  for k in ${keys}; do
    v="$("${PLISTBUDDY}" -c "Print :EnvironmentVariables:${k}" "${PLIST}" 2>/dev/null || true)"
    old_set "${k}" "${v}"
  done
}

# Move a launchd log aside once it passes LOG_MAX_BYTES (one old generation).
# Done right before the service (re)starts, because launchd opens the log
# files when it spawns the process.
mac_rotate_logs() {
  local f size
  for f in "${REPO_ROOT}/logs/launchd.out.log" "${REPO_ROOT}/logs/launchd.err.log"; do
    [ -f "${f}" ] || continue
    size="$(wc -c < "${f}" | tr -d ' ')"
    if [ "${size}" -gt "${LOG_MAX_BYTES}" ]; then
      mv -f "${f}" "${f}.1"
      echo "  rotated $(basename "${f}") (${size} bytes) -> $(basename "${f}").1"
    fi
  done
}

# `bootstrap` right after `bootout` often fails with "Bootstrap failed: 5"
# while launchd is still tearing the old instance down. Wait for it to go,
# then retry; never leave the script dead with the service silently unloaded.
mac_bootstrap() {
  local dom="$1" i out
  for i in $(seq 1 20); do
    launchctl print "${dom}/${LABEL}" >/dev/null 2>&1 || break
    sleep 0.25
  done
  for i in $(seq 1 10); do
    if out="$(launchctl bootstrap "${dom}" "${PLIST}" 2>&1)"; then
      [ "${i}" -eq 1 ] || echo "  bootstrap succeeded on attempt ${i}"
      return 0
    fi
    echo "  bootstrap attempt ${i}/10 failed: ${out}" >&2
    sleep 1
  done
  cat >&2 <<EOF
error: launchctl bootstrap kept failing — ${LABEL} is NOT loaded right now.
The plist is written (${PLIST}); load it by hand:
    launchctl bootout ${dom}/${LABEL} 2>/dev/null; sleep 2
    launchctl bootstrap ${dom} ${PLIST}
    launchctl kickstart -k ${dom}/${LABEL}
(Logging out and back in also loads it: the plist has RunAtLoad.)
EOF
  exit 1
}

mac_install() {
  mac_read_installed
  resolve_env
  mkdir -p "${HOME}/Library/LaunchAgents"

  local env_xml="" k v
  for k in ${MANAGED_KEYS} ${EXTRA_KEYS} AUTH_TOKEN; do
    case "${k}" in
      PATH) v="${PATH_ENV}" ;;
      HOST) v="${HOST_VAL}" ;;
      PORT) v="${PORT_VAL}" ;;
      DEFAULT_SESSION) v="${SESSION_VAL}" ;;
      AUTH_TOKEN) v="${AUTH_TOKEN_VAL}"; [ -n "${v}" ] || continue ;;
      *) v="$(old_get "${k}")" ;;
    esac
    env_xml="${env_xml}
        <key>$(xml_escape "${k}")</key>
        <string>$(xml_escape "${v}")</string>"
  done

  # launchd has no EnvironmentFile, so the token sits in the plist: write it
  # 0600 from the start (umask) and atomically (temp file + mv).
  local tmp="${PLIST}.tmp.$$" old_umask
  old_umask="$(umask)"
  umask 077
  cat > "${tmp}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(xml_escape "${NODE_BIN}")</string>
        <string>$(xml_escape "${TSX_CLI}")</string>
        <string>$(xml_escape "${REPO_ROOT}/src/server.ts")</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(xml_escape "${REPO_ROOT}")</string>
    <key>EnvironmentVariables</key>
    <dict>${env_xml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$(xml_escape "${REPO_ROOT}/logs/launchd.out.log")</string>
    <key>StandardErrorPath</key>
    <string>$(xml_escape "${REPO_ROOT}/logs/launchd.err.log")</string>
</dict>
</plist>
PLIST
  umask "${old_umask}"
  chmod 600 "${tmp}"
  plutil -lint -s "${tmp}" >/dev/null || { rm -f "${tmp}"; die "generated plist is invalid; nothing was changed"; }
  mv -f "${tmp}" "${PLIST}"

  mac_rotate_logs
  local dom; dom="$(mac_domain)"
  launchctl bootout "${dom}/${LABEL}" 2>/dev/null || true
  mac_bootstrap "${dom}"
  launchctl kickstart -k "${dom}/${LABEL}"
  echo "installed and started (launchd): ${LABEL}"
  echo "  bound to http://${HOST_VAL}:${PORT_VAL}/"
  echo "  auth:    $([ -n "${AUTH_TOKEN_VAL}" ] && echo "AUTH_TOKEN set (plist is 0600)" || echo "no AUTH_TOKEN — Cloudflare-fronted requests are NOT gated")"
  echo "  logs:    ${REPO_ROOT}/logs/launchd.{out,err}.log"
  print_carried
}

mac_uninstall() {
  launchctl bootout "$(mac_domain)/${LABEL}" 2>/dev/null || true
  rm -f "${PLIST}"
  echo "uninstalled (launchd): ${LABEL}"
}

mac_restart() {
  mac_rotate_logs
  launchctl kickstart -k "$(mac_domain)/${LABEL}"
  echo "restarted (launchd): ${LABEL}"
}

mac_status() {
  launchctl print "$(mac_domain)/${LABEL}" 2>/dev/null \
    | grep -E "state =|pid =|last exit code" || echo "service not loaded"
  if [ -f "${PLIST}" ]; then
    local host port
    host="$("${PLISTBUDDY}" -c 'Print :EnvironmentVariables:HOST' "${PLIST}" 2>/dev/null || echo '')"
    port="$("${PLISTBUDDY}" -c 'Print :EnvironmentVariables:PORT' "${PLIST}" 2>/dev/null || echo 8090)"
    [ -n "${host}" ] && echo "probe: http://${host}:${port}/ -> $(curl -sS -o /dev/null -w '%{http_code}' "http://${host}:${port}/" 2>&1 || echo unreachable)"
  fi
}

mac_logs() {
  tail -n 40 -f "${REPO_ROOT}/logs/launchd.out.log" "${REPO_ROOT}/logs/launchd.err.log"
}

# ============================ Linux / systemd ================================
UNIT_FILE="${HOME}/.config/systemd/user/${UNIT}.service"

# systemd treats % as a specifier and splits on whitespace unless quoted.
unit_escape() { printf '%s' "$1" | sed 's/%/%%/g'; }
unit_env_line() {
  local v; v="$(unit_escape "$2")"
  case "${v}" in
    *[[:space:]]*) printf 'Environment="%s=%s"\n' "$1" "${v}" ;;
    *) printf 'Environment=%s=%s\n' "$1" "${v}" ;;
  esac
}

linux_read_installed() {
  local line kv
  if [ -f "${UNIT_FILE}" ]; then
    OLD_SRC="${UNIT_FILE}"
    # Handles the forms this script (and a hand edit) writes:
    #   Environment=KEY=value   and   Environment="KEY=value with spaces"
    while IFS= read -r line; do
      kv="${line#Environment=}"
      kv="$(unquote "${kv}" | sed 's/%%/%/g')"
      case "${kv}" in *=*) old_set "${kv%%=*}" "${kv#*=}" ;; esac
    done <<EOF
$(grep '^Environment=' "${UNIT_FILE}" || true)
EOF
  fi
  # The env file wins over an inline token: it is what the unit loads last.
  if [ -f "${ENV_FILE}" ]; then
    kv="$(sed -n 's/^AUTH_TOKEN=//p' "${ENV_FILE}" | tail -1)"
    kv="$(unquote "${kv}")"
    if [ -n "${kv}" ]; then
      OLD_TOKEN="${kv}"
      OLD_TOKEN_SRC="${ENV_FILE}"
    fi
  fi
}

# Rewrite ENV_FILE with the token, keeping any other lines the user put there.
# Created 0600 (umask) in a 0700 dir and moved into place atomically.
linux_write_env_file() {
  local dir tmp old_umask
  dir="$(dirname "${ENV_FILE}")"
  tmp="${ENV_FILE}.tmp.$$"
  old_umask="$(umask)"
  umask 077
  mkdir -p "${dir}"
  {
    if [ -f "${ENV_FILE}" ]; then
      grep -v '^AUTH_TOKEN=' "${ENV_FILE}" || true
    else
      echo "# terminal-web service environment: KEY=VALUE, one per line."
      echo "# Holds AUTH_TOKEN, so keep it 0600. Loaded by the systemd unit through"
      echo "# EnvironmentFile=; run 'bash scripts/service.sh restart' after editing."
    fi
    [ -z "${AUTH_TOKEN_VAL}" ] || echo "AUTH_TOKEN=${AUTH_TOKEN_VAL}"
  } > "${tmp}"
  umask "${old_umask}"
  chmod 700 "${dir}"
  chmod 600 "${tmp}"
  mv -f "${tmp}" "${ENV_FILE}"
}

linux_install() {
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found (this helper targets systemd on Linux)"
  linux_read_installed
  resolve_env
  # Written unquoted into an EnvironmentFile, which systemd parses with its own
  # quoting/escape rules; refuse anything those could mangle.
  case "${AUTH_TOKEN_VAL}" in
    *[[:space:]]* | *\"* | *\'* | *\\* | *\$* | *\`*)
      die "AUTH_TOKEN contains whitespace, a quote, a backslash, \$ or a backtick; pick a token without them (e.g. openssl rand -hex 32)" ;;
  esac
  if [ "${OLD_TOKEN_SRC}" = "${UNIT_FILE}" ] && [ -z "${AUTH_TOKEN:-}" ]; then
    carried "AUTH_TOKEN: moved out of the unit file into ${ENV_FILE} (0600)"
  fi

  linux_write_env_file
  mkdir -p "${HOME}/.config/systemd/user"
  local env_lines="" k v
  for k in ${MANAGED_KEYS} ${EXTRA_KEYS}; do
    case "${k}" in
      PATH) v="${PATH_ENV}" ;;
      HOST) v="${HOST_VAL}" ;;
      PORT) v="${PORT_VAL}" ;;
      DEFAULT_SESSION) v="${SESSION_VAL}" ;;
      *) v="$(old_get "${k}")" ;;
    esac
    env_lines="${env_lines}$(unit_env_line "${k}" "${v}")
"
  done

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
WorkingDirectory=$(unit_escape "${REPO_ROOT}")
${env_lines}# AUTH_TOKEN (and any other private setting) lives in this 0600 file, so it
# stays out of this world-readable unit. Missing file = the unit fails to start.
EnvironmentFile=$(unit_escape "${ENV_FILE}")
ExecStart=$(unit_escape "${NODE_BIN}") $(unit_escape "${TSX_CLI}") $(unit_escape "${REPO_ROOT}/src/server.ts")
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
  echo "  auth:    $([ -n "${AUTH_TOKEN_VAL}" ] && echo "AUTH_TOKEN set (in ${ENV_FILE}, 0600)" || echo "no AUTH_TOKEN — Cloudflare-fronted requests are NOT gated")"
  echo "  logs:    journalctl --user -u ${UNIT} -f   (or: scripts/service.sh logs)"
  print_carried
}

linux_uninstall() {
  systemctl --user disable --now "${UNIT}.service" 2>/dev/null || true
  rm -f "${UNIT_FILE}"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "uninstalled (systemd --user): ${UNIT}.service"
  [ -f "${ENV_FILE}" ] && echo "  kept ${ENV_FILE} (holds AUTH_TOKEN; a later install reuses it)"
  return 0
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
