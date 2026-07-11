#!/bin/sh

set -eu
umask 077

repository="jeremy0dell/station"
github_host="github.com"
export GH_HOST=$github_host
requested_version=""
requested_version_set=0
install_dir=""
release_id=${STATION_INSTALL_RELEASE_ID:-}
temp_dir=""
install_stage=""
license_stage=""
license_dir=""
license_path=""
license_backup=""
license_displaced=0
license_installed=0
lock_dir=""
lock_owned=0
lock_acquiring=0
pending_signal_name=""
pending_signal_status=0
child_starting=0
probe_pid=""
watchdog_pid=""
commit_started=0
runtime_committed=0
created_ingress=0
created_popup=0
line_feed='
'

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

warn() {
  printf 'Station install warning: %s\n' "$1" >&2 || true
}

readlink_target() {
  if ! raw_link=$(
    readlink -n "$1"
    readlink_status=$?
    printf x
    exit "$readlink_status"
  ); then
    return 1
  fi
  link_target=${raw_link%x}
}

remove_tree() {
  path=$1
  [ -n "$path" ] || return 0
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return 0
  fi
  rm -rf "$path" 2>/dev/null || warn "could not remove residual path '$path'; remove it manually."
}

remove_created_alias() {
  path=$1
  created=$2
  [ "$created" -eq 1 ] || return 0
  if [ -L "$path" ] && readlink_target "$path" 2>/dev/null && [ "$link_target" = stn ]; then
    rm -f "$path" 2>/dev/null || warn "could not remove residual alias '$path'; remove it manually."
  elif [ -e "$path" ] || [ -L "$path" ]; then
    warn "created alias '$path' changed during cleanup; inspect it manually."
  fi
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e

  if [ -n "$watchdog_pid" ]; then
    kill -TERM "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
    watchdog_pid=""
  fi
  if [ -n "$probe_pid" ]; then
    kill -TERM "$probe_pid" 2>/dev/null || true
    kill -KILL "$probe_pid" 2>/dev/null || true
    wait "$probe_pid" 2>/dev/null || true
    probe_pid=""
  fi

  if [ "$license_displaced" -eq 0 ] && [ -n "$license_backup" ] && [ -e "$license_backup" ]; then
    license_displaced=1
  fi
  if [ "$commit_started" -eq 1 ] && [ -n "$install_stage" ] && [ ! -e "$install_stage/stn" ]; then
    runtime_committed=1
  fi

  if [ "$runtime_committed" -eq 0 ]; then
    if [ "$license_displaced" -eq 1 ]; then
      if ! mv -f "$license_backup" "$license_path" 2>/dev/null; then
        warn "could not restore the previous license from '$license_backup' to '$license_path'."
        license_stage=""
      fi
    elif [ "$license_installed" -eq 1 ]; then
      rm -f "$license_path" 2>/dev/null || warn "could not remove the new license '$license_path'."
    fi
    remove_created_alias "$install_dir/stn-ingress" "$created_ingress"
    remove_created_alias "$install_dir/stn-tmux-popup" "$created_popup"
  fi

  remove_tree "$temp_dir"
  remove_tree "$install_stage"
  remove_tree "$license_stage"

  if [ "$lock_owned" -eq 1 ]; then
    rm -f "$lock_dir/owner" 2>/dev/null || warn "could not remove lock owner '$lock_dir/owner'."
    if ! rmdir "$lock_dir" 2>/dev/null; then
      warn "could not remove install lock '$lock_dir'; inspect and remove it manually before retrying."
    fi
  fi

  exit "$status"
}

on_signal() {
  signal=$1
  status=$2
  if [ "$lock_acquiring" -eq 1 ] || [ "$child_starting" -eq 1 ]; then
    if [ "$pending_signal_status" -eq 0 ]; then
      pending_signal_name=$signal
      pending_signal_status=$status
    fi
    return 0
  fi
  printf 'Station install interrupted by %s; cleaning up.\n' "$signal" >&2 || true
  exit "$status"
}

finish_pending_signal() {
  [ "$pending_signal_status" -eq 0 ] || on_signal "$pending_signal_name" "$pending_signal_status"
}

trap cleanup EXIT
trap 'on_signal HUP 129' HUP
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM

