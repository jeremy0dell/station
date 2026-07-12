#!/bin/sh
set -eu

version=${1:?usage: package-binary.sh vX.Y.Z target output-dir}
target=${2:?usage: package-binary.sh vX.Y.Z target output-dir}
output_dir=${3:?usage: package-binary.sh vX.Y.Z target output-dir}
tar_command=${TAR_COMMAND:-tar}
binary_dir=${STATION_BINARY_DIR:-station/dist/bin}
name="stn-${version}-${target}"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM

mkdir -p "$output_dir"
cp "$binary_dir/stn" "$stage/stn"
cp LICENSE "$stage/LICENSE"
chmod 0755 "$stage/stn"
chmod 0644 "$stage/LICENSE"
ln -s stn "$stage/stn-ingress"
ln -s stn "$stage/stn-tmux-popup"
touch -t 197001010000 "$stage/stn" "$stage/LICENSE"

archive="$output_dir/$name.tar"
"$tar_command" \
  --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -cf "$archive" -C "$stage" LICENSE stn stn-ingress stn-tmux-popup
gzip -n -9 -c "$archive" > "$archive.gz"
xz -6 -c "$archive" > "$archive.xz"
rm "$archive"

wc -c "$stage/stn" "$archive.gz" "$archive.xz"
