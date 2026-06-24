#!/usr/bin/env bash
# Stage a self-contained Station demo for screenshots / recordings.
#
# Creates shallow showcase clones with planted diffs, an add-project sample repo,
# writes an ISOLATED observer config, and checks demo dependencies. Everything
# lives under $STATION_DEMO_ROOT (default ~/.station-demo) and never touches your
# real ~/.config/station or ~/.local/state/station. Launch with:
#
#   "$STATION_DEMO_ROOT/run.sh"
#
# Tear it all down with scripts/demo/reset.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEMO_ROOT="${STATION_DEMO_ROOT:-$HOME/.station-demo}"
REPOS="$DEMO_ROOT/repos"
WORKTREES="$DEMO_ROOT/worktrees"
STATE="$DEMO_ROOT/state"
CONFIG="$DEMO_ROOT/config.toml"
RUNNER="$DEMO_ROOT/run.sh"
HOOKS_REPORT="$DEMO_ROOT/hooks.txt"
CODEX_DEMO_HOME="$DEMO_ROOT/codex-home"
CLAUDE_DEMO_HOME="$DEMO_ROOT/claude-home"
OPENCODE_DEMO_HOME="$DEMO_ROOT/opencode-home"
CURSOR_HOOKS="$DEMO_ROOT/cursor/hooks.json"
CRUSH_CONFIG="$DEMO_ROOT/crush/.crush.json"
WORKTRUNK_CONFIG="$DEMO_ROOT/worktrunk/config.toml"
STN="${STATION_DEMO_STN:-$ROOT/bin/stn}"
HOOK_BIN="$ROOT/bin/stn-ingress"
HOST_ENTRY="$ROOT/station/src/host/hostMain.ts"
HOST_SOCKET="$STATE/run/station-host.sock"

CLAUDE_CMD="${STATION_CLAUDE_BIN:-claude}"
CODEX_CMD="${STATION_CODEX_BIN:-codex}"
CURSOR_CMD="${STATION_CURSOR_AGENT_BIN:-agent}"
CRUSH_CMD="${STATION_CRUSH_BIN:-crush}"
OPENCODE_CMD="${STATION_OPENCODE_BIN:-opencode}"
PI_CMD="${STATION_PI_BIN:-pi}"

step() { printf '\n==> %s\n' "$1"; }

have_tool() {
  command -v "$1" >/dev/null 2>&1
}

stn_demo() {
  PATH="$ROOT/bin:$PATH" \
    CODEX_HOME="$CODEX_DEMO_HOME" \
    CLAUDE_CONFIG_DIR="$CLAUDE_DEMO_HOME" \
    OPENCODE_CONFIG_DIR="$OPENCODE_DEMO_HOME" \
    STATION_CONFIG_PATH="$CONFIG" \
    STATION_OBSERVER_SOCKET_PATH="$STATE/observer.sock" \
    STATION_HOST_ENTRY="$HOST_ENTRY" \
    STATION_HOST_SOCKET_PATH="$HOST_SOCKET" \
    "$STN" --config "$CONFIG" "$@"
}

step "Checking demo dependencies"
missing=()
for tool in git wt tmux diffnav delta; do
  have_tool "$tool" || missing+=("$tool")
done
[ -x "$STN" ] || missing+=("$STN (run: pnpm build)")
[ -x "$HOOK_BIN" ] || missing+=("$HOOK_BIN (run: pnpm build)")
harness_missing=()
for tool in "$CLAUDE_CMD" "$CODEX_CMD" "$OPENCODE_CMD" "$PI_CMD" "$CURSOR_CMD" "$CRUSH_CMD"; do
  have_tool "$tool" || harness_missing+=("$tool")
done
[ "${#missing[@]}" -eq 0 ] && echo "  core tools: ok" || echo "  MISSING core tools: ${missing[*]}  (run: brew bundle --file Brewfile)"
[ "${#harness_missing[@]}" -eq 0 ] && echo "  harnesses: claude, codex, opencode, pi, cursor, crush present" || echo "  harnesses not found: ${harness_missing[*]}  (the staged assignments need those CLIs installed + logged in)"

step "Resetting demo root: $DEMO_ROOT"
if [ -f "$CONFIG" ] && [ -x "$STN" ]; then
  stn_demo observer stop >/dev/null 2>&1 || true
