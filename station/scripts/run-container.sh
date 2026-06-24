#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${root}/.." && pwd)"
image="station-station-experiment:local"
script="station"
source="${STATION_SOURCE:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hot)
      script="dev"
      shift
      ;;
    --mock)
      source="mock"
      shift
      ;;
    *)
      echo "Usage: $0 [--hot] [--mock]" >&2
      exit 2
      ;;
  esac
done

if [[ -n "${source}" ]]; then
  export STATION_SOURCE="${source}"
fi

if ! command -v docker >/dev/null 2>&1; then
  cat >&2 <<EOF
Docker is not available on PATH.

Install or start Docker deliberately, or use host mode after activating Bun 1.3.14:

  ${root}/scripts/run-host.sh
EOF
  exit 1
fi

docker build \
  -t "${image}" \
  -f "${root}/.devcontainer/Dockerfile" \
  "${root}"

# The whole repo is mounted (not just the Station tree) so the @station package
# links resolve against the host-built dists and the host pnpm node_modules.
docker run --rm -it \
  --mount "type=bind,src=${repo_root},dst=/workspace" \
  --mount "type=volume,src=station-station-node-modules,dst=/workspace/station/node_modules" \
  --mount "type=volume,src=station-station-bun-cache,dst=/home/bun/.bun/install/cache" \
  --workdir /workspace/station \
  -e TERM="${TERM:-xterm-256color}" \
  -e STATION_SOURCE="${STATION_SOURCE:-}" \
  "${image}" \
  sh -lc "bun install --frozen-lockfile && bun run ${script}"
