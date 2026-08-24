#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${root}/.." && pwd)"

node_bin="${STATION_NODE:-node}"
if ! command -v "${node_bin}" >/dev/null 2>&1; then
  cat >&2 <<EOF
Node is not available on PATH as ${node_bin}.

Station host mode uses Node for the CLI and node-pty bridge. Install Node, set
STATION_NODE, or use the isolated container lane:

  ${root}/scripts/run-container.sh
EOF
  exit 1
fi

expected_bun="$("${node_bin}" "${repo_root}/scripts/bun-version.mjs" --print)"

if ! command -v bun >/dev/null 2>&1; then
  cat >&2 <<EOF
Bun is not available on PATH.

Station host mode requires Bun ${expected_bun}, but this script will not install
it for you. Use the container lane instead:

  ${root}/scripts/run-container.sh
EOF
  exit 1
fi

if ! "${node_bin}" "${repo_root}/scripts/bun-version.mjs" --check; then
  actual_bun="$(bun --version)"
  cat >&2 <<EOF
Bun ${actual_bun} is active, but Station host mode expects Bun ${expected_bun}.

Switch Bun deliberately, or use the isolated container lane:

  ${root}/scripts/run-container.sh
EOF
  exit 1
fi

if [[ ! -f "${repo_root}/bun.lock" ]]; then
  cat >&2 <<EOF
${repo_root}/bun.lock is missing.

Create it from the repository root with:

  cd ${repo_root}
  bun install
EOF
  exit 1
fi

if ! "${node_bin}" "${repo_root}/scripts/build-identity.mjs" --check; then
  cat >&2 <<EOF
Station consumes verified root-workspace build output. Refresh it first:

  cd ${repo_root}
  bun install --frozen-lockfile
  bun run build
EOF
  exit 1
fi

if [[ ! -e "${root}/node_modules/@opentui/core/package.json" ]]; then
  cat >&2 <<EOF
${root}/node_modules is missing the Station renderer workspace graph.

Install the unified workspace at the repository root first:

  cd ${repo_root}
  bun install --frozen-lockfile
EOF
  exit 1
fi

cat <<EOF
Station experiment checks passed.

Run on host:
  ${root}/scripts/run-host.sh

Run in container:
  ${root}/scripts/run-container.sh
EOF
