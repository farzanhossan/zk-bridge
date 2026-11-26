#!/usr/bin/env bash
#
# zk-bridge setup: one command to install the bridge and run it as a service.
#
#   ./setup.sh             interactive: Node.js -> packages -> settings -> K40 check -> service -> check
#   ./setup.sh --yes       the same without questions (uses .env as it is)
#   ./setup.sh status|logs|start|stop|restart|test|info|update|uninstall|help
#
# Mac (launchd), Linux and Raspberry Pi (systemd). On Windows use setup.cmd instead.
# Works with the bash that ships with macOS (3.2).
set -euo pipefail
set -f # no filename globbing: we never need it, and it keeps typed input safe

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$ROOT/scripts/setup-helper.js"
ENV_FILE="$ROOT/.env"

SERVICE=zk-bridge
UNIT_FILE=/etc/systemd/system/zk-bridge.service
PLIST_LABEL=com.zk-bridge
PLIST_FILE=/Library/LaunchDaemons/com.zk-bridge.plist
MAC_LOG="$ROOT/logs/bridge.log"
READY_TIMEOUT=180

BASIC_KEYS="DEVICE_IP DEVICE_PORT DEVICE_TIMEZONE CRM_BASE_URL CRM_DEVICE_KEY"
KEYS=""

# ----------------------------------------------------------------------------
# Output and questions
# ----------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m' D=$'\033[2m' R=$'\033[31m' G=$'\033[32m' Y=$'\033[33m' C=$'\033[36m' N=$'\033[0m'
else
  B='' D='' R='' G='' Y='' C='' N=''
fi
say()  { printf '%s\n' "$*"; }
info() { printf '%s==>%s %s\n' "$C" "$N" "$*"; }
ok()   { printf '%s ok%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s !%s  %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%s x   %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

ASSUME_YES=0
INPUT_EOF=0 # set when stdin ran out (piped answers), so a bad value isn't asked for forever

trim() { local s=$1; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }

# ask VAR "Question" "default": Enter keeps the default. Reads stdin, so answers can be piped in.
ask() {
  local _answer=""
  if [ "$ASSUME_YES" = 1 ]; then printf -v "$1" '%s' "$3"; return 0; fi
  printf '%s %s[%s]%s: ' "$2" "$D" "$3" "$N" >&2
  IFS= read -r _answer || INPUT_EOF=1
  _answer=$(trim "$_answer")
  [ -z "$_answer" ] && _answer=$3
  printf -v "$1" '%s' "$_answer"
}

# ask_secret VAR "Question" "current": like ask, but typing is hidden and the current value masked.
ask_secret() {
  local _answer=""
  if [ "$ASSUME_YES" = 1 ]; then printf -v "$1" '%s' "$3"; return 0; fi
  printf '%s %s[%s]%s: ' "$2" "$D" "$(mask "$3")" "$N" >&2
  if [ -t 0 ]; then
    IFS= read -rs _answer || INPUT_EOF=1
    printf '\n' >&2
  else
    IFS= read -r _answer || INPUT_EOF=1
  fi
  _answer=$(trim "$_answer")
  [ -z "$_answer" ] && _answer=$3
  printf -v "$1" '%s' "$_answer"
}

# confirm "Question" y|n: returns 0 for yes
confirm() {
  local _answer="" _hint="[y/N]"
  [ "$2" = y ] && _hint="[Y/n]"
  if [ "$ASSUME_YES" = 1 ]; then [ "$2" = y ]; return; fi
  printf '%s %s: ' "$1" "$_hint" >&2
  IFS= read -r _answer || _answer=""
  [ -z "$_answer" ] && _answer=$2
  case "$_answer" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

mask() {
  local s=$1
  if [ -z "$s" ]; then printf '(empty)'
  elif [ "$s" = replace-me ]; then printf 'replace-me (not set yet)'
  elif [ "${#s}" -le 8 ]; then printf '****'
  else printf '%s...%s' "${s:0:4}" "${s: -2}"
  fi
}

has() { case " $1 " in *" $2 "*) return 0 ;; *) return 1 ;; esac; }

