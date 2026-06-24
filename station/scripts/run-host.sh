#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

"${root}/scripts/doctor.sh"

cd "${root}"
bun install --frozen-lockfile
exec bun run "${script}"
