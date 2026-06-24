#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
entry="$repo_root/apps/cli/dist/main.js"
args=(setup system)
has_mode=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      args+=(--check)
      has_mode=1
      ;;
    --yes|-y)
      args+=(--yes)
      has_mode=1
      ;;
    --no-brew)
      args+=(--no-brew)
      ;;
    -h|--help)
      "$repo_root/bin/stn" setup system --help
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      "$repo_root/bin/stn" setup system --help >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$has_mode" -eq 0 ]]; then
  args+=(--yes)
fi

if [[ ! -f "$entry" ]]; then
  echo "stn has not been built. Run: pnpm build" >&2
  exit 1
fi

exec "$repo_root/bin/stn" "${args[@]}"