label() {
  case "$1" in
    DEVICE_IP)       printf 'K40 IP address (DEVICE_IP)' ;;
    DEVICE_PORT)     printf 'K40 port (DEVICE_PORT)' ;;
    DEVICE_TIMEZONE) printf 'Timezone of the K40 clock (DEVICE_TIMEZONE)' ;;
    CRM_BASE_URL)    printf 'CRM API address, https://... (CRM_BASE_URL)' ;;
    CRM_DEVICE_KEY)  printf 'Device key from the CRM (CRM_DEVICE_KEY)' ;;
    *)               printf '%s' "$1" ;;
  esac
}

# Runs as root: directly when we are root, otherwise through sudo.
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

# ----------------------------------------------------------------------------
# System checks
# ----------------------------------------------------------------------------
detect_os() {
  case "$(uname -s)" in
    Darwin) OS=mac ;;
    Linux)  OS=linux ;;
    MINGW*|MSYS*|CYGWIN*) die "On Windows run setup.cmd instead (double-click it, or run .\\setup.cmd in PowerShell)." ;;
    *) die "Unsupported system: $(uname -s). See README.md for a manual setup." ;;
  esac
}

check_user() {
  if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
    die "Run ./setup.sh without sudo. It asks for your password only for the steps that need it."
  fi
}

check_folder() {
  [ "$OS" = mac ] || return 0
  case "$ROOT/" in
    "$HOME/Desktop/"*|"$HOME/Documents/"*|"$HOME/Downloads/"*|"$HOME/Library/Mobile Documents/"*) ;;
    *) return 0 ;;
  esac
  warn "This folder is inside Desktop, Documents, Downloads or iCloud Drive:"
  warn "  $ROOT"
  warn "macOS doesn't let background services read those folders, so the service would not start."
  warn "Move the folder (e.g. to ~/zk-bridge) and run ./setup.sh from there."
  confirm "Continue here anyway?" n || exit 1
}

node_ok() { command -v node >/dev/null 2>&1 && node "$HELPER" node-ok >/dev/null 2>&1; }

install_node_linux() {
  local arch script url pm
  arch=$(uname -m)
  case "$arch" in
    armv6l|armv7l)
      die "This is a 32-bit system ($arch). Use the 64-bit Raspberry Pi OS, or install Node.js 22.13+ yourself (https://nodejs.org), then run ./setup.sh again." ;;
  esac
  if command -v apt-get >/dev/null 2>&1; then url=https://deb.nodesource.com/setup_lts.x; pm=apt-get
  elif command -v dnf >/dev/null 2>&1; then url=https://rpm.nodesource.com/setup_lts.x; pm=dnf
  elif command -v yum >/dev/null 2>&1; then url=https://rpm.nodesource.com/setup_lts.x; pm=yum
  else die "No apt-get or dnf here. Install Node.js 22.13+ yourself (https://nodejs.org), then run ./setup.sh again."
  fi
  confirm "Install Node.js LTS from NodeSource ($url, needs sudo)?" y || \
    die "Install Node.js 22.13+ (https://nodejs.org), then run ./setup.sh again."
  if ! command -v curl >/dev/null 2>&1; then
    [ "$pm" = apt-get ] || die "curl is needed to install Node.js. Install curl and run ./setup.sh again."
    as_root apt-get update
    as_root apt-get install -y curl ca-certificates
  fi
  script="$(mktemp)"
  curl -fsSL "$url" -o "$script"
  as_root bash "$script"
  rm -f "$script"
  as_root "$pm" install -y nodejs
}

