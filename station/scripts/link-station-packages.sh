#!/usr/bin/env bash
set -euo pipefail

# Station needs symlinks to built @station packages so dependencies resolve through
# the repo's pnpm node_modules. Bun file/link modes do not preserve this isolated
# workspace graph; rerun after `bun install`, which prunes unknown entries.

station_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${station_root}/.." && pwd)"
target_dir="${station_root}/node_modules/@station"

linked_packages=(client config contracts dashboard-core runtime protocol observability station-host)

for package in "${linked_packages[@]}"; do
  dist_entry="${repo_root}/packages/${package}/dist/index.js"
  if [[ ! -f "${dist_entry}" ]]; then
    cat >&2 <<EOF
${dist_entry} is missing.

Station consumes the built @station/${package} package. Build the workspace
packages at the repo root first:

  cd ${repo_root}
  pnpm install
  pnpm build
EOF
    exit 1
  fi
done

mkdir -p "${target_dir}"
for package in "${linked_packages[@]}"; do
  # station-host publishes as @station/host (the redundant qualifier is dropped),
  # so the symlink name strips the leading station- while the source dir keeps it.
  link_name="${package#station-}"
  ln -sfn "../../../packages/${package}" "${target_dir}/${link_name}"
done

# Echo each linked dist's mtime so a stale build is visible at link time —
# the existence check above cannot tell yesterday's dist from today's.
freshness=""
for package in "${linked_packages[@]}"; do
  dist_entry="${repo_root}/packages/${package}/dist/index.js"
  mtime="$(date -r "${dist_entry}" "+%Y-%m-%d %H:%M" 2>/dev/null || stat -c "%y" "${dist_entry}" 2>/dev/null | cut -c1-16)"
  freshness="${freshness}${package}@${mtime}  "
done

if [[ "${STATION_QUIET_PRELAUNCH:-}" != "1" ]]; then
  echo "Linked @station packages (${linked_packages[*]}) into node_modules."
  echo "dist builds: ${freshness}"
fi
