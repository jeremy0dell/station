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
SOCKET_DIR="$(python3 - "$ROOT" <<'PY'
import hashlib, os, sys, tempfile
root = sys.argv[1]
digest = hashlib.sha256(root.encode()).hexdigest()[:12]
print(os.path.join(tempfile.gettempdir(), f"stn-db-{digest}"))
PY
)"
OBSERVER_SOCK="$SOCKET_DIR/observer.sock"
HOST_SOCK="$SOCKET_DIR/station-host.sock"
COMMAND="${1:-start}"
if [ "$COMMAND" = "--hot" ]; then
  COMMAND="dev"
fi

if [ ! -f "$CLI" ]; then
  echo "stn CLI is not built ($CLI missing). Run 'pnpm build' at the repo root first." >&2
  exit 1
fi

mkdir -p "$DS/observer" "$SOCKET_DIR"

if [ "$COMMAND" = "stop" ]; then
  # Graceful stop can hang mid-reconcile, so finish with path-scoped SIGKILLs
  # against only this worktree's isolated observer and persistent host.
  node "$CLI" --config "$CFG" observer stop --timeout-ms 8000 >/dev/null 2>&1 || true
  pkill -9 -f "observerMain\.js.*$DS/observer" 2>/dev/null && echo "stopped isolated observer." || true
  pkill -9 -f "hostMain\.ts.*$DS/observer" 2>/dev/null && echo "stopped persistent host." || true
  rm -f "$OBSERVER_SOCK" "$HOST_SOCK" "$DS/observer/run/observer.sock" "$DS/observer/run/station-host.sock"
  echo "isolated observer + host torn down."
  exit 0
fi

if [ "$COMMAND" != "start" ] && [ "$COMMAND" != "dev" ]; then
  echo "Usage: $0 [start|dev|--hot|stop]" >&2
  exit 1
fi

# Build the isolated config from the real one: durable observer state relocated
# to .dev-state and sockets relocated to a short temp path. Everything else
# (worktrunk discovery, harness config) is inherited so Station shows the same
# worktree rows.
python3 - "$CFG" "$DS" "$OBSERVER_SOCK" <<'PY'
import os, re, sys
path = sys.argv[1]
ds = sys.argv[2]
observer_sock = sys.argv[3]
src = os.path.expanduser("~/.config/station/config.toml")
fallback = (
    'schema_version = 1\n\n[observer]\nsocket_path = ""\nstate_dir = ""\n\n'
    '[defaults]\nworktree_provider = "worktrunk"\nterminal = "tmux"\n'
    'harness = "codex"\nlayout = "agent-shell"\n'
)
cfg = open(path).read() if os.path.exists(path) else open(src).read() if os.path.exists(src) else fallback

def section_bounds(source, section):
    header_pattern = rf'^[ \t]*\[{re.escape(section)}\][ \t]*(?:#.*)?$'
    header = re.search(header_pattern, source, flags=re.M)
    if not header:
        return None
    next_header = re.search(r'^[ \t]*\[.*\][ \t]*(?:#.*)?$', source[header.end():], flags=re.M)
    body_end = len(source) if not next_header else header.end() + next_header.start()
    return header, body_end

def split_top_level_commas(source):
    parts = []
    start = 0
    quote = None
    escaped = False
    square_depth = 0
    brace_depth = 0
    for index, char in enumerate(source):
        if quote:
            if quote == '"' and char == "\\" and not escaped:
                escaped = True
                continue
            if char == quote and not escaped:
                quote = None
            escaped = False
            continue
        if char in ('"', "'"):
            quote = char
        elif char == "[":
            square_depth += 1
        elif char == "]":
            square_depth = max(0, square_depth - 1)
        elif char == "{":
            brace_depth += 1
        elif char == "}":
            brace_depth = max(0, brace_depth - 1)
        elif char == "," and square_depth == 0 and brace_depth == 0:
            parts.append(source[start:index])
            start = index + 1
    parts.append(source[start:])
    return parts

def top_level_equals(source):
    quote = None
    escaped = False
    square_depth = 0
    brace_depth = 0
    for index, char in enumerate(source):
        if quote:
            if quote == '"' and char == "\\" and not escaped:
                escaped = True
                continue
            if char == quote and not escaped:
                quote = None
            escaped = False
            continue
        if char == "=" and square_depth == 0 and brace_depth == 0:
            return index
        if char in ('"', "'"):
            quote = char
        elif char == "[":
            square_depth += 1
        elif char == "]":
            square_depth = max(0, square_depth - 1)
        elif char == "{":
            brace_depth += 1
        elif char == "}":
            brace_depth = max(0, brace_depth - 1)
    return -1