ensure_node() {
  local have="" saved_yes=$ASSUME_YES
  if node_ok; then ok "Node.js $(node -v)"; return 0; fi
  if command -v node >/dev/null 2>&1; then
    have=$(node -v 2>/dev/null || echo unknown)
    warn "Node.js $have is too old: zk-bridge needs 22.13 or newer."
  else
    warn "Node.js is not installed."
  fi
  [ -t 0 ] && ASSUME_YES=0 # installing software always asks when someone is at the terminal
  case "$OS" in
    mac)
      if command -v brew >/dev/null 2>&1 && confirm "Install Node.js with Homebrew?" y; then
        if brew list node >/dev/null 2>&1; then brew upgrade node; else brew install node; fi
      else
        die "Install Node.js 22.13+ from https://nodejs.org, then run ./setup.sh again."
      fi ;;
    linux) install_node_linux ;;
  esac
  ASSUME_YES=$saved_yes
  hash -r
  node_ok || die "The node on your PATH is still $(node -v 2>/dev/null || echo missing) ($(command -v node || echo 'not found')). If you use nvm: nvm install --lts && nvm alias default 'lts/*', then run ./setup.sh again."
  ok "Node.js $(node -v)"
}

# ----------------------------------------------------------------------------
# Packages, build, settings
# ----------------------------------------------------------------------------
install_packages() {
  info "Installing packages (npm ci)"
  (cd "$ROOT" && npm ci --include=dev --no-audit --no-fund)
  ok "Packages installed"
}

build() {
  info "Building (npm run build)"
  (cd "$ROOT" && npm run --silent build)
  ok "Built dist/"
}

# Current settings into V_<KEY> (from .env, else .env.example), in .env.example order.
load_settings() {
  local out line key
  out=$(node "$HELPER" env-show) || die "Could not read .env.example / .env"
  KEYS=""
  while IFS= read -r line; do
    key=${line%%=*}
    case "$key" in ''|*[!A-Z0-9_]*) continue ;; esac
    KEYS="$KEYS $key"
    printf -v "V_$key" '%s' "${line#*=}"
  done <<EOF
$out
EOF
}

val() { local v="V_$1"; printf '%s' "${!v}"; }

export_settings() {
  local key
  export ZKSET__ALL=1
  for key in $KEYS; do export "ZKSET_$key=$(val "$key")"; done
}

# validate [KEY]: prints the problems (one per line) and fails if there are any.
validate() { export_settings; node "$HELPER" validate "$@"; }

ask_setting() {
  local key=$1 answer problems line
  while :; do
    if [ "$key" = CRM_DEVICE_KEY ]; then
      ask_secret answer "  $(label "$key")" "$(val "$key")"
    else
      ask answer "  $(label "$key")" "$(val "$key")"
    fi
    case "$answer" in
      *"'"*'"'*|*'"'*"'"*) warn "Use only one kind of quote in a value."; continue ;;
    esac
    printf -v "V_$key" '%s' "$answer"
    if problems=$(validate "$key"); then return 0; fi
    while IFS= read -r line; do [ -n "$line" ] && warn "$line"; done <<EOF
$problems
EOF
    [ "$INPUT_EOF" = 1 ] && die "No more input, and $key is still not valid."
  done
}

prompt_settings() { # prompt_settings 0|1 (1 = also the advanced settings, without asking)
  local key
  say ""
  say "${B}Settings${N}  ${D}(Enter keeps the value in brackets)${N}"
  for key in $BASIC_KEYS; do ask_setting "$key"; done
  if [ "$1" = 1 ] || confirm "Change advanced settings too (intervals, timeouts, log level)?" n; then
    for key in $KEYS; do has "$BASIC_KEYS" "$key" || ask_setting "$key"; done
  fi
}

save_settings() {
  local result
  export_settings
  result=$(node "$HELPER" env-write) || die "Could not write .env"
  case "$result" in
    unchanged) ok "Settings unchanged (.env)" ;;
    created)   ok "Saved settings to .env" ;;
    *)         ok "Saved settings to .env (the previous one is in .env.bak)" ;;
  esac
}

