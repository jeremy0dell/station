#!/usr/bin/env bash
# Stage the isolated multi-repository Station demo used for screenshots and tours.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
DEMO_ROOT="$(canonicalize_demo_root "${STATION_DEMO_ROOT:-$HOME/.station-demo}")"
REPOS="$DEMO_ROOT/repos"
WORKTREES="$DEMO_ROOT/worktrees"
STATE="$DEMO_ROOT/state"
CONFIG="$DEMO_ROOT/config.toml"
RUNNER="$DEMO_ROOT/run.sh"
HOOKS_REPORT="$DEMO_ROOT/hooks.txt"
WORKTRUNK_CONFIG="$DEMO_ROOT/worktrunk/config.toml"
CODEX_DEMO_HOME="$DEMO_ROOT/codex-home"
CLAUDE_DEMO_HOME="$DEMO_ROOT/claude-home"
CURSOR_DEMO_HOME="$DEMO_ROOT/cursor-home"
OPENCODE_DEMO_HOME="$DEMO_ROOT/opencode-home"
STN="${STATION_DEMO_STN:-$ROOT/bin/stn}"
HOOK_BIN="${STATION_DEMO_HOOK_BIN:-$ROOT/bin/stn-ingress}"

CLAUDE_CMD="${STATION_CLAUDE_BIN:-claude}"
CODEX_CMD="${STATION_CODEX_BIN:-codex}"
CURSOR_CMD="${STATION_CURSOR_AGENT_BIN:-agent}"
OPENCODE_CMD="${STATION_OPENCODE_BIN:-opencode}"
PI_CMD="${STATION_PI_BIN:-pi}"

require_toml_safe_value "Demo root" "$DEMO_ROOT"
require_toml_safe_value "Claude command" "$CLAUDE_CMD"
require_toml_safe_value "Codex command" "$CODEX_CMD"
require_toml_safe_value "Cursor command" "$CURSOR_CMD"
require_toml_safe_value "OpenCode command" "$OPENCODE_CMD"
require_toml_safe_value "Pi command" "$PI_CMD"

step() { printf '\n==> %s\n' "$1"; }

have_tool() {
  command -v "$1" >/dev/null 2>&1
}

stn_demo() {
  PATH="$ROOT/bin:$PATH" \
    STATION_CONFIG_PATH="$CONFIG" \
    STATION_OBSERVER_SOCKET_PATH="$STATE/run/observer.sock" \
    STATION_LAYOUT_PATH="$STATE/station/layout.json" \
    CODEX_HOME="$CODEX_DEMO_HOME" \
    CLAUDE_CONFIG_DIR="$CLAUDE_DEMO_HOME" \
    STATION_CURSOR_HOME="$CURSOR_DEMO_HOME" \
    OPENCODE_CONFIG_DIR="$OPENCODE_DEMO_HOME" \
    "$STN" --config "$CONFIG" "$@"
}

step "Checking demo dependencies"
missing=()
for tool in git node wt tmux diffnav delta lsof; do
  have_tool "$tool" || missing+=("$tool")
done
[ -x "$STN" ] || missing+=("$STN")
[ -x "$HOOK_BIN" ] || missing+=("$HOOK_BIN")
if [ -z "${STATION_DEMO_STN:-}" ]; then
  [ -f "$ROOT/apps/cli/dist/main.js" ] || missing+=("apps/cli/dist/main.js")
  [ -f "$ROOT/apps/cli/dist/ingressMain.js" ] || missing+=("apps/cli/dist/ingressMain.js")
  have_tool bun || missing+=("bun")
  [ -d "$ROOT/station/node_modules" ] || missing+=("station/node_modules")
fi
if [ "${#missing[@]}" -ne 0 ]; then
  printf 'Missing demo dependencies:\n' >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo "Run pnpm build, (cd station && bun install), and install the tools in Brewfile." >&2
  exit 1
fi
echo "  core tools: ok"

harness_missing=()
for tool in "$CLAUDE_CMD" "$CODEX_CMD" "$CURSOR_CMD" "$OPENCODE_CMD" "$PI_CMD"; do
  have_tool "$tool" || harness_missing+=("$tool")
done
if [ "${#harness_missing[@]}" -eq 0 ]; then
  echo "  harnesses: claude, codex, cursor, opencode, pi present"
else
  echo "  harnesses not found: ${harness_missing[*]}"
  echo "  staging will continue; install and sign in before launching those assignments"
fi

