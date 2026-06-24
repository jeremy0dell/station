#!/usr/bin/env bash
# Run Station against a worktree-local observer/host so persistent agents survive
# Station restarts without touching global station state. `station:isolated:stop`
# tears the isolated observer and host down.
set -euo pipefail

# Resolve THIS worktree's root from the script's own location, so the tooling
# always targets the checkout it lives in (never the global state).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DS="$ROOT/.dev-state"
CFG="$DS/station.toml"
STATION_DIR="$ROOT/station"
CLI="$ROOT/apps/cli/dist/main.js"

if [ ! -f "$CLI" ]; then
  echo "stn CLI is not built ($CLI missing). Run 'pnpm build' at the repo root first." >&2
  exit 1
fi

mkdir -p "$DS/observer/run"

if [ "${1:-}" = "stop" ]; then
  # Graceful stop can hang mid-reconcile, so finish with path-scoped SIGKILLs
  # against only this worktree's isolated observer and persistent host.
  node "$CLI" --config "$CFG" observer stop --timeout-ms 8000 >/dev/null 2>&1 || true
  pkill -9 -f "observerMain\.js.*$DS/observer" 2>/dev/null && echo "stopped isolated observer." || true
  pkill -9 -f "hostMain\.ts.*$DS/observer" 2>/dev/null && echo "stopped persistent host." || true
  rm -f "$DS/observer/run/observer.sock" "$DS/observer/run/station-host.sock"
  echo "isolated observer + host torn down."
  exit 0
fi

# Build the isolated config from the real one: observer state + socket relocated
# to .dev-state, the persistence flag on. Everything else (worktrunk discovery,
# harness config) is inherited so Station shows the same worktree rows.
if [ ! -f "$CFG" ]; then
  python3 - "$DS" <<'PY'
import os, re, sys
ds = sys.argv[1]
src = os.path.expanduser("~/.config/station/config.toml")
fallback = (
    'schema_version = 1\n\n[observer]\nsocket_path = ""\nstate_dir = ""\n\n'
    '[defaults]\nworktree_provider = "worktrunk"\nterminal = "tmux"\n'
    'harness = "codex"\nlayout = "agent-shell"\n'
)
cfg = open(src).read() if os.path.exists(src) else fallback
cfg = re.sub(r'socket_path = "[^"]*"', f'socket_path = "{ds}/observer/run/observer.sock"', cfg, count=1)
cfg = re.sub(r'state_dir = "[^"]*"', f'state_dir = "{ds}/observer"', cfg, count=1)
# Isolated Station must not enumerate machine-global tmux panes; that would mark
# rows as already running. The station provider is still registered separately.
cfg = re.sub(r'(\[defaults\][^\[]*?terminal = )"[^"]*"', r'\1"noop-terminal"', cfg, count=1, flags=re.S)
if "station_persistent_agents" not in cfg and "stationPersistentAgents" not in cfg:
    cfg = cfg.rstrip() + "\n\n[feature_flags]\nstation_persistent_agents = true\n"
open(f"{ds}/station.toml", "w").write(cfg)
PY
fi

# The observer (Node) spawns the Bun host on demand; it finds the host entry via
# this env var (observerProviders.ts does not pass it, so the env is REQUIRED —
# without it the host is silently "unavailable" and PTYs fall back to non-persistent).
export STATION_HOST_ENTRY="$STATION_DIR/src/host/hostMain.ts"
# Station (Bun) connects to the isolated observer (not the global one) via this env.
export STATION_OBSERVER_SOCKET_PATH="$DS/observer/run/observer.sock"
# Station reads [tui.widgets] directly for its overlay header; point it at the
# same isolated config as the observer instead of the user's global default.
export STATION_CONFIG_PATH="$CFG"
# Keep Codex hooks/auth isolated to this worktree and make generated hooks
# resolve this checkout's `stn-ingress`. Launched agents inherit both, so status
# reports target this observer instead of global station state.
export PATH="$ROOT/bin:$PATH"
export CODEX_HOME="$DS/codex-home"
# Seed isolated Codex auth/config: auth is a shared symlink, config is copied once
# so project writes stay in this worktree-local home.
mkdir -p "$CODEX_HOME"
[ -e "$HOME/.codex/auth.json" ] && ln -sf "$HOME/.codex/auth.json" "$CODEX_HOME/auth.json"
[ -e "$HOME/.codex/config.toml" ] && [ ! -e "$CODEX_HOME/config.toml" ] && cp "$HOME/.codex/config.toml" "$CODEX_HOME/config.toml"

# Claude isolates its config via CLAUDE_CONFIG_DIR instead of CODEX_HOME; keeps the
# hook install below off your global ~/.claude. Auth lives in the (machine-global)
# Keychain, so unlike codex there's nothing to seed.
export CLAUDE_CONFIG_DIR="$DS/claude-home"
mkdir -p "$CLAUDE_CONFIG_DIR"

# Idempotent: reuses a healthy observer, so reopening Station leaves agents alone.
node "$CLI" --config "$CFG" observer start >/dev/null

# Install status hooks against THIS observer so the launch guard lets these
# harnesses spawn; each writes into its own isolated home/state, never globals.
for harness in codex claude; do
  node "$CLI" --config "$CFG" hooks install "$harness" --yes >/dev/null 2>&1 || true
done

echo "Isolated observer up — $STATION_OBSERVER_SOCKET_PATH"
echo "  Launch an agent, quit Station (q), re-run 'bun run station:isolated' → it reattaches."
echo "  Inspect agents:  bun run host:list -- --socket $DS/observer/run/station-host.sock"
echo "  Host timeline:   tail -f $DS/observer/logs/station-host.jsonl"
echo "  Stop everything: bun run station:isolated:stop"
echo

# Escape hatch for scripted verification (start the observer, skip the TUI).
if [ "${STATION_ISOLATED_NO_LAUNCH:-}" = "1" ]; then
  echo "(STATION_ISOLATED_NO_LAUNCH=1 — observer is up; not launching the Station TUI)"
  exit 0
fi

cd "$STATION_DIR"
exec bun run station