settings_step() {
  local problems tries=0 advanced=0
  load_settings
  if [ "$ASSUME_YES" = 1 ]; then
    if ! problems=$(validate); then
      say "$problems" >&2
      die "The settings in .env have problems (above). Fix .env, or run ./setup.sh without --yes."
    fi
    ok "Settings in .env are valid"
    return 0
  fi
  while :; do
    prompt_settings "$advanced"
    if problems=$(validate); then break; fi
    tries=$((tries + 1))
    say "$problems" >&2
    [ "$tries" -ge 3 ] && die "The settings still have problems (above). Fix .env by hand, then run ./setup.sh --yes"
    warn "Some settings have problems (above). Let's go through them again."
    advanced=1
  done
  save_settings
}

# ----------------------------------------------------------------------------
# K40 checks
# ----------------------------------------------------------------------------
device_checklist() {
  say "   Things to check:"
  say "     - DEVICE_IP / DEVICE_PORT match the K40 (Menu > Comm. > Ethernet)"
  say "     - this computer is on the same network as the K40"
  say "     - the K40 answers a ping: ping $(val DEVICE_IP)"
  say "     - Comm Key on the K40 is 0"
  say "     - no other program (ZKTime, ZKBioTime...) is connected to the K40 right now"
}

check_device() {
  local ip port reason
  ip=$(val DEVICE_IP); port=$(val DEVICE_PORT); port=${port:-4370}
  info "Checking the K40 at $ip:$port"
  if reason=$(node "$HELPER" tcp "$ip" "$port"); then
    ok "The K40 answers on $ip:$port"
    return 0
  fi
  warn "Could not reach the K40 at $ip:$port: $reason"
  device_checklist
  confirm "Continue anyway? The bridge keeps retrying until the K40 answers" y || \
    die "Stopped. Fix the connection, then run ./setup.sh again."
  return 1
}

# Runs src/poc.ts (built as dist/poc.js) until Enter is pressed.
run_device_test() {
  local pid _
  info "Device test: stats, users and latest logs, then live punches (punch a finger to see one)"
  say "   ${B}Press Enter to end the test.${N}"
  (cd "$ROOT" && exec node dist/poc.js) </dev/null &
  pid=$!
  # shellcheck disable=SC2064 # expand $pid now
  trap "kill -TERM $pid 2>/dev/null || true; exit 130" INT TERM
  IFS= read -r _ || true
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  trap - INT TERM
  ok "Device test finished"
}

# ----------------------------------------------------------------------------
# Service: launchd (Mac) or systemd (Linux)
# ----------------------------------------------------------------------------
xml_escape() { local s=$1; s=${s//&/&amp;}; s=${s//</&lt;}; s=${s//>/&gt;}; printf '%s' "$s"; }

require_systemd() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || \
    die "systemd isn't running on this system, so the service can't be installed. Run it in the foreground with: npm start (or see README.md for pm2)."
}

svc_installed() {
  if [ "$OS" = mac ]; then [ -f "$PLIST_FILE" ]; else [ -f "$UNIT_FILE" ]; fi
}

svc_running() {
  if [ "$OS" = mac ]; then
    launchctl print "system/$PLIST_LABEL" 2>/dev/null | grep -q 'state = running'
  else
    systemctl is-active --quiet "$SERVICE"
  fi
}

svc_install() {
  local node_bin tmp user i
  node_bin=$(command -v node)
  user=$(id -un)
  info "Installing the service"
  if [ "$(id -u)" != 0 ]; then
    say "   This step needs admin rights: enter your password if sudo asks for it."
    sudo -v || die "Could not get admin rights (sudo). Run ./setup.sh again from a terminal and enter your password."
  fi
  tmp=$(mktemp)
  if [ "$OS" = mac ]; then
    mkdir -p "$ROOT/logs"
    touch "$MAC_LOG"
    cat > "$tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$node_bin")</string>
    <string>$(xml_escape "$ROOT/dist/index.js")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$ROOT")</string>
  <key>UserName</key><string>$(xml_escape "$user")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ExitTimeOut</key><integer>15</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$MAC_LOG")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$MAC_LOG")</string>
