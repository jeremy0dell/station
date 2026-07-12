#!/bin/sh
set -eu

gzip_archive=${1:?usage: verify-binary-archives.sh archive.tar.gz archive.tar.xz}
xz_archive=${2:?usage: verify-binary-archives.sh archive.tar.gz archive.tar.xz}
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT HUP INT TERM

gzip -dc "$gzip_archive" > "$root/gzip.tar"
xz -dc "$xz_archive" > "$root/xz.tar"
cmp "$root/gzip.tar" "$root/xz.tar"

for format in gzip xz; do
  mkdir "$root/$format"
  tar -xf "$root/$format.tar" -C "$root/$format"
  actual=$(find "$root/$format" -mindepth 1 -maxdepth 1 -exec basename {} \; | LC_ALL=C sort)
  expected=$(printf '%s\n' LICENSE stn stn-ingress stn-tmux-popup | LC_ALL=C sort)
  test "$actual" = "$expected"
  test -x "$root/$format/stn"
  test "$(readlink "$root/$format/stn-ingress")" = stn
  test "$(readlink "$root/$format/stn-tmux-popup")" = stn
done

cmp "$root/gzip/stn" "$root/xz/stn"
cmp "$root/gzip/LICENSE" "$root/xz/LICENSE"
