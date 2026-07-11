#!/bin/sh

set -eu

repository="jeremy0dell/station"
github_host="github.com"
export GH_HOST=$github_host
requested_version=""
install_dir=""
release_id=${STATION_INSTALL_RELEASE_ID:-}
temp_dir=""
install_stage=""
license_stage=""

usage() {
  cat <<'EOF'
Usage: install.sh [--version vX.Y.Z[-prerelease]] [--install-dir PATH]

Install the latest stable private Station release, or an explicit version.

Options:
  --version VERSION   Install an immutable v-prefixed release version.
  --install-dir PATH  Install commands here (default: ~/.local/bin).
  -h, --help          Show this help.
EOF
}

fail() {
  printf 'Station install failed: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  [ -z "$temp_dir" ] || rm -rf "$temp_dir"
  [ -z "$install_stage" ] || rm -rf "$install_stage"
  [ -z "$license_stage" ] || rm -rf "$license_stage"
}

trap cleanup EXIT HUP INT TERM

valid_version() {
  version=$1
  if ! printf '%s\n' "$version" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'; then
    return 1
  fi

  case "$version" in
    *-*) prerelease=${version#*-} ;;
    *) return 0 ;;
  esac

  old_ifs=$IFS
  IFS=.
  set -- $prerelease
  IFS=$old_ifs
  for identifier do
    case "$identifier" in
      *[!0-9]*) ;;
      0) ;;
      0*) return 1 ;;
    esac
  done
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail "--version requires a value."
      [ -z "$requested_version" ] || fail "--version may be specified only once."
      requested_version=$2
      shift 2
      ;;
    --install-dir)
      [ "$#" -ge 2 ] || fail "--install-dir requires a path."
      [ -z "$install_dir" ] || fail "--install-dir may be specified only once."
      [ -n "$2" ] || fail "--install-dir requires a non-empty path."
      install_dir=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option '$1'; run with --help for usage."
      ;;
  esac
done

if [ -n "$requested_version" ] && ! valid_version "$requested_version"; then
  fail "version must be valid v-prefixed SemVer, for example v0.1.1 or v0.1.1-rc.1."
fi
if [ -n "$release_id" ]; then
  case "$release_id" in
    *[!0-9]*) fail "STATION_INSTALL_RELEASE_ID must be a numeric GitHub release ID." ;;
  esac
  [ -n "$requested_version" ] || fail "STATION_INSTALL_RELEASE_ID requires --version."
fi

if [ -z "$install_dir" ]; then
  [ -n "${HOME:-}" ] || fail "HOME is unset; pass --install-dir explicitly."
  install_dir=$HOME/.local/bin
fi

case "$(uname -s 2>/dev/null || true):$(uname -m 2>/dev/null || true)" in
  Darwin:arm64|Darwin:aarch64) target=darwin-arm64 ;;
  Darwin:x86_64|Darwin:amd64) target=darwin-x64 ;;
  Linux:arm64|Linux:aarch64) target=linux-arm64 ;;
  Linux:x86_64|Linux:amd64) target=linux-x64 ;;
  *) fail "unsupported platform; Station binaries support macOS and glibc Linux on arm64 or x64." ;;
esac

command -v gh >/dev/null 2>&1 || fail "GitHub CLI is required; install 'gh', then run 'gh auth login --hostname github.com'."
if ! gh auth status --hostname "$github_host" >/dev/null 2>&1; then
  fail "GitHub authentication is required for this private release; run 'gh auth login --hostname github.com', then retry."
fi

require_single_numeric_id() {
  case "$1" in
    ''|*[!0-9]*) fail "$2" ;;
  esac
}

