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
CFG="$DS/config.toml"
STATION_DIR="$ROOT/station"
CLI="$ROOT/apps/cli/dist/main.js"
COMMAND="${1:-start}"
if [ "$COMMAND" = "--hot" ]; then
  COMMAND="dev"
fi

if [ ! -f "$CLI" ]; then
  echo "stn CLI is not built ($CLI missing). Run 'pnpm build' at the repo root first." >&2
  exit 1
fi

mkdir -p "$DS/observer/run"

if [ "$COMMAND" = "stop" ]; then
  # Graceful stop can hang mid-reconcile, so finish with path-scoped SIGKILLs
  # against only this worktree's isolated observer and persistent host.
  node "$CLI" --config "$CFG" observer stop --timeout-ms 8000 >/dev/null 2>&1 || true
  pkill -9 -f "observerMain\.js.*$DS/observer" 2>/dev/null && echo "stopped isolated observer." || true
  pkill -9 -f "hostMain\.ts.*$DS/observer" 2>/dev/null && echo "stopped persistent host." || true
  rm -f "$DS/observer/run/observer.sock" "$DS/observer/run/station-host.sock"
  echo "isolated observer + host torn down."
  exit 0
fi

if [ "$COMMAND" != "start" ] && [ "$COMMAND" != "dev" ]; then
  echo "Usage: $0 [start|dev|--hot|stop]" >&2
  exit 1
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
def set_section_key(source, section, key, rendered):
    header_pattern = rf'^\[{re.escape(section)}\]\s*$'
    header = re.search(header_pattern, source, flags=re.M)
    if not header:
        return source.rstrip() + f"\n\n[{section}]\n{key} = {rendered}\n"
    next_header = re.search(r'^\[.*\]\s*$', source[header.end():], flags=re.M)
    body_end = len(source) if not next_header else header.end() + next_header.start()
    body = source[header.end():body_end]
    key_pattern = rf'^(\s*{re.escape(key)}\s*=\s*).*$'
    if re.search(key_pattern, body, flags=re.M):
        next_body = re.sub(key_pattern, rf'\1{rendered}', body, count=1, flags=re.M)
    else:
        next_body = f"\n{key} = {rendered}{body}"
    return source[:header.end()] + next_body + source[body_end:]
cfg = set_section_key(cfg, "observer", "socket_path", f'"{ds}/observer/run/observer.sock"')
cfg = set_section_key(cfg, "observer", "state_dir", f'"{ds}/observer"')
# Isolated Station must not enumerate machine-global tmux panes; that would mark
# rows as already running. The station provider is still registered separately.
cfg = set_section_key(cfg, "defaults", "terminal", '"noop-terminal"')
cfg = set_section_key(cfg, "feature_flags", "station_persistent_agents", "true")
open(f"{ds}/config.toml", "w").write(cfg)
PY
fi

python3 - "$CFG" "$DS" <<'PY'
import os, re, sys
path = sys.argv[1]
ds = sys.argv[2]
if not os.path.exists(path):
    sys.exit(0)
cfg = open(path).read()
def set_section_key(source, section, key, rendered):
    header_pattern = rf'^\[{re.escape(section)}\]\s*$'
    header = re.search(header_pattern, source, flags=re.M)
    if not header:
        return source.rstrip() + f"\n\n[{section}]\n{key} = {rendered}\n"
    next_header = re.search(r'^\[.*\]\s*$', source[header.end():], flags=re.M)
    body_end = len(source) if not next_header else header.end() + next_header.start()
    body = source[header.end():body_end]
    key_pattern = rf'^(\s*{re.escape(key)}\s*=\s*).*$'
    if re.search(key_pattern, body, flags=re.M):
        next_body = re.sub(key_pattern, rf'\1{rendered}', body, count=1, flags=re.M)
    else:
        next_body = f"\n{key} = {rendered}{body}"
    return source[:header.end()] + next_body + source[body_end:]
cfg = set_section_key(cfg, "observer", "socket_path", f'"{ds}/observer/run/observer.sock"')
cfg = set_section_key(cfg, "observer", "state_dir", f'"{ds}/observer"')
cfg = set_section_key(cfg, "defaults", "terminal", '"noop-terminal"')
cfg = set_section_key(cfg, "feature_flags", "station_persistent_agents", "true")
for harness in ("codex", "claude", "cursor", "opencode"):
    cfg = set_section_key(cfg, f"harness.{harness}", "install_hooks", "true")
open(path, "w").write(cfg)
PY

# The observer (Node) spawns the Bun host on demand; it finds the host entry via
# this env var (observerProviders.ts does not pass it, so the env is REQUIRED —
# without it the host is silently "unavailable" and PTYs fall back to non-persistent).
export STATION_HOST_ENTRY="$STATION_DIR/src/host/hostMain.ts"
# Station (Bun) connects to the isolated observer (not the global one) via this env.
export STATION_OBSERVER_SOCKET_PATH="$DS/observer/run/observer.sock"
# Station reads [tui.widgets] directly for its overlay header; point it at the
# same isolated config as the observer instead of the user's global default.
export STATION_CONFIG_PATH="$CFG"
# Keep generated hooks/provider config isolated to this worktree and make hooks
# resolve this checkout's `stn-ingress`. Launched agents inherit these env vars,
# so status reports target this observer instead of global station state.
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

export STATION_CURSOR_HOME="$DS/cursor-home"
export OPENCODE_CONFIG_DIR="$DS/opencode-config"
mkdir -p "$STATION_CURSOR_HOME" "$OPENCODE_CONFIG_DIR"

# Idempotent: reuses a healthy observer, so reopening Station leaves agents alone.
node "$CLI" --config "$CFG" observer start >/dev/null

# Install status hooks against THIS observer so the launch guard lets these
# harnesses spawn; each writes into its own isolated home/state, never globals.
for harness in codex claude cursor opencode; do
  node "$CLI" --config "$CFG" hooks install "$harness" --yes >/dev/null 2>&1 || true
done

echo "Isolated observer up — $STATION_OBSERVER_SOCKET_PATH"
if [ "$COMMAND" = "dev" ]; then
  echo "  Hot reload: edit station/src/**; Bun HMR updates the isolated UI."
else
  echo "  Launch an agent, quit Station (q), re-run 'bun run station:isolated' → it reattaches."
fi
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
if [ "$COMMAND" = "dev" ]; then
  exec bun run dev
fi
exec bun run station