</dict>
</plist>
EOF
    plutil -lint "$tmp" >/dev/null || die "Generated launchd file is invalid: $tmp"
    as_root launchctl bootout "system/$PLIST_LABEL" 2>/dev/null || true
    as_root install -m 644 -o root -g wheel "$tmp" "$PLIST_FILE"
    rm -f "$tmp"
    as_root launchctl enable "system/$PLIST_LABEL" 2>/dev/null || true
    # Right after a bootout launchd can still be busy with the old job, so retry for a few seconds.
    for i in 1 2 3 4 5 6; do
      as_root launchctl bootstrap system "$PLIST_FILE" 2>/dev/null && break
      [ "$i" = 6 ] && die "launchctl could not load $PLIST_FILE"
      sleep 1
    done
    ok "Installed launchd service $PLIST_LABEL (starts at boot, restarts after a crash)"
  else
    require_systemd
    cat > "$tmp" <<EOF
[Unit]
Description=zk-bridge (ZKTeco K40 to CRM)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$user
WorkingDirectory=${ROOT//%/%%}
ExecStart="${node_bin//%/%%}" "${ROOT//%/%%}/dist/index.js"
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
    as_root install -m 644 "$tmp" "$UNIT_FILE"
    rm -f "$tmp"
    as_root systemctl daemon-reload
    as_root systemctl enable "$SERVICE"
    as_root systemctl restart "$SERVICE"
    ok "Installed systemd service $SERVICE (starts at boot, restarts after a crash)"
  fi
}

svc_start() {
  svc_installed || die "The service isn't installed yet. Run ./setup.sh first."
  if [ "$OS" = mac ]; then
    if ! as_root launchctl bootstrap system "$PLIST_FILE" 2>/dev/null; then
      as_root launchctl kickstart "system/$PLIST_LABEL"
    fi
  else
    as_root systemctl start "$SERVICE"
  fi
}

svc_stop() {
  svc_installed || return 0
  if [ "$OS" = mac ]; then
    as_root launchctl bootout "system/$PLIST_LABEL" 2>/dev/null || true
  else
    as_root systemctl stop "$SERVICE"
  fi
}

svc_restart() {
  svc_installed || die "The service isn't installed yet. Run ./setup.sh first."
  if [ "$OS" = mac ]; then
    if svc_running; then as_root launchctl kickstart -k "system/$PLIST_LABEL"; else svc_start; fi
  else
    as_root systemctl restart "$SERVICE"
  fi
}

svc_uninstall() {
  if ! svc_installed; then ok "The service isn't installed"; return 0; fi
  info "Removing the service (you may be asked for your password)"
  if [ "$OS" = mac ]; then
    as_root launchctl bootout "system/$PLIST_LABEL" 2>/dev/null || true
    as_root rm -f "$PLIST_FILE"
  else
    as_root systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
    as_root rm -f "$UNIT_FILE"
    as_root systemctl daemon-reload
  fi
  ok "Service removed. Your settings (.env), queued punches (data/) and logs are kept."
}

# journalctl, through sudo when this user can't read the system journal.
jctl() {
  if [ "$(id -u)" = 0 ] || id -nG | tr ' ' '\n' | grep -qxE 'adm|systemd-journal|wheel'; then
    journalctl "$@"
  else
    sudo journalctl "$@"
  fi
}

# A marker for "log lines from now on", and the log lines written after it.
log_mark() {
  if [ "$OS" = mac ]; then
    if [ -f "$MAC_LOG" ]; then wc -c < "$MAC_LOG" | tr -d ' '; else echo 0; fi
  else
    date +%s
  fi
}

log_since() {
  if [ "$OS" = mac ]; then
    [ -f "$MAC_LOG" ] || return 0
    tail -c "+$(( $1 + 1 ))" "$MAC_LOG"
  else
    jctl -u "$SERVICE" --since "@$1" -o cat --no-pager -q 2>/dev/null
  fi
}