if [ -n "$release_id" ]; then
  tag=$requested_version
  version=${tag#v}
  archive_name="stn-v${version}-${target}.tar.gz"
  # GitHub tag endpoints exclude drafts; the authenticated release list is draft-visible.
  draft_endpoint="repos/$repository/releases?per_page=100"
  draft_match=".[] | select(.draft == true and .id == $release_id and .tag_name == \"$tag\")"
  if ! draft_ids=$(gh api --paginate "$draft_endpoint" --jq "$draft_match | .id"); then
    fail "could not list draft releases; check your authentication and repository access."
  fi
  require_single_numeric_id "$draft_ids" "no single draft matched ID $release_id and requested version '$tag'."

  draft_asset_id() {
    asset_name=$1
    filter="$draft_match | .assets[] | select(.name == \"$asset_name\") | .id"
    if ! ids=$(gh api --paginate "$draft_endpoint" --jq "$filter"); then
      fail "could not read assets for draft release $tag."
    fi
    require_single_numeric_id "$ids" "release $tag must contain exactly one '$asset_name' asset."
    printf '%s\n' "$ids"
  }

  archive_id=$(draft_asset_id "$archive_name")
  checksums_id=$(draft_asset_id "SHA256SUMS")
elif [ -n "$requested_version" ]; then
  tag=$requested_version
  release_endpoint="repos/$repository/releases/tags/$tag"
else
  if ! tag=$(gh api "repos/$repository/releases/latest" --jq '.tag_name'); then
    fail "could not resolve the latest stable Station release; check 'gh auth status' and repository access."
  fi
  if ! valid_version "$tag"; then
    fail "the latest Station release returned an invalid tag."
  fi
  release_endpoint="repos/$repository/releases/tags/$tag"
fi

if [ -z "$release_id" ]; then
  version=${tag#v}
  archive_name="stn-v${version}-${target}.tar.gz"
fi

asset_id() {
  asset_name=$1
  if ! ids=$(gh api "$release_endpoint" --jq ".assets[] | select(.name == \"$asset_name\") | .id"); then
    fail "could not read release $tag; check that the release exists and your account can access it."
  fi
  require_single_numeric_id "$ids" "release $tag must contain exactly one '$asset_name' asset."
  printf '%s\n' "$ids"
}

if [ -z "$release_id" ]; then
  archive_id=$(asset_id "$archive_name")
  checksums_id=$(asset_id "SHA256SUMS")
fi
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/station-install.XXXXXX") || fail "could not create a temporary directory."
archive_path=$temp_dir/$archive_name
checksums_path=$temp_dir/SHA256SUMS

if ! gh api -H "Accept: application/octet-stream" "repos/$repository/releases/assets/$archive_id" > "$archive_path"; then
  fail "could not download $archive_name from release $tag."
fi
if ! gh api -H "Accept: application/octet-stream" "repos/$repository/releases/assets/$checksums_id" > "$checksums_path"; then
  fail "could not download SHA256SUMS from release $tag."
fi

expected_hashes=$(awk -v name="$archive_name" '$2 == name || $2 == "*" name { print $1 }' "$checksums_path")
case "$expected_hashes" in
  ''|*'
'*) fail "SHA256SUMS must contain exactly one checksum for $archive_name." ;;
esac
if ! printf '%s\n' "$expected_hashes" | grep -Eq '^[0-9A-Fa-f]{64}$'; then
  fail "SHA256SUMS contains an invalid checksum for $archive_name."
fi

if command -v sha256sum >/dev/null 2>&1; then
  if ! (cd "$temp_dir" && printf '%s  %s\n' "$expected_hashes" "$archive_name" | sha256sum -c - >/dev/null 2>&1); then
    fail "checksum verification failed for $archive_name; the existing installation was not changed."
  fi
elif command -v shasum >/dev/null 2>&1; then
  if ! (cd "$temp_dir" && printf '%s  %s\n' "$expected_hashes" "$archive_name" | shasum -a 256 -c - >/dev/null 2>&1); then
    fail "checksum verification failed for $archive_name; the existing installation was not changed."
  fi
else
  fail "sha256sum or shasum is required to verify the release archive."
fi

manifest_path=$temp_dir/manifest
if ! tar -tzf "$archive_path" > "$manifest_path"; then
  fail "$archive_name is not a readable gzip-compressed tar archive."
fi
actual_manifest=$(LC_ALL=C sort "$manifest_path")
expected_manifest=$(printf '%s\n' LICENSE stn stn-ingress stn-tmux-popup | LC_ALL=C sort)
if [ "$actual_manifest" != "$expected_manifest" ]; then
  fail "$archive_name does not contain the exact Station release manifest; nothing was installed."
fi

extracted_dir=$temp_dir/extracted
mkdir "$extracted_dir"
# Extract only the approved names so an archive cannot write outside the staging directory.
if ! tar -xzf "$archive_path" -C "$extracted_dir" stn stn-ingress stn-tmux-popup LICENSE; then
  fail "could not extract the verified Station release archive."
fi
if [ ! -f "$extracted_dir/stn" ] || [ -L "$extracted_dir/stn" ]; then
  fail "the Station release manifest must contain a regular 'stn' binary."
fi
if [ ! -f "$extracted_dir/LICENSE" ] || [ -L "$extracted_dir/LICENSE" ]; then
  fail "the Station release manifest must contain a regular 'LICENSE' file."
fi
for launcher in stn-ingress stn-tmux-popup; do
  if [ ! -L "$extracted_dir/$launcher" ] || [ "$(readlink "$extracted_dir/$launcher")" != "stn" ]; then
    fail "the Station release manifest must contain '$launcher' as a symlink to 'stn'."
  fi
done

[ -n "${HOME:-}" ] || fail "HOME is unset; it is required to install the Station license."
license_dir=${XDG_DATA_HOME:-$HOME/.local/share}/station
mkdir -p "$install_dir" "$license_dir"
for destination in "$install_dir/stn" "$install_dir/stn-ingress" "$install_dir/stn-tmux-popup" "$license_dir/LICENSE"; do
  [ ! -d "$destination" ] || fail "cannot replace directory '$destination'."
done

# Stage on each destination filesystem so every final rename is atomic.
install_stage=$(mktemp -d "$install_dir/.station-install.XXXXXX") || fail "cannot stage files in $install_dir."
license_stage=$(mktemp -d "$license_dir/.station-install.XXXXXX") || fail "cannot stage the license in $license_dir."
cp "$extracted_dir/stn" "$install_stage/stn"
chmod 755 "$install_stage/stn"
if { [ "$target" = darwin-arm64 ] || [ "$target" = darwin-x64 ]; } && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$install_stage/stn" 2>/dev/null || true
fi
if ! probed_version=$("$install_stage/stn" --version 2>/dev/null); then
  fail "the verified Station binary cannot run on this system; the existing installation was not changed."
fi
if [ "$probed_version" != "$version" ]; then
  fail "the verified Station binary reports version '$probed_version', expected '$version'; the existing installation was not changed."
fi
ln -s stn "$install_stage/stn-ingress"
ln -s stn "$install_stage/stn-tmux-popup"
cp "$extracted_dir/LICENSE" "$license_stage/LICENSE"

mv -f "$license_stage/LICENSE" "$license_dir/LICENSE"
mv -f "$install_stage/stn" "$install_dir/stn"
mv -f "$install_stage/stn-ingress" "$install_dir/stn-ingress"
mv -f "$install_stage/stn-tmux-popup" "$install_dir/stn-tmux-popup"

printf 'Installed Station %s to %s/stn\n' "$tag" "$install_dir"
printf 'Next: run stn setup\n'
case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *) printf 'Add %s to PATH to run stn from any directory.\n' "$install_dir" ;;
esac
