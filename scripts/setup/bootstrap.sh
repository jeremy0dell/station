#!/usr/bin/env bash
# One-command setup for a fresh Station checkout (macOS).
# Installs system dependencies via Homebrew, builds the workspace, and links `stn`.
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

step "Runtime versions"
echo "  node $(node --version 2>/dev/null || echo 'MISSING')"
echo "  bun  $(bun --version 2>/dev/null || echo 'MISSING')"

step "Activating pnpm (corepack, pinned by packageManager)"
corepack enable >/dev/null 2>&1 || true

step "Installing workspace dependencies"
pnpm install

step "Building"
pnpm build

step "Linking 'stn' onto your PATH"
pnpm link --global

cat <<'EOF'

────────────────────────────────────────
Station is installed.

Next:
  stn setup     # required tools, an agent CLI, and your first project
  stn           # launch the workspace
EOF

if [ -n "$node24_bin" ]; then
  cat <<EOF

Note: Homebrew's node@24 is keg-only. So that bare \`stn\` finds Node in new shells, add:
  echo 'export PATH="$node24_bin:\$PATH"' >> ~/.zshrc
(or run \`pnpm stn ...\` from this checkout, which already resolves it.)
EOF
fi