step "Resetting demo root: $DEMO_ROOT"
STATION_DEMO_ROOT="$DEMO_ROOT" STATION_DEMO_STN="$STN" "$SCRIPT_DIR/reset.sh" >/dev/null
mkdir -p "$REPOS" "$WORKTREES" "$STATE/run" "$STATE/station" "$(dirname "$WORKTRUNK_CONFIG")"
printf 'station-demo-v1\n' >"$DEMO_ROOT/.station-demo-root"

clone_showcase_repo() {
  local name="$1" url="$2" branch="$3" dir="$REPOS/$1"
  git clone --quiet --depth 1 --filter=blob:none --sparse --branch "$branch" "$url" "$dir"
  # This non-cone boundary keeps a/b/c/file while pruning a/b/c/d/file.
  git -C "$dir" sparse-checkout set --no-cone '/*' '!/*/*/*/*/'
  git -C "$dir" config user.email "demo@station.local"
  git -C "$dir" config user.name "Station Demo"
  # Keep the partial clone's promisor fetchable if a demo later expands the sparse boundary.
  git -C "$dir" remote set-url origin "$url"
  echo "  $dir (shallow clone through three directory levels, branch $branch)"
}

add_worktree_from_repo() {
  local repo_dir="$1" group="$2" branch="$3" base="$4" demo_file="$5" note="$6"
  local path="$WORKTREES/$group/${branch//\//-}"
  mkdir -p "$(dirname "$path")"
  git -C "$repo_dir" worktree add --quiet -b "$branch" "$path" "$base"
  if [ -f "$path/$demo_file" ]; then
    printf '\n<!-- Station demo: %s -->\n' "$note" >>"$path/$demo_file"
  fi
  printf '# Station demo notes\n\n%s\n' "$note" >"$path/STATION_DEMO_NOTES.md"
  echo "  $path ($branch)"
}

add_showcase_worktree() {
  local repo="$1" branch="$2" base="$3" demo_file="$4" note="$5"
  add_worktree_from_repo "$REPOS/$repo" "$repo" "$branch" "$base" "$demo_file" "$note"
}

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
node -e "const isEven=require('./is-even.js'); console.log('is-even(4)=', isEven(4), '| is-even(7)=', isEven(7));"
echo "ok ✓"
CHECK
    chmod +x check.sh
    printf '# %s\n\nDemo project for Station.\n' "$name" >README.md
    git add -A
    git commit -q -m "init $name"
    printf '%s\n' "$edited" >"$file"
    printf '%s\n' "$untracked_body" >"$untracked_name"
  )
  echo "  $dir (planted diff in $file and untracked $untracked_name)"
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
  local name="$1" harness="$2" title="$3" dir
  dir="$REPOS/t3-code/$(t3_project_path "$name")"
  mkdir -p "$dir/scripts" "$dir/src"
  printf '{"name":"@t3-code/%s","private":true,"type":"module","scripts":{"check":"node scripts/check.mjs"}}\n' "$name" >"$dir/package.json"
  printf 'console.log("checking @t3-code/%s");\nconsole.log("suggested harness: %s");\n' "$name" "$harness" >"$dir/scripts/check.mjs"
  cat >"$dir/src/index.ts" <<TS
export const service = "$name";
export const suggestedHarness = "$harness";

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
    printf '{"name":"t3-code","private":true,"type":"module","workspaces":["apps/*","packages/*"]}\n' >package.json
    printf 'packages:\n  - "apps/*"\n  - "packages/*"\n' >pnpm-workspace.yaml
    printf '# t3-code\n\nDemo monorepo with app and package projects.\n' >README.md
  )
  seed_t3_project_files web claude "Next.js app shell for the T3 code workspace."
  seed_t3_project_files api codex "Typed RPC API boundary for the T3 code workspace."
  seed_t3_project_files auth opencode "OAuth and session handling for the T3 code workspace."
  seed_t3_project_files db pi "Drizzle schema and migration package for the T3 code workspace."
  seed_t3_project_files billing claude "Stripe usage metering service for the T3 code workspace."
  seed_t3_project_files ai codex "AI interaction package for the T3 code workspace."
  seed_t3_project_files mobile opencode "Mobile companion app for the T3 code workspace."
  seed_t3_project_files admin pi "Admin console for the T3 code workspace."
  seed_t3_project_files worker cursor "Background worker package for the T3 code workspace."
  seed_t3_project_files docs cursor "Documentation site for the T3 code workspace."
  git -C "$dir" add -A
  git -C "$dir" commit -q -m "init t3-code monorepo"
}

