#!/usr/bin/env bash
# Tear down the demo staged by scripts/demo/stage.sh.
set -euo pipefail

DEMO_ROOT="${STATION_DEMO_ROOT:-$HOME/.station-demo}"
CONFIG="$DEMO_ROOT/config.toml"

if [ -f "$CONFIG" ] && command -v stn >/dev/null 2>&1; then
  stn --config "$CONFIG" observer stop >/dev/null 2>&1 || true
fi
tmux kill-session -t stationdemo >/dev/null 2>&1 || true
rm -rf "$DEMO_ROOT"
echo "Removed $DEMO_ROOT (stopped the demo observer + tmux session if present)."
