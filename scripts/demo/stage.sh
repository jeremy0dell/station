#!/usr/bin/env bash
# Stage a self-contained Station demo for screenshots / recordings.
#
# Creates example repos with a planted diff + a runnable task, writes an
# ISOLATED observer config, and checks demo dependencies. Everything lives under
# $STATION_DEMO_ROOT (default ~/.station-demo) and never touches your real
# ~/.config/station or ~/.local/state/station. Launch with:
#
#   stn --config "$STATION_DEMO_ROOT/config.toml"
#
# Tear it all down with scripts/demo/reset.sh.
set -euo pipefail

DEMO_ROOT="${STATION_DEMO_ROOT:-$HOME/.station-demo}"
REPOS="$DEMO_ROOT/repos"
WORKTREES="$DEMO_ROOT/worktrees"
STATE="$DEMO_ROOT/state"
CONFIG="$DEMO_ROOT/config.toml"

step() { printf '\n==> %s\n' "$1"; }

step "Checking demo dependencies"
missing=()
for tool in stn git wt tmux diffnav delta; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
harness_missing=()
for tool in claude codex; do
  command -v "$tool" >/dev/null 2>&1 || harness_missing+=("$tool")
done
[ "${#missing[@]}" -eq 0 ] && echo "  core tools: ok" || echo "  MISSING core tools: ${missing[*]}  (run: brew bundle --file Brewfile)"
[ "${#harness_missing[@]}" -eq 0 ] && echo "  harnesses: claude, codex present" || echo "  harnesses not found: ${harness_missing[*]}  (the new-session flow needs at least one installed + logged in)"

step "Resetting demo root: $DEMO_ROOT"
rm -rf "$DEMO_ROOT"
mkdir -p "$REPOS" "$WORKTREES" "$STATE"

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

step "Creating example repos under $REPOS"
# is-even: configured below, and on-brand with the mock showcase. The diff is the
# joke — an O(n) loop collapsing to a one-liner.
seed_repo "is-even" "is-even.js" \
  "module.exports = function isEven(n) {
  // O(n): toggle a flag n times. do not ship this.
  let even = true;
  for (let i = 0; i < Math.abs(n); i++) even = !even;
  return even;
};" \
  "module.exports = function isEven(n) {
  // O(1).
  return n % 2 === 0;
};" \
  "BENCHMARK.md" "# Benchmark

Before: O(n) — ~3 evens/sec at n=1e9.
After:  O(1) — yes."

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

[worktree.worktrunk]
command = "wt"
managed_root = "$WORKTREES"
base = "main"
include_main = true
include_external = false
use_lifecycle_hooks = false

[terminal.tmux]
session_prefix = "stationdemo"
topology = "workbench"
workbench_session = "stationdemo"

[harness.claude]
enabled = true
command = "claude"
install_hooks = true

[harness.codex]
enabled = true
command = "codex"
install_hooks = true

[[projects]]
id = "is-even"
label = "is-even"
root = "$REPOS/is-even"

[projects.commands]
test = "./check.sh"
TOML

cat <<EOF

────────────────────────────────────────
Demo staged under $DEMO_ROOT

Launch (isolated — does not touch your real config/state):
  stn --config "$CONFIG"

In the dashboard:
  • is-even shows its main worktree with a planted diff
  • 'web' is on disk at $REPOS/web — add it live with the Add-Project flow

Hooks for live agent status (optional, needs logged-in harnesses):
  stn --config "$CONFIG" hooks install claude
  stn --config "$CONFIG" hooks install codex

Reset everything:
  scripts/demo/reset.sh
EOF