fi
tmux kill-session -t stationdemo >/dev/null 2>&1 || true
rm -rf "$DEMO_ROOT"
mkdir -p "$REPOS" "$WORKTREES" "$STATE"

clone_showcase_repo() {
  local name="$1" url="$2" branch="$3"
  local dir="$REPOS/$name"
  git clone --quiet --depth 1 --filter=blob:none --sparse --branch "$branch" "$url" "$dir"
  (
    cd "$dir"
    git config user.email "demo@station.local"
    git config user.name "Station Demo"
    # Keep the public source visible without letting demo snapshots poll GitHub.
    git remote add upstream "$url"
    git remote set-url origin "file://$dir"
  )
  echo "  $dir (shallow sparse clone of $url, branch $branch)"
}

add_worktree_from_repo() {
  local repo_dir="$1" worktree_group="$2" branch="$3" base="$4" demo_file="$5" note="$6" label="$7"
  local slug="${branch//\//-}"
  local path="$WORKTREES/$worktree_group/$slug"
  mkdir -p "$(dirname "$path")"
  git -C "$repo_dir" worktree add --quiet -b "$branch" "$path" "$base"
  (
    cd "$path"
    if [ -f "$demo_file" ]; then
      cat >>"$demo_file" <<DEMO

<!-- STATION demo: $note -->
DEMO
    fi
    cat >STATION_DEMO_NOTES.md <<DEMO
# STATION demo notes

$note
DEMO
  )
  echo "  $path ($label:$branch)"
}

add_showcase_worktree() {
  local repo="$1" branch="$2" base="$3" demo_file="$4" note="$5"
  add_worktree_from_repo "$REPOS/$repo" "$repo" "$branch" "$base" "$demo_file" "$note" "$repo"
}

# A git repo with main committed, then a planted uncommitted diff + untracked
# file so the default "See diff" automation has something to render, plus an
# executable check.sh for the "split a pane to run a command" flow.
seed_repo() {
  local name="$1" file="$2" original="$3" edited="$4" untracked_name="$5" untracked_body="$6"
  local dir="$REPOS/$name"
  mkdir -p "$dir"
  (
    cd "$dir"
    git init -q -b main
    git config user.email "demo@station.local"
    git config user.name "Station Demo"
    printf '%s\n' "$original" >"$file"
    cat >check.sh <<'CHECK'
#!/usr/bin/env bash
set -e
echo "running checks…"
node -e "const isEven=require('./is-even.js'); console.log('is-even(4)=', isEven(4), '| is-even(7)=', isEven(7));" 2>/dev/null || true
echo "ok ✓"
CHECK
    chmod +x check.sh
    printf '# %s\n\nDemo project for Station.\n' "$name" >README.md
    git add -A
    git commit -q -m "init $name"
    # Plant the working-tree diff (shown by See diff) — keep it small + readable.
    printf '%s\n' "$edited" >"$file"
    printf '%s\n' "$untracked_body" >"$untracked_name"
  )
  echo "  $dir (planted diff in $file + untracked $untracked_name)"
}

append_project_config() {
  local id="$1" label="$2" root="$3" default_branch="$4" harness="$5"
  cat >>"$CONFIG" <<TOML

[[projects]]
id = "$id"
label = "$label"
root = "$root"
default_branch = "$default_branch"

[projects.defaults]
harness = "$harness"
terminal = "tmux"
layout = "agent-shell"
TOML
}

t3_project_path() {
  case "$1" in
    web) printf 'apps/web' ;;
    api) printf 'apps/api' ;;
    auth) printf 'packages/auth' ;;
    db) printf 'packages/db' ;;
    billing) printf 'packages/billing' ;;
    ai) printf 'packages/ai' ;;
    mobile) printf 'apps/mobile' ;;
    admin) printf 'apps/admin' ;;
    worker) printf 'packages/worker' ;;
    docs) printf 'apps/docs' ;;
    *) return 1 ;;
  esac
}

