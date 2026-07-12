#!/bin/sh
set -eu

repository=${STATION_INSTALL_REPOSITORY:-jeremy0dell/station}
install_dir=${HOME:?HOME is required}/.local/bin
version=

usage() {
  echo "Usage: install.sh [--version vX.Y.Z] [--install-dir PATH]"
}

fail() {
  echo "station installer: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail "--version requires vX.Y.Z"
      version=$2
      shift 2
      ;;
    --install-dir)
      [ "$#" -ge 2 ] || fail "--install-dir requires a path"
      install_dir=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) fail "unsupported argument: $1" ;;
  esac
done

command -v gh >/dev/null 2>&1 || fail "GitHub CLI is required"
gh auth status >/dev/null 2>&1 || fail "authenticate first with: gh auth login"

if [ -z "$version" ]; then
  version=$(gh api "repos/$repository/releases/latest" --jq .tag_name)
fi
printf '%s\n' "$version" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' ||
  fail "version must be vX.Y.Z: $version"

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) target=darwin-arm64 ;;
  Darwin:x86_64) target=darwin-x64 ;;
  Linux:aarch64|Linux:arm64) target=linux-arm64 ;;
  Linux:x86_64) target=linux-x64 ;;
  *) fail "unsupported platform: $(uname -s)/$(uname -m)" ;;
esac

format=gz
if command -v xz >/dev/null 2>&1; then
  format=xz
fi
archive="stn-$version-$target.tar.$format"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM

gh release download "$version" --repo "$repository" --pattern "$archive" --dir "$work"
gh release download "$version" --repo "$repository" --pattern SHA256SUMS --dir "$work"

expected=$(awk -v file="$archive" '$2 == file { print $1 }' "$work/SHA256SUMS")
[ "$(printf '%s\n' "$expected" | wc -l | tr -d ' ')" -eq 1 ] || fail "missing or duplicate checksum for $archive"
case "$(uname -s)" in
  Darwin) actual=$(shasum -a 256 "$work/$archive" | awk '{ print $1 }') ;;
  *) actual=$(sha256sum "$work/$archive" | awk '{ print $1 }') ;;
esac
[ "$actual" = "$expected" ] || fail "checksum mismatch for $archive"

mkdir "$work/extracted"
case "$format" in
  xz) xz -dc "$work/$archive" > "$work/archive.tar" ;;
  gz) gzip -dc "$work/$archive" > "$work/archive.tar" ;;
esac
archive_manifest=$(tar -tf "$work/archive.tar" | LC_ALL=C sort)
expected_manifest=$(printf '%s\n' LICENSE stn stn-ingress stn-tmux-popup | LC_ALL=C sort)
[ "$archive_manifest" = "$expected_manifest" ] || fail "archive manifest is invalid"
tar -xf "$work/archive.tar" -C "$work/extracted"

actual_manifest=$(find "$work/extracted" -mindepth 1 -maxdepth 1 -exec basename {} \; | LC_ALL=C sort)
[ "$actual_manifest" = "$expected_manifest" ] || fail "archive manifest is invalid"
[ -f "$work/extracted/stn" ] && [ ! -L "$work/extracted/stn" ] || fail "stn is not a regular file"
[ -x "$work/extracted/stn" ] || fail "stn is not executable"
[ -f "$work/extracted/LICENSE" ] && [ ! -L "$work/extracted/LICENSE" ] || fail "LICENSE is not a regular file"
[ -L "$work/extracted/stn-ingress" ] && [ "$(readlink "$work/extracted/stn-ingress")" = stn ] || fail "stn-ingress symlink is invalid"
[ -L "$work/extracted/stn-tmux-popup" ] && [ "$(readlink "$work/extracted/stn-tmux-popup")" = stn ] || fail "stn-tmux-popup symlink is invalid"

mkdir -p "$install_dir"
stage="$install_dir/.stn-install-$$"
cp "$work/extracted/stn" "$stage"
chmod 0755 "$stage"
if command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$stage" 2>/dev/null || true
fi
ln -s stn "$stage-ingress"
ln -s stn "$stage-tmux-popup"

mv -f "$stage" "$install_dir/stn"
mv -f "$stage-ingress" "$install_dir/stn-ingress"
mv -f "$stage-tmux-popup" "$install_dir/stn-tmux-popup"

echo "Installed Station $version to $install_dir"
case ":$PATH:" in
  *:"$install_dir":*) ;;
  *) echo "Add $install_dir to PATH to run stn." ;;
esac
