#!/usr/bin/env bash
# One-command setup for a fresh Station checkout (macOS).
# Installs system dependencies via Homebrew, builds the workspace, and links the launchers.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

step() { printf '\n==> %s\n' "$1"; }

# The Command Line Tools provide git and the compilers Homebrew itself needs, so a
# bare Mac dead-ends at the brew step without them. Check first and give the real
# remediation instead of a confusing "git/brew not found" later.
step "Checking Xcode Command Line Tools"
if ! xcode-select -p >/dev/null 2>&1; then
  echo "Command Line Tools are not installed. Run: xcode-select --install" >&2
  echo "Re-run this script once they finish installing." >&2
  exit 1
fi

step "Checking git"
if ! command -v git >/dev/null 2>&1; then
  echo "git is not installed. Run: xcode-select --install (or install git), then re-run." >&2
  exit 1
fi

step "Checking Homebrew"
# The official installer writes brew to its prefix but does not touch the current
# shell PATH, so a same-session re-run would otherwise dead-end here despite a
# successful install. Pick it up from the standard prefixes first.
if ! command -v brew >/dev/null 2>&1; then
  for brew_bin in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$brew_bin" ] && eval "$("$brew_bin" shellenv)" && break
  done
fi
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required. Install it from https://brew.sh and re-run this script." >&2
  exit 1
fi

step "Installing system dependencies (brew bundle)"
brew bundle --file="$repo_root/Brewfile"

# node@24 is keg-only (Homebrew does not symlink it onto PATH); use it explicitly
# for the build, and tell the user how to keep it on PATH for bare `stn`.
node24_bin=""
if prefix="$(brew --prefix node@24 2>/dev/null)" && [ -x "$prefix/bin/node" ]; then
  node24_bin="$prefix/bin"
  export PATH="$node24_bin:$PATH"
fi

required_bun_version="$(node "$repo_root/scripts/bun-version.mjs" --print)"
# Homebrew provides the bootstrap executable; repository work always runs under
# the exact packageManager version even after Homebrew's formula advances.
bun_runtime=(bun x "bun@$required_bun_version")
active_bun_version="$("${bun_runtime[@]}" --version)"
if [[ "$active_bun_version" != "$required_bun_version" ]]; then
  echo "Could not activate repository Bun $required_bun_version (found $active_bun_version)." >&2
  exit 1
fi

step "Runtime versions"
echo "  node $(node --version 2>/dev/null || echo 'MISSING')"
echo "  bun  $active_bun_version (repository exact)"

step "Installing workspace dependencies"
"${bun_runtime[@]}" install

step "Building"
"${bun_runtime[@]}" run build

# node-pty is installed from the root graph, but its local native helper still
# needs the existing repair pass before the source Host can use it.
step "Repairing the Station native helper"
(
  cd "$repo_root/station"
  "${bun_runtime[@]}" run repair:node-pty
)

step "Linking STATION launchers onto your PATH"
"${bun_runtime[@]}" run station:link

cat <<'EOF'

────────────────────────────────────────
Station is installed.

Next:
  stn setup     # required tools, an agent CLI, and a zero-project config
  stn           # launch the workspace
EOF

if [ -n "$node24_bin" ]; then
  cat <<EOF

Note: Homebrew's node@24 is keg-only. So that bare \`stn\` finds Node in new shells, add:
  echo 'export PATH="$node24_bin:\$PATH"' >> ~/.zshrc
(or run \`bun run stn -- ...\` from this checkout, which already resolves it.)
EOF
fi
