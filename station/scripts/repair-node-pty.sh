#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
helpers=("${root}"/node_modules/.bun/node-pty@*/node_modules/node-pty/prebuilds/*/spawn-helper)
found=0

for helper in "${helpers[@]}"; do
  if [[ -f "${helper}" ]]; then
    chmod +x "${helper}"
    found=1
  fi
done

if [[ "${found}" -eq 0 ]]; then
  echo "node-pty spawn-helper was not found. Run bun install first." >&2
  exit 1
fi
