#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
expected_bun="1.3.14"

if ! command -v bun >/dev/null 2>&1; then
  cat >&2 <<EOF
Bun is not available on PATH.

Station host mode requires Bun ${expected_bun}, but this script will not install
it for you. Use the container lane instead:

  ${root}/scripts/run-container.sh
EOF
  exit 1
fi

actual_bun="$(bun --version)"
if [[ "${actual_bun}" != "${expected_bun}" ]]; then
  cat >&2 <<EOF
Bun ${actual_bun} is active, but Station host mode expects Bun ${expected_bun}.

Switch Bun deliberately, or use the isolated container lane:

  ${root}/scripts/run-container.sh
EOF
  exit 1
fi

node_bin="${STATION_NODE:-node}"
if ! command -v "${node_bin}" >/dev/null 2>&1; then
  cat >&2 <<EOF
Node is not available on PATH as ${node_bin}.

Station host mode uses a Node sidecar for node-pty. Install Node, set
STATION_NODE, or use the isolated container lane:

  ${root}/scripts/run-container.sh
EOF
  exit 1
fi

if [[ ! -f "${root}/bun.lock" ]]; then
  cat >&2 <<EOF
${root}/bun.lock is missing.

Create it from inside the Station experiment with:

  cd ${root}
  bun install
EOF
  exit 1
fi

repo_root="$(cd "${root}/.." && pwd)"
# Station links the packages it imports directly and checks protocol because
# @station/client resolves it transitively through the repo's pnpm layout.
for package in client contracts dashboard-core protocol runtime; do
  if [[ ! -f "${repo_root}/packages/${package}/dist/index.js" ]]; then
    cat >&2 <<EOF
${repo_root}/packages/${package}/dist/index.js is missing.

Station consumes the built @station packages (client, contracts,
dashboard-core, protocol, runtime). Build them at the repo root first:

  cd ${repo_root}
  pnpm install
  pnpm build
EOF
    exit 1
  fi
done

if [[ ! -e "${repo_root}/packages/client/node_modules/@station/protocol" ]]; then
  cat >&2 <<EOF
${repo_root}/packages/client/node_modules is missing its workspace links.

Station resolves @station/client's dependencies through the repo's pnpm layout.
Install at the repo root first:

  cd ${repo_root}
  pnpm install
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
