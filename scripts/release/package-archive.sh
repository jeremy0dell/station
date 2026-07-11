#!/bin/sh

set -eu

if [ "$#" -ne 2 ]; then
  printf 'Usage: package-archive.sh <version> <target>\n' >&2
  exit 2
fi

version=$1
target=$2

case "$version" in
  ''|*[!0-9A-Za-z.+-]*)
    printf 'Invalid release version: %s\n' "$version" >&2
    exit 2
    ;;
esac

case "$target" in
  darwin-arm64|darwin-x64|linux-arm64|linux-x64) ;;
  *)
    printf 'Unsupported release target: %s\n' "$target" >&2
    exit 2
    ;;
esac

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
repo_root=$(CDPATH= cd "$script_dir/../.." && pwd -P)
bin_dir=$repo_root/station/dist/bin
archive=$repo_root/stn-v$version-$target.tar.gz

[ -x "$bin_dir/stn" ] && [ ! -L "$bin_dir/stn" ] || {
  printf 'Expected an executable Station binary at %s/stn.\n' "$bin_dir" >&2
  exit 1
}
[ "$(readlink "$bin_dir/stn-ingress" 2>/dev/null || true)" = stn ] || {
  printf 'Expected stn-ingress to be a symlink to stn.\n' >&2
  exit 1
}
[ "$(readlink "$bin_dir/stn-tmux-popup" 2>/dev/null || true)" = stn ] || {
  printf 'Expected stn-tmux-popup to be a symlink to stn.\n' >&2
  exit 1
}
[ -f "$bin_dir/LICENSE" ] && [ ! -L "$bin_dir/LICENSE" ] || {
  printf 'Expected a regular LICENSE file at %s/LICENSE.\n' "$bin_dir" >&2
  exit 1
}

tar -C "$bin_dir" -czf "$archive" stn stn-ingress stn-tmux-popup LICENSE
actual_manifest=$(tar -tzf "$archive")
expected_manifest=$(printf '%s\n' stn stn-ingress stn-tmux-popup LICENSE)
if [ "$actual_manifest" != "$expected_manifest" ]; then
  printf 'Release archive manifest does not match the installer contract.\n' >&2
  rm -f "$archive"
  exit 1
fi

printf '%s\n' "$archive"