log_location() {
  if [ "$OS" = mac ]; then printf '%s' "$MAC_LOG"; else printf 'journalctl -u %s' "$SERVICE"; fi
}

last_status_line() {
  if [ "$OS" = mac ]; then
    [ -f "$MAC_LOG" ] && grep 'Status:' "$MAC_LOG" | tail -n 1
  else
    jctl -u "$SERVICE" -o cat --no-pager -q 2>/dev/null | grep 'Status:' | tail -n 1
  fi
  return 0
}

wait_ready() {
  local mark=$1 start=$SECONDS out
  info "Waiting for the bridge to start (it first downloads the K40 log)"
  while :; do
    out=$(log_since "$mark" || true)
    case "$out" in
      *"Bridge running"*) ok "Bridge running"; return 0 ;;
      *"Invalid configuration"*|*"Could not load configuration"*|*"Fatal:"*|*"refusing to start"*|*"Operation not permitted"*|*"EPERM"*)
        warn "The bridge failed to start. Last log lines:"
        printf '%s\n' "$out" | tail -n 25 | sed 's/^/      /' >&2
        case "$OS:$out" in
          mac:*"Operation not permitted"*|mac:*EPERM*)
            warn "macOS blocked the service from reading this folder. Move it out of Desktop/Documents/Downloads and run ./setup.sh again." ;;
        esac
        return 1 ;;
    esac
    if [ $((SECONDS - start)) -ge "$READY_TIMEOUT" ]; then
      warn "No \"Bridge running\" after ${READY_TIMEOUT}s. Last log lines:"
      printf '%s\n' "$out" | tail -n 25 | sed 's/^/      /' >&2
      return 1
    fi
    sleep 2
  done
}

# ----------------------------------------------------------------------------
# Commands
# ----------------------------------------------------------------------------
usage() {
  cat <<EOF
${B}zk-bridge setup${N}: install the bridge and run it as a service, in one command

Usage:
  ./setup.sh               Interactive setup: Node.js, packages, settings, K40 check, service
  ./setup.sh --yes         The same without questions (uses .env as it is)

  ./setup.sh status        Is the service running? Plus the last "Status:" line
  ./setup.sh logs          Follow the log (Ctrl+C to stop watching; the bridge keeps running)
  ./setup.sh start|stop|restart
  ./setup.sh test          Device test (stats, users, logs, live punches)
  ./setup.sh info          Show the current settings
  ./setup.sh update        Rebuild after an update (git pull if this is a git folder) and restart
  ./setup.sh uninstall     Remove the service (keeps .env, data/ and logs/)
  ./setup.sh help          This help

Windows: use setup.cmd (same commands).
EOF
}

print_summary() {
  local port
  port=$(val DEVICE_PORT)
  say ""
  say "${B}zk-bridge is running${N} as a service. It starts by itself at boot and restarts after a crash."
  say ""
  printf '  %-6s %s\n' K40 "$(val DEVICE_IP):${port:-4370} (clock in $(val DEVICE_TIMEZONE))"
  printf '  %-6s %s\n' CRM "$(val CRM_BASE_URL)  (key $(mask "$(val CRM_DEVICE_KEY)"))"
  printf '  %-6s %s\n' Log "$(log_location)"
  printf '  %-6s %s\n' Queue "$(val OUTBOX_PATH)"
  say ""
  say "  The first \"Status: OK\" line appears about 1 minute after start: ./setup.sh status"
  say "  ${D}Manage: ./setup.sh status | logs | restart | stop | start | test | update | uninstall${N}"
}

cmd_setup() {
  local mark
  say ""
  say "${B}zk-bridge setup${N}  ${D}(ZKTeco K40 -> CRM bridge, $(cd "$ROOT" && node -p 'require("./package.json").version' 2>/dev/null || echo '?'))${N}"
  check_user
  check_folder
  ensure_node
  if svc_installed && svc_running; then
    info "Stopping the running bridge while it is set up again"
    svc_stop
  fi
  install_packages
  build
  settings_step
  if check_device && [ "$ASSUME_YES" = 0 ]; then
    if confirm "Run the full device test now (stats, users, logs, live punches)?" n; then run_device_test; fi
  fi
  mark=$(log_mark)
  svc_install
  wait_ready "$mark" || die "Setup finished, but the bridge didn't start properly (see above). Fix it, then: ./setup.sh restart"
  print_summary
  say ""
  ok "${B}All set!${N}"
}