add_t3_worktree() {
  local project="$1" branch="$2" note="$3" subdir
  subdir="$(t3_project_path "$project")"
  add_worktree_from_repo "$REPOS/t3-code" t3-code "$branch" main "$subdir/README.md" "$note"
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

[projects.worktrunk]
base = "$default_branch"
TOML
}

step "Cloning showcase repositories under $REPOS"
clone_showcase_repo linux https://github.com/torvalds/linux.git master
clone_showcase_repo ghostty https://github.com/ghostty-org/ghostty.git main
clone_showcase_repo svelte https://github.com/sveltejs/svelte.git main
clone_showcase_repo is-even https://github.com/jonschlinkert/is-even.git master

step "Creating seven showcase worktrees under $WORKTREES"
add_showcase_worktree linux sched/eevdf-latency master README "Experiment with scheduler latency accounting for interactive workloads."
add_showcase_worktree linux fix/cifs-null-deref master README "Tighten CIFS mount teardown around a nullable server response."
add_showcase_worktree linux mm/folio-reclaim-trace master README "Trace folio reclaim pressure around interactive filesystem workloads."
add_showcase_worktree ghostty feat/kitty-graphics main README.md "Prototype broader kitty graphics protocol coverage in the renderer."
add_showcase_worktree ghostty perf/glyph-atlas-cache main README.md "Tune glyph atlas cache reuse for dense terminal redraws."
add_showcase_worktree svelte compiler/ssr-hydration main README.md "Exercise SSR hydration mismatch diagnostics in the compiler."
add_showcase_worktree is-even perf/constant-time-evenness master README.md "Replace iterative evenness checks with a constant-time implementation note."

step "Creating t3-code and ten branch worktrees"
seed_t3_repo
add_t3_worktree web feat-server-actions "Wire server actions through the dashboard entry flow."
add_t3_worktree api perf-router-cache "Tune router-level caching for repeated list queries."
add_t3_worktree auth fix-oauth-refresh "Patch token refresh behavior after provider reconnects."
add_t3_worktree db chore-drizzle-indexes "Add indexes around the newest activity queries."
add_t3_worktree billing feat-usage-metering "Prototype usage rollups for metered workspaces."
add_t3_worktree ai experiment-streaming-ui "Exercise streaming response state across route transitions."
add_t3_worktree mobile feat-offline-sync "Stage offline sync recovery for background edits."
add_t3_worktree admin polish-audit-log "Improve audit-log scanability for support workflows."
add_t3_worktree docs a11y/playbook-refresh "Refresh onboarding playbooks around environment setup."
add_t3_worktree worker async/queue-retry-backoff "Harden queue retry backoff for flaky webhook deliveries."

step "Creating the add-project fixture under $REPOS/web"
seed_repo web is-even.js \
  "module.exports = function isEven(n) { return !(n & 1); };" \
  "module.exports = function isEven(n) { return n % 2 === 0; };" \
  TODO.md "# TODO
- [ ] wire up the dashboard
- [ ] dark mode"

step "Writing isolated Station config: $CONFIG"
cat >"$CONFIG" <<TOML
schema_version = 1

[observer]
auto_start = true
socket_path = "$STATE/run/observer.sock"
state_dir = "$STATE"

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-shell"
default_branch = "main"
harness_permission_mode = "standard"

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

[harness.cursor]
enabled = true
command = "$CURSOR_CMD"
install_hooks = true

[harness.opencode]
enabled = true
command = "$OPENCODE_CMD"
install_hooks = true

[harness.pi]
enabled = true
command = "$PI_CMD"

[repository.github]
enabled = false
TOML

append_project_config linux linux "$REPOS/linux" master claude
append_project_config ghostty ghostty "$REPOS/ghostty" main codex
append_project_config svelte svelte "$REPOS/svelte" main opencode
append_project_config is-even is-even "$REPOS/is-even" master pi
append_project_config t3-code t3-code "$REPOS/t3-code" main cursor

step "Preparing isolated provider homes"
mkdir -p "$CODEX_DEMO_HOME" "$CLAUDE_DEMO_HOME" "$CURSOR_DEMO_HOME" "$OPENCODE_DEMO_HOME"
[ -e "$HOME/.codex/auth.json" ] && ln -s "$HOME/.codex/auth.json" "$CODEX_DEMO_HOME/auth.json"
[ -e "$HOME/.codex/config.toml" ] && cp "$HOME/.codex/config.toml" "$CODEX_DEMO_HOME/config.toml"

