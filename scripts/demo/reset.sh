#!/usr/bin/env bash
# Tear down the isolated workspace staged by scripts/demo/stage.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEMO_ROOT_INPUT="${STATION_DEMO_ROOT:-$HOME/.station-demo}"
STN="${STATION_DEMO_STN:-$ROOT/bin/stn}"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
DEMO_ROOT="$(canonicalize_demo_root "$DEMO_ROOT_INPUT")"
HOME_ROOT="$(canonicalize_demo_root "$HOME")"
CHECKOUT_ROOT="$(canonicalize_demo_root "$ROOT")"
CONFIG="$DEMO_ROOT/config.toml"
STATE="$DEMO_ROOT/state"
MARKER="$DEMO_ROOT/.station-demo-root"

case "$DEMO_ROOT" in
  ""|/|"$HOME_ROOT"|"$CHECKOUT_ROOT")
    echo "Refusing to remove unsafe demo root: $DEMO_ROOT" >&2
    exit 1
    ;;
esac
case "$HOME_ROOT/" in
  "$DEMO_ROOT/"*)
    echo "Refusing to remove a parent of HOME: $DEMO_ROOT" >&2
    exit 1
    ;;
esac
case "$CHECKOUT_ROOT/" in
  "$DEMO_ROOT/"*)
    echo "Refusing to remove a parent of this checkout: $DEMO_ROOT" >&2
    exit 1
    ;;
esac
case "$DEMO_ROOT/" in
  "$CHECKOUT_ROOT/"*)
    echo "Refusing to stage demo data inside this checkout: $DEMO_ROOT" >&2
    exit 1
    ;;
esac

if [ -e "$DEMO_ROOT" ] && [ ! -d "$DEMO_ROOT" ]; then
  echo "Refusing to replace non-directory demo root: $DEMO_ROOT" >&2
  exit 1
fi
legacy_demo_root() {
  [ -f "$CONFIG" ] && [ ! -L "$CONFIG" ] &&
    grep -Fq "state_dir = \"$STATE\"" "$CONFIG" &&
    grep -Fq 'workbench_session = "stationdemo"' "$CONFIG"
}

valid_demo_marker() {
  [ -f "$MARKER" ] && [ ! -L "$MARKER" ] && [ "$(cat "$MARKER")" = "station-demo-v1" ]
}

if [ -d "$DEMO_ROOT" ] && ! valid_demo_marker && ! legacy_demo_root; then
  if [ -n "$(find "$DEMO_ROOT" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    echo "Refusing to remove an unrecognized demo root: $DEMO_ROOT" >&2
    echo "Choose an empty STATION_DEMO_ROOT or remove it manually after reviewing its contents." >&2
    exit 1
  fi
fi

stn_demo() {
  PATH="$ROOT/bin:$PATH" \
    STATION_CONFIG_PATH="$CONFIG" \
    STATION_OBSERVER_SOCKET_PATH="$STATE/run/observer.sock" \
    STATION_LAYOUT_PATH="$STATE/station/layout.json" \
    CODEX_HOME="$DEMO_ROOT/codex-home" \
    CLAUDE_CONFIG_DIR="$DEMO_ROOT/claude-home" \
    STATION_CURSOR_HOME="$DEMO_ROOT/cursor-home" \
    OPENCODE_CONFIG_DIR="$DEMO_ROOT/opencode-home" \
    "$STN" --config "$CONFIG" "$@"
}

socket_pids() {
  lsof -n -t "$1" 2>/dev/null | awk '/^[0-9]+$/ { print }' | sort -u || true
}

process_command() {
  ps -ww -p "$1" -o command= 2>/dev/null || true
}

owner_matches_demo_runtime() {
  local socket="$1" pid="$2" command
  command="$(process_command "$pid")"
  case "$command" in
    *"--socket $socket"*"--state-dir $STATE"*) ;;
    *) return 1 ;;
  esac
  case "$socket" in
    */observer.sock)
      case "$command" in
        *observerMain.js*|*__observer*) return 0 ;;
        *) return 1 ;;
      esac
      ;;
    */station-host.sock)
      case "$command" in
        *hostMain.ts*|*__station-host*) return 0 ;;
        *) return 1 ;;
      esac
      ;;
  esac
  return 1
}