cmd_status() {
  local line
  if ! svc_installed; then say "The service isn't installed. Run ./setup.sh"; return 0; fi
  if svc_running; then ok "Service is running"; else warn "Service is installed but not running (./setup.sh start)"; fi
  line=$(last_status_line)
  if [ -n "$line" ]; then say "   Last status: $line"; else say "   No \"Status:\" line yet (it comes about 1 minute after start)."; fi
  say "   ${D}Log: $(log_location)${N}"
}

cmd_logs() {
  if [ "$OS" = mac ]; then
    [ -f "$MAC_LOG" ] || die "No log yet ($MAC_LOG). Run ./setup.sh first."
    tail -n 100 -F "$MAC_LOG"
  else
    jctl -u "$SERVICE" -f -n 100 -o cat
  fi
}

cmd_test() {
  local was_running=0
  [ -f "$ROOT/dist/poc.js" ] || die "Not built yet. Run ./setup.sh first."
  [ -f "$ENV_FILE" ] || die "No .env yet. Run ./setup.sh first."
  if svc_installed && svc_running; then
    was_running=1
    info "Stopping the service during the test"
    svc_stop
  fi
  run_device_test
  if [ "$was_running" = 1 ]; then info "Starting the service again"; svc_start; ok "Service started"; fi
}

cmd_info() {
  local key v
  load_settings
  say "${B}Settings${N} ${D}($ENV_FILE)${N}"
  [ -f "$ENV_FILE" ] || warn "No .env yet: these are the defaults from .env.example. Run ./setup.sh"
  for key in $KEYS; do
    v=$(val "$key")
    [ "$key" = CRM_DEVICE_KEY ] && v=$(mask "$v")
    printf '  %-26s %s\n' "$key" "$v"
  done
}

cmd_update() {
  local mark problems
  check_user
  ensure_node
  if [ -d "$ROOT/.git" ] && command -v git >/dev/null 2>&1; then
    info "Getting the latest version (git pull)"
    git -C "$ROOT" pull --ff-only || warn "git pull failed (local changes?). Rebuilding the current files."
  fi
  svc_stop
  install_packages
  build
  load_settings
  if ! problems=$(validate); then say "$problems" >&2; die "The settings in .env have problems (above). Run ./setup.sh to fix them."; fi
  if svc_installed; then
    mark=$(log_mark)
    svc_start
    wait_ready "$mark" || die "Updated, but the bridge didn't start properly (see above)."
    ok "Updated and running"
  else
    ok "Updated. The service isn't installed yet: run ./setup.sh"
  fi
}

main() {
  local cmd=setup
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -y|--yes) ASSUME_YES=1 ;;
      -h|--help|help) cmd=help ;;
      setup|start|stop|restart|status|logs|test|info|update|uninstall) cmd=$1 ;;
      *) die "Unknown command '$1'. See ./setup.sh help" ;;
    esac
    shift
  done
  detect_os
  case "$cmd" in
    help)      usage ;;
    setup)     cmd_setup ;;
    status)    cmd_status ;;
    logs)      cmd_logs ;;
    info)      node_ok || die "Node.js 22.13+ is needed. Run ./setup.sh first."; cmd_info ;;
    test)      cmd_test ;;
    update)    cmd_update ;;
    uninstall) svc_uninstall ;;
    start)     svc_start; ok "Service started" ;;
    stop)      svc_stop; ok "Service stopped (it starts again at the next boot, or with ./setup.sh start)" ;;
    restart)   svc_restart; ok "Service restarted" ;;
  esac
}

main "$@"