seed_cursor_link() {
  [ -e "$1" ] || return 0
  mkdir -p "$(dirname "$2")"
  ln -s "$1" "$2"
}
seed_cursor_link "$HOME/.gitconfig" "$CURSOR_DEMO_HOME/.gitconfig"
seed_cursor_link "$HOME/.git-credentials" "$CURSOR_DEMO_HOME/.git-credentials"
seed_cursor_link "$HOME/.ssh" "$CURSOR_DEMO_HOME/.ssh"
seed_cursor_link "$HOME/.config/git" "$CURSOR_DEMO_HOME/.config/git"

printf -v path_bin '%q' "$ROOT/bin"
printf -v path_config '%q' "$CONFIG"
printf -v path_socket '%q' "$STATE/run/observer.sock"
printf -v path_layout '%q' "$STATE/station/layout.json"
printf -v path_codex '%q' "$CODEX_DEMO_HOME"
printf -v path_claude '%q' "$CLAUDE_DEMO_HOME"
printf -v path_cursor '%q' "$CURSOR_DEMO_HOME"
printf -v path_opencode '%q' "$OPENCODE_DEMO_HOME"
printf -v path_stn '%q' "$STN"
cat >"$RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH=$path_bin:\$PATH
export STATION_CONFIG_PATH=$path_config
export STATION_OBSERVER_SOCKET_PATH=$path_socket
export STATION_LAYOUT_PATH=$path_layout
export CODEX_HOME=$path_codex
export CLAUDE_CONFIG_DIR=$path_claude
export STATION_CURSOR_HOME=$path_cursor
export OPENCODE_CONFIG_DIR=$path_opencode
exec $path_stn --config $path_config tui "\$@"
EOF
chmod +x "$RUNNER"

install_hook() {
  local target="$1" command="$2"
  shift 2
  if ! have_tool "$command"; then
    printf '%s: skipped (%s not found)\n' "$target" "$command" >>"$HOOKS_REPORT"
    return 0
  fi
  if stn_demo hooks install "$target" --yes "$@" >>"$HOOKS_REPORT" 2>&1; then
    stn_demo hooks doctor "$target" "$@" >>"$HOOKS_REPORT" 2>&1 || true
    printf '%s: installed\n' "$target" >>"$HOOKS_REPORT"
  else
    printf '%s: install failed; see output above\n' "$target" >>"$HOOKS_REPORT"
  fi
}

install_required_hook() {
  local target="$1"
  shift
  if ! stn_demo hooks install "$target" --yes "$@" >>"$HOOKS_REPORT" 2>&1; then
    echo "Required $target hook installation failed; see $HOOKS_REPORT." >&2
    return 1
  fi
  if ! stn_demo hooks doctor "$target" "$@" >>"$HOOKS_REPORT" 2>&1; then
    echo "Required $target hook doctor failed; see $HOOKS_REPORT." >&2
    return 1
  fi
  printf '%s: installed and verified\n' "$target" >>"$HOOKS_REPORT"
}

step "Installing isolated provider hooks"
: >"$HOOKS_REPORT"
install_required_hook worktrunk --hook-bin "$HOOK_BIN" --worktrunk-config "$WORKTRUNK_CONFIG"
install_hook claude "$CLAUDE_CMD" --hook-bin "$HOOK_BIN"
install_hook codex "$CODEX_CMD" --hook-bin "$HOOK_BIN"
install_hook cursor "$CURSOR_CMD" --hook-bin "$HOOK_BIN"
# OpenCode generates a plugin and does not accept --hook-bin; Pi has no hooks CLI target.
install_hook opencode "$OPENCODE_CMD"
sed 's/^/  /' "$HOOKS_REPORT"

step "Starting isolated observer"
stn_demo observer start >/dev/null
stn_demo snapshot --json >/dev/null

cat <<EOF

────────────────────────────────────────
Demo staged under $DEMO_ROOT

Launch the full isolated workspace:
  "$RUNNER"

What is staged:
  • 5 projects and 17 branch worktrees
  • linux, ghostty, svelte, and is-even are shallow clones materialized through three directory levels
  • project defaults: linux=claude, ghostty=codex, svelte=opencode, is-even=pi, t3-code=cursor
  • rows remain agent-free until you open one; New Session can explicitly choose any configured harness
  • $REPOS/web is intentionally unconfigured for the Add Project flow

Hook report:
  $HOOKS_REPORT

Reset everything:
  scripts/demo/reset.sh
EOF