capture_socket_owners() {
  local socket="$1" pids pid
  if [ -L "$socket" ]; then
    echo "Refusing to follow a symlink at demo socket path: $socket" >&2
    return 1
  fi
  [ -S "$socket" ] || return 0
  if ! command -v lsof >/dev/null 2>&1; then
    echo "Refusing to remove $DEMO_ROOT while socket ownership cannot be checked: $socket" >&2
    return 1
  fi
  pids="$(socket_pids "$socket")"
  [ -n "$pids" ] || return 0
  for pid in $pids; do
    if ! owner_matches_demo_runtime "$socket" "$pid"; then
      echo "Refusing to signal unverified process $pid at $socket: $(process_command "$pid")" >&2
      return 1
    fi
  done
  printf '%s\n' "$pids"
}

live_pids() {
  local pid
  for pid in $1; do
    kill -0 "$pid" >/dev/null 2>&1 && printf '%s\n' "$pid"
  done
}

wait_for_pids() {
  local pids="$1" attempts="$2" remaining="$1" next pid attempt
  for ((attempt = 0; attempt < attempts; attempt += 1)); do
    next="$(live_pids "$remaining")"
    [ -z "$next" ] && return 0
    remaining="$next"
    sleep 0.1
  done
  printf '%s\n' "$remaining"
  return 1
}

stop_captured_owners() {
  local socket="$1" pids="$2" remaining pid
  remaining="$(live_pids "$pids")"
  [ -n "$remaining" ] || return 0
  for pid in $remaining; do
    if ! owner_matches_demo_runtime "$socket" "$pid"; then
      echo "Refusing to signal changed or unverified process $pid at $socket." >&2
      return 1
    fi
    kill "$pid" >/dev/null 2>&1 || true
  done
  if remaining="$(wait_for_pids "$remaining" 50)"; then
    return 0
  fi
  for pid in $remaining; do
    if ! owner_matches_demo_runtime "$socket" "$pid"; then
      echo "Refusing to force-kill changed or unverified process $pid at $socket." >&2
      return 1
    fi
    kill -KILL "$pid" >/dev/null 2>&1 || true
  done
  if remaining="$(wait_for_pids "$remaining" 10)"; then
    return 0
  fi
  echo "Refusing to remove $DEMO_ROOT; a validated process did not exit: $remaining" >&2
  return 1
}

verify_socket_unowned() {
  local socket="$1" pids
  if [ -L "$socket" ]; then
    echo "Refusing to follow a symlink at demo socket path: $socket" >&2
    return 1
  fi
  [ -S "$socket" ] || return 0
  if ! command -v lsof >/dev/null 2>&1; then
    echo "Refusing to verify $socket because lsof is unavailable." >&2
    return 1
  fi
  pids="$(socket_pids "$socket")"
  [ -z "$pids" ] && return 0
  echo "Refusing to remove $DEMO_ROOT; a new process owns $socket: $pids" >&2
  return 1
}

if [ -L "$STATE" ] || [ -L "$STATE/run" ]; then
  echo "Refusing to follow a symlink in the demo socket directory: $STATE/run" >&2
  exit 1
fi

observer_pids="$(capture_socket_owners "$STATE/run/observer.sock")"
host_pids="$(capture_socket_owners "$STATE/run/station-host.sock")"
legacy_observer_pids="$(capture_socket_owners "$STATE/observer.sock")"
legacy_host_pids="$(capture_socket_owners "$STATE/station-host.sock")"

if [ -f "$CONFIG" ] && [ -x "$STN" ]; then
  stn_demo observer stop --timeout-ms 8000 >/dev/null 2>&1 || true
fi

# Captured identities remain the authority even if graceful shutdown unlinks a socket first.
stop_captured_owners "$STATE/run/observer.sock" "$observer_pids"
stop_captured_owners "$STATE/observer.sock" "$legacy_observer_pids"
stop_captured_owners "$STATE/run/station-host.sock" "$host_pids"
stop_captured_owners "$STATE/station-host.sock" "$legacy_host_pids"
verify_socket_unowned "$STATE/run/observer.sock"
verify_socket_unowned "$STATE/observer.sock"
verify_socket_unowned "$STATE/run/station-host.sock"
verify_socket_unowned "$STATE/station-host.sock"

if command -v tmux >/dev/null 2>&1; then
  tmux kill-session -t stationdemo >/dev/null 2>&1 || true
fi
rm -rf "$DEMO_ROOT"
echo "Removed $DEMO_ROOT (stopped the isolated observer, host, and tmux session if present)."