seed_t3_project_files() {
  local name="$1" harness="$2" title="$3"
  local dir="$REPOS/t3-code/$(t3_project_path "$name")"
  mkdir -p "$dir/scripts" "$dir/src"
  cat >"$dir/package.json" <<JSON
{"name":"@t3-code/$name","private":true,"type":"module","scripts":{"check":"node scripts/check.mjs"}}
JSON
  cat >"$dir/scripts/check.mjs" <<CHECK
console.log("checking @t3-code/$name");
console.log("default harness: $harness");
CHECK
  cat >"$dir/src/index.ts" <<TS
export const service = "$name";
export const defaultHarness = "$harness";

export function describe() {
  return "$title";
}
TS
  printf '# t3-code/%s\n\n%s\n' "$name" "$title" >"$dir/README.md"
}

seed_t3_repo() {
  local dir="$REPOS/t3-code"
  mkdir -p "$dir"
  (
    cd "$dir"
    git init -q -b main
    git config user.email "demo@station.local"
    git config user.name "Station Demo"
    cat >package.json <<'JSON'
{"name":"t3-code","private":true,"type":"module","workspaces":["apps/*","packages/*"]}
JSON
    cat >pnpm-workspace.yaml <<'YAML'
packages:
  - "apps/*"
  - "packages/*"
YAML
    printf '# t3-code\n\nDemo monorepo with app and package projects.\n' >README.md
  )
  seed_t3_project_files "web" "claude" "Next.js app shell for the T3 code workspace."
  seed_t3_project_files "api" "codex" "Typed RPC API boundary for the T3 code workspace."
  seed_t3_project_files "auth" "opencode" "OAuth and session handling for the T3 code workspace."
  seed_t3_project_files "db" "pi" "Drizzle schema and migration package for the T3 code workspace."
  seed_t3_project_files "billing" "claude" "Stripe usage metering service for the T3 code workspace."
  seed_t3_project_files "ai" "codex" "AI interaction package for the T3 code workspace."
  seed_t3_project_files "mobile" "opencode" "Mobile companion app for the T3 code workspace."
  seed_t3_project_files "admin" "pi" "Admin console for the T3 code workspace."
  seed_t3_project_files "worker" "cursor" "Background worker package for the T3 code workspace."
  seed_t3_project_files "docs" "cursor" "Documentation site for the T3 code workspace."
  (
    cd "$dir"
    git add -A
    git commit -q -m "init t3-code monorepo"
  )
}

add_t3_worktree() {
  local name="$1" harness="$2" branch="$3" note="$4"
  local subdir
  subdir="$(t3_project_path "$name")"
  add_worktree_from_repo "$REPOS/t3-code" "t3-code" "$branch" "main" "$subdir/README.md" "$note" "t3-code"
}

step "Cloning showcase repos under $REPOS"
clone_showcase_repo "linux" "https://github.com/torvalds/linux.git" "master"
clone_showcase_repo "ghostty" "https://github.com/ghostty-org/ghostty.git" "main"
clone_showcase_repo "svelte" "https://github.com/sveltejs/svelte.git" "main"
clone_showcase_repo "is-even" "https://github.com/jonschlinkert/is-even.git" "master"

step "Creating showcase worktrees under $WORKTREES"
add_showcase_worktree "linux" "sched/eevdf-latency" "master" "README" "Experiment with scheduler latency accounting for interactive workloads."
add_showcase_worktree "linux" "fix/cifs-null-deref" "master" "README" "Tighten CIFS mount teardown around a nullable server response."
add_showcase_worktree "linux" "mm/folio-reclaim-trace" "master" "README" "Trace folio reclaim pressure around interactive filesystem workloads."
add_showcase_worktree "ghostty" "feat/kitty-graphics" "main" "README.md" "Prototype broader kitty graphics protocol coverage in the renderer."
add_showcase_worktree "ghostty" "perf/glyph-atlas-cache" "main" "README.md" "Tune glyph atlas cache reuse for dense terminal redraws."
add_showcase_worktree "svelte" "compiler/ssr-hydration" "main" "README.md" "Exercise SSR hydration mismatch diagnostics in the compiler."
add_showcase_worktree "is-even" "perf/constant-time-evenness" "master" "README.md" "Replace iterative evenness checks with a constant-time implementation note."