def inline_table_lines(body):
    lines = []
    for part in split_top_level_commas(body):
        part = part.strip()
        if not part:
            continue
        equals = top_level_equals(part)
        if equals == -1:
            continue
        lines.append(f"{part[:equals].strip()} = {part[equals + 1:].strip()}")
    return lines

def expand_inline_table_section(source, section):
    if "." not in section:
        return source
    parent, key = section.rsplit(".", 1)
    bounds = section_bounds(source, parent)
    if not bounds:
        return source
    header, body_end = bounds
    body = source[header.end():body_end]
    inline = re.search(rf'^[ \t]*{re.escape(key)}[ \t]*=[ \t]*\{{(.*)\}}[ \t]*(?:#.*)?$', body, flags=re.M)
    if not inline:
        return source
    lines = inline_table_lines(inline.group(1))
    if not lines:
        return source
    line_start = header.end() + inline.start()
    line_end = line_start + len(inline.group(0))
    remove_end = line_end + 1 if line_end < len(source) and source[line_end] == "\n" else line_end
    without_inline = source[:line_start] + source[remove_end:]
    insertion = body_end - (remove_end - line_start)
    suffix = re.sub(r'^\n+', '\n', without_inline[insertion:])
    return without_inline[:insertion].rstrip() + f"\n\n[{section}]\n" + "\n".join(lines) + "\n" + suffix

def set_section_key(source, section, key, rendered):
    bounds = section_bounds(source, section)
    if not bounds:
        expanded = expand_inline_table_section(source, section)
        bounds = section_bounds(expanded, section)
        if bounds:
            return set_section_key(expanded, section, key, rendered)
        return source.rstrip() + f"\n\n[{section}]\n{key} = {rendered}\n"
    header, body_end = bounds
    body = source[header.end():body_end]
    key_pattern = rf'^(\s*{re.escape(key)}\s*=\s*).*$'
    if re.search(key_pattern, body, flags=re.M):
        next_body = re.sub(key_pattern, rf'\1{rendered}', body, count=1, flags=re.M)
    else:
        next_body = f"\n{key} = {rendered}{body}"
    return source[:header.end()] + next_body + source[body_end:]
cfg = set_section_key(cfg, "observer", "socket_path", f'"{observer_sock}"')
cfg = set_section_key(cfg, "observer", "state_dir", f'"{ds}/observer"')
# Isolated Station must not enumerate machine-global tmux panes; that would mark
# rows as already running. The station provider is still registered separately.
cfg = set_section_key(cfg, "defaults", "terminal", '"noop-terminal"')
cfg = set_section_key(cfg, "feature_flags", "station_persistent_agents", "true")
for harness in ("codex", "claude", "cursor", "opencode"):
    cfg = set_section_key(cfg, f"harness.{harness}", "install_hooks", "true")
os.makedirs(os.path.dirname(path), exist_ok=True)
open(path, "w").write(cfg)
PY

# The observer (Node) spawns the Bun host on demand; it finds the host entry via
# this env var (observerProviders.ts does not pass it, so the env is REQUIRED —
# without it the host is silently "unavailable" and PTYs fall back to non-persistent).
export STATION_HOST_ENTRY="$STATION_DIR/src/host/hostMain.ts"
# Station (Bun) connects to the isolated observer (not the global one) via this env.
export STATION_OBSERVER_SOCKET_PATH="$OBSERVER_SOCK"
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

seed_cursor_link() {
  [ -e "$1" ] || return 0
  rm -rf "$2"
  mkdir -p "$(dirname "$2")"
  ln -s "$1" "$2"
}
seed_cursor_link "$HOME/.gitconfig" "$STATION_CURSOR_HOME/.gitconfig"
seed_cursor_link "$HOME/.git-credentials" "$STATION_CURSOR_HOME/.git-credentials"
seed_cursor_link "$HOME/.ssh" "$STATION_CURSOR_HOME/.ssh"
seed_cursor_link "$HOME/.config/git" "$STATION_CURSOR_HOME/.config/git"

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
echo "  Inspect agents:  bun run host:list -- --socket $HOST_SOCK"
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