absolute_path() {
  case "$1" in
    /*) absolute_result=$1 ;;
    *) absolute_result=$current_dir/$1 ;;
  esac
}

valid_version() {
  version=$1
  case "$version" in
    ''|*[!0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.+-]*) return 1 ;;
  esac
  if ! printf '%s\n' "$version" | LC_ALL=C grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'; then
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
      [ "$requested_version_set" -eq 0 ] || fail "--version may be specified only once."
      requested_version=$2
      requested_version_set=1
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

if [ "$requested_version_set" -eq 1 ] && ! valid_version "$requested_version"; then
  fail "version must be valid v-prefixed SemVer, for example v0.1.1 or v0.1.1-rc.1."
fi
if [ -n "$release_id" ]; then
  case "$release_id" in
    *[!0-9]*) fail "STATION_INSTALL_RELEASE_ID must be a numeric GitHub release ID." ;;
  esac
  [ "$requested_version_set" -eq 1 ] || fail "STATION_INSTALL_RELEASE_ID requires --version."
fi

if ! raw_current_dir=$(
  pwd -P
  pwd_status=$?
  printf x
  exit "$pwd_status"
); then
  fail "could not resolve the current directory."
fi
raw_current_dir=${raw_current_dir%x}
case "$raw_current_dir" in
  *"$line_feed") current_dir=${raw_current_dir%"$line_feed"} ;;
  *) current_dir=$raw_current_dir ;;
esac
if [ -z "$install_dir" ]; then
  [ -n "${HOME:-}" ] || fail "HOME is unset; pass --install-dir explicitly."
  install_dir=$HOME/.local/bin
fi
absolute_path "$install_dir"
install_dir=$absolute_result

if [ -n "${XDG_DATA_HOME:-}" ]; then
  absolute_path "$XDG_DATA_HOME"
  data_home=$absolute_result
else
  [ -n "${HOME:-}" ] || fail "HOME is unset; set an absolute XDG_DATA_HOME for the Station license."
  absolute_path "$HOME/.local/share"
  data_home=$absolute_result
fi
license_dir=$data_home/station
license_path=$license_dir/LICENSE
absolute_path "${TMPDIR:-/tmp}"
tmp_base=$absolute_result

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

mkdir -p "$install_dir" || fail "could not create Station install directory '$install_dir'."
lock_dir=$install_dir/.station-install.lock
lock_acquiring=1
# The mkdir child ignores signals so cleanup learns whether this process owns the atomic lock.
if (
  trap '' HUP INT TERM
  mkdir "$lock_dir" 2>/dev/null
); then
  lock_owned=1
  lock_acquiring=0
  finish_pending_signal
  if [ "$requested_version_set" -eq 1 ]; then
    owner_request=$requested_version
  else
    owner_request=latest
  fi
  if ! printf 'pid=%s\nrequested=%s\n' "$$" "$owner_request" > "$lock_dir/owner"; then
    fail "could not write install lock owner '$lock_dir/owner'."
  fi
else
  lock_acquiring=0
  finish_pending_signal
  if [ ! -e "$lock_dir" ] && [ ! -L "$lock_dir" ]; then
    fail "could not acquire install lock '$lock_dir'; check the destination permissions."
  fi
  owner_pid=""
  if [ -f "$lock_dir/owner" ] && [ ! -L "$lock_dir/owner" ] && [ -r "$lock_dir/owner" ]; then
    while IFS='=' read -r owner_key owner_value; do
      if [ "$owner_key" = pid ]; then
        case "$owner_value" in
          ''|*[!0-9]*) ;;
          *) owner_pid=$owner_value ;;
        esac
      fi
    done < "$lock_dir/owner"
  fi
  if [ -n "$owner_pid" ]; then
    fail "another Station installer owns '$lock_dir' (owner PID $owner_pid). The existing Station installation was unchanged. Wait for it to finish. If it was interrupted, first confirm no installer process with PID $owner_pid is alive, then manually remove '$lock_dir' and retry."
  fi
  fail "another Station installer owns '$lock_dir' (owner PID unavailable). The existing Station installation was unchanged. Wait for it to finish. If it was interrupted, first confirm no installer process is alive, then manually remove '$lock_dir' and retry."
fi
mkdir -p "$license_dir" || fail "could not create Station data directory '$license_dir'."

binary_path=$install_dir/stn
ingress_path=$install_dir/stn-ingress
popup_path=$install_dir/stn-tmux-popup

if [ -e "$binary_path" ] || [ -L "$binary_path" ]; then
  if [ ! -f "$binary_path" ] || [ -L "$binary_path" ]; then
    fail "existing Station binary '$binary_path' must be a regular non-symlink file."
  fi
fi
for launcher_path in "$ingress_path" "$popup_path"; do
  if [ -e "$launcher_path" ] || [ -L "$launcher_path" ]; then
    if [ ! -L "$launcher_path" ] || ! readlink_target "$launcher_path" 2>/dev/null || [ "$link_target" != stn ]; then
      fail "existing launcher '$launcher_path' must be absent or a symlink to 'stn'; it was not changed."
    fi
  fi
done
if [ -e "$license_path" ] || [ -L "$license_path" ]; then
  if [ ! -f "$license_path" ] || [ -L "$license_path" ]; then
    fail "existing Station license '$license_path' must be a regular non-symlink file."
  fi
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
elif [ "$requested_version_set" -eq 1 ]; then
  tag=$requested_version
  release_endpoint="repos/$repository/releases/tags/$tag"
else
  if ! raw_tag=$(
    gh api "repos/$repository/releases/latest" --jq '.tag_name'
    gh_status=$?
    printf x
    exit "$gh_status"
  ); then
    fail "could not resolve the latest stable Station release; check 'gh auth status' and repository access."
  fi
  raw_tag=${raw_tag%x}
  case "$raw_tag" in
    *"$line_feed") tag=${raw_tag%"$line_feed"} ;;
    *) tag=$raw_tag ;;
  esac
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
temp_dir=$(mktemp -d "$tmp_base/station-install.XXXXXX") || fail "could not create a temporary directory."
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
  if [ ! -L "$extracted_dir/$launcher" ] || ! readlink_target "$extracted_dir/$launcher" || [ "$link_target" != stn ]; then
    fail "the Station release manifest must contain '$launcher' as a symlink to 'stn'."
  fi
done

# Stage on each destination filesystem so every final rename is atomic.
install_stage=$(mktemp -d "$install_dir/.station-install.XXXXXX") || fail "cannot stage files in $install_dir."
license_stage=$(mktemp -d "$license_dir/.station-install.XXXXXX") || fail "cannot stage the license in $license_dir."
if ! cp "$extracted_dir/stn" "$install_stage/stn"; then
  fail "could not stage the Station binary in $install_dir."
fi
chmod 0755 "$install_stage/stn" || fail "could not set executable permissions on the staged Station binary."
if { [ "$target" = darwin-arm64 ] || [ "$target" = darwin-x64 ]; } && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$install_stage/stn" 2>/dev/null || true
fi

probe_output=$temp_dir/probe.stdout
probe_error=$temp_dir/probe.stderr
probe_timeout_marker=$temp_dir/probe-timeout
child_starting=1
"$install_stage/stn" --version > "$probe_output" 2> "$probe_error" &
probe_pid=$!
child_starting=0
finish_pending_signal
child_starting=1
(
  watchdog_timer=""
  watchdog_cancelled=0
  stop_watchdog() {
    watchdog_cancelled=1
    if [ -n "$watchdog_timer" ]; then
      kill -TERM "$watchdog_timer" 2>/dev/null || true
      wait "$watchdog_timer" 2>/dev/null || true
      exit 0
    fi
  }
  trap stop_watchdog HUP INT TERM

  sleep 10 &
  watchdog_timer=$!
  if [ "$watchdog_cancelled" -eq 1 ]; then
    stop_watchdog
  fi
  if ! wait "$watchdog_timer"; then
    exit 0
  fi
  watchdog_timer=""
  if kill -0 "$probe_pid" 2>/dev/null; then
    : > "$probe_timeout_marker"
    kill -TERM "$probe_pid" 2>/dev/null || true
    sleep 1 &
    watchdog_timer=$!
    if [ "$watchdog_cancelled" -eq 1 ]; then
      stop_watchdog
    fi
    if wait "$watchdog_timer"; then
      watchdog_timer=""
      kill -KILL "$probe_pid" 2>/dev/null || true
    fi
  fi
) &
watchdog_pid=$!
child_starting=0
finish_pending_signal

probe_status=0
if wait "$probe_pid"; then
  probe_status=0
else
  probe_status=$?
fi
probe_pid=""
# Cancellation is latched before timer cleanup so each watchdog child is recorded and reaped.
kill -TERM "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
watchdog_pid=""

if [ -f "$probe_timeout_marker" ]; then
  fail "the verified Station binary did not respond to '--version' within 10 seconds; the existing Station installation was unchanged."
fi
if [ "$probe_status" -ne 0 ]; then
  fail "the verified Station binary cannot run on this system; the existing installation was not changed."
fi
if ! probed_version=$(cat "$probe_output"); then
  fail "could not read the verified Station binary version; the existing installation was not changed."
fi
if [ "$probed_version" != "$version" ]; then
  fail "the verified Station binary reports version '$probed_version', expected '$version'; the existing installation was not changed."
fi

if [ ! -L "$ingress_path" ]; then
  created_ingress=1
  ln -s stn "$ingress_path" || fail "could not create Station launcher '$ingress_path'."
fi
if [ ! -L "$popup_path" ]; then
  created_popup=1
  ln -s stn "$popup_path" || fail "could not create Station launcher '$popup_path'."
fi

new_license=$license_stage/LICENSE.new
if ! cp "$extracted_dir/LICENSE" "$new_license"; then
  fail "could not stage the Station license in $license_dir."
fi
chmod 0644 "$new_license" || fail "could not set permissions on the staged Station license."
if [ -e "$license_path" ]; then
  license_backup=$license_stage/LICENSE.previous
  if ! mv "$license_path" "$license_backup"; then
    fail "could not back up the existing Station license '$license_path'."
  fi
  license_displaced=1
fi
license_installed=1
if ! mv "$new_license" "$license_path"; then
  fail "could not install the Station license '$license_path'."
fi

# Renaming the verified binary is the sole runtime commit point; aliases already resolve through stn.
commit_started=1
if ! mv -f "$install_stage/stn" "$binary_path"; then
  fail "could not activate the verified Station binary; the existing Station installation was unchanged."
fi
runtime_committed=1

set +e
printf 'Installed Station %s to %s/stn\n' "$tag" "$install_dir"
printf 'Next: run stn setup\n'
case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *) printf 'Add %s to PATH to run stn from any directory.\n' "$install_dir" ;;
esac
exit 0