step "Creating t3-code monorepo under $REPOS/t3-code"
seed_t3_repo
add_t3_worktree "web" "claude" "feat-server-actions" "Wire server actions through the dashboard entry flow."
add_t3_worktree "api" "codex" "perf-router-cache" "Tune router-level caching for repeated list queries."
add_t3_worktree "auth" "opencode" "fix-oauth-refresh" "Patch token refresh behavior after provider reconnects."
add_t3_worktree "db" "pi" "chore-drizzle-indexes" "Add indexes around the newest activity queries."
add_t3_worktree "billing" "claude" "feat-usage-metering" "Prototype usage rollups for metered workspaces."
add_t3_worktree "ai" "codex" "experiment-streaming-ui" "Exercise streaming response state across route transitions."
add_t3_worktree "mobile" "opencode" "feat-offline-sync" "Stage offline sync recovery for background edits."
add_t3_worktree "admin" "pi" "polish-audit-log" "Improve audit-log scanability for support workflows."
add_t3_worktree "docs" "cursor" "a11y/playbook-refresh" "Refresh onboarding playbooks around environment setup."
add_t3_worktree "worker" "cursor" "async/queue-retry-backoff" "Harden queue retry backoff for flaky webhook deliveries."

step "Creating add-project repo under $REPOS"
# web: intentionally NOT added to the config, so you can demo "Add project".
seed_repo "web" "is-even.js" \
  "module.exports = function isEven(n) { return !(n & 1); };" \
  "module.exports = function isEven(n) { return n % 2 === 0; };" \
  "TODO.md" "# TODO
- [ ] wire up the dashboard
- [ ] dark mode"
echo "  note: 'web' is staged but left OUT of the config — use it for the Add-Project demo."

step "Writing isolated config: $CONFIG"
cat >"$CONFIG" <<TOML
schema_version = 1

[observer]
auto_start = true
socket_path = "$STATE/observer.sock"
state_dir = "$STATE"

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-shell"
default_branch = "main"
harness_permission_mode = "yolo"

[feature_flags]
station_persistent_agents = true

[worktree.worktrunk]
command = "wt"
config_path = "$WORKTRUNK_CONFIG"
managed_root = "$WORKTREES"
base = "main"
include_main = false
include_external = false
use_lifecycle_hooks = true

[terminal.tmux]
session_prefix = "stationdemo"
topology = "workbench"
workbench_session = "stationdemo"

[harness.claude]
enabled = true
command = "$CLAUDE_CMD"
install_hooks = true

[harness.codex]
enabled = true
command = "$CODEX_CMD"
install_hooks = true

[harness.opencode]
enabled = true
command = "$OPENCODE_CMD"
install_hooks = true

[harness.pi]
enabled = true
command = "$PI_CMD"

[harness.cursor]
enabled = true
command = "$CURSOR_CMD"
install_hooks = true

[harness.crush]
enabled = true
command = "$CRUSH_CMD"
install_hooks = true

[[projects]]
id = "linux"
label = "linux"
root = "$REPOS/linux"
default_branch = "master"

[projects.defaults]
harness = "claude"
terminal = "tmux"
layout = "agent-shell"

[[projects]]
id = "ghostty"
label = "ghostty"
root = "$REPOS/ghostty"
default_branch = "main"

[projects.defaults]
harness = "codex"
terminal = "tmux"
layout = "agent-shell"

[[projects]]
id = "svelte"
label = "svelte"
root = "$REPOS/svelte"
default_branch = "main"

[projects.defaults]
harness = "opencode"
terminal = "tmux"
layout = "agent-shell"

[[projects]]
id = "is-even"
label = "is-even"
root = "$REPOS/is-even"
default_branch = "master"

[projects.defaults]
harness = "pi"
terminal = "tmux"
layout = "agent-shell"

[projects.commands]
test = "npm test"
TOML

append_project_config "t3-code" "t3-code" "$REPOS/t3-code" "main" "codex"
cat >>"$CONFIG" <<'TOML'

[[projects.worktree_launches]]
branch = "a11y/playbook-refresh"
harness = "cursor"

[[projects.worktree_launches]]
branch = "async/queue-retry-backoff"
harness = "cursor"

[[projects.worktree_launches]]
branch = "feat-server-actions"
harness = "claude"

[[projects.worktree_launches]]
branch = "perf-router-cache"
harness = "codex"

[[projects.worktree_launches]]
branch = "fix-oauth-refresh"
harness = "opencode"

[[projects.worktree_launches]]
branch = "chore-drizzle-indexes"
harness = "pi"

[[projects.worktree_launches]]
branch = "feat-usage-metering"
harness = "claude"

[[projects.worktree_launches]]
branch = "experiment-streaming-ui"
harness = "codex"

[[projects.worktree_launches]]
branch = "feat-offline-sync"
harness = "opencode"

[[projects.worktree_launches]]
branch = "polish-audit-log"
harness = "pi"
TOML

step "Preparing isolated provider homes"
mkdir -p "$CODEX_DEMO_HOME" "$CLAUDE_DEMO_HOME" "$OPENCODE_DEMO_HOME"
[ -e "$HOME/.codex/auth.json" ] && ln -sf "$HOME/.codex/auth.json" "$CODEX_DEMO_HOME/auth.json"
[ -e "$HOME/.codex/config.toml" ] && cp "$HOME/.codex/config.toml" "$CODEX_DEMO_HOME/config.toml"

cat >"$RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="$ROOT/bin:\$PATH"
export CODEX_HOME="$CODEX_DEMO_HOME"
export CLAUDE_CONFIG_DIR="$CLAUDE_DEMO_HOME"
export OPENCODE_CONFIG_DIR="$OPENCODE_DEMO_HOME"
export STATION_CONFIG_PATH="$CONFIG"
export STATION_OBSERVER_SOCKET_PATH="$STATE/observer.sock"
export STATION_HOST_ENTRY="$HOST_ENTRY"
export STATION_HOST_SOCKET_PATH="$HOST_SOCKET"
exec "$STN" --config "$CONFIG" "\$@"
EOF
chmod +x "$RUNNER"

record_hook() {
  printf '%s\n' "$1" >>"$HOOKS_REPORT"
}

step "Installing local provider hooks"
: >"$HOOKS_REPORT"
if have_tool wt; then
  stn_demo hooks install worktrunk --yes --worktrunk-config "$WORKTRUNK_CONFIG" >/dev/null
  record_hook "worktrunk: $WORKTRUNK_CONFIG"
fi
if have_tool "$CLAUDE_CMD"; then
  stn_demo hooks install claude --yes >/dev/null
  record_hook "claude: $STATE/hooks/station-claude-settings.json, $CLAUDE_DEMO_HOME/settings.json"
fi
if have_tool "$CODEX_CMD"; then
  stn_demo hooks install codex --yes >/dev/null
  record_hook "codex: $CODEX_DEMO_HOME/station.config.toml"
fi
if have_tool "$CURSOR_CMD"; then
  stn_demo hooks install cursor --yes --cursor-hooks "$CURSOR_HOOKS" >/dev/null
  record_hook "cursor: $CURSOR_HOOKS"
fi
if have_tool "$CRUSH_CMD"; then
  stn_demo hooks install crush --yes --crush-config "$CRUSH_CONFIG" >/dev/null
  record_hook "crush: $CRUSH_CONFIG"
fi
if have_tool "$OPENCODE_CMD"; then
  stn_demo hooks install opencode --yes --opencode-config-dir "$OPENCODE_DEMO_HOME" >/dev/null
  record_hook "opencode: $OPENCODE_DEMO_HOME/plugins/station-agent-state.js"
fi
sed 's/^/  /' "$HOOKS_REPORT"

step "Starting isolated observer"
stn_demo observer start >/dev/null
stn_demo snapshot --json >/dev/null

cat <<EOF

────────────────────────────────────────
Demo staged under $DEMO_ROOT

Launch (isolated — does not touch your real config/state):
  "$RUNNER"

In the dashboard:
  • linux, ghostty, svelte, and is-even are real shallow sparse clones
  • showcase worktrees are staged under $WORKTREES with plausible branch names and planted diffs
  • staged harness defaults: linux=claude (3), ghostty=codex (2), svelte=opencode (1), is-even=pi (1)
  • t3-code is one local monorepo with 10 branch worktrees and mixed branch launch defaults (no crush)
  • 'web' is on disk at $REPOS/web — add it live with the Add-Project flow

Local provider hook files:
  $HOOKS_REPORT

Reset everything:
  scripts/demo/reset.sh
EOF
