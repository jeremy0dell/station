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
command_lock_dir=""
license_lock_dir=""
command_lock_owned=0
license_lock_owned=0
command_lock_token=""
license_lock_token=""
command_lock_inode=""
license_lock_inode=""
install_lock_token=""
lock_acquiring=0
pending_signal_name=""
pending_signal_status=0
child_starting=0
tracked_child_pid=""
probe_pid=""
watchdog_pid=""
commit_started=0
runtime_committed=0
activation_ambiguity_reported=0
activation_failed_precommit=0
rollback_failed=0
created_ingress=0
created_popup=0
created_ingress_inode=""
created_popup_inode=""
preserve_install_stage=0
line_feed='
'
tab='	'

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

print_shell_word() {
  quote_value=$1
  printf "'"
  while :; do
    case "$quote_value" in
      *"'"*)
        quote_prefix=${quote_value%%"'"*}
        printf "%s'\\\\''" "$quote_prefix"
        quote_value=${quote_value#*"'"}
        ;;
      *)
        printf "%s'" "$quote_value"
        return 0
        ;;
    esac
  done
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

alias_inode() {
  if ! raw_inode=$(LC_ALL=C ls -di "$1" 2>/dev/null); then
    return 1
  fi
  set -- $raw_inode
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  alias_inode_result=$1
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
  expected_inode=$3
  quarantine=$4
  [ "$created" -eq 1 ] || return 0
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return 0
  fi
  if ! alias_inode "$path" || [ -z "$expected_inode" ] || [ "$alias_inode_result" != "$expected_inode" ]; then
    rollback_failed=1
    warn "created alias '$path' changed during cleanup; inspect it manually."
    return 0
  fi
  if ! mv "$path" "$quarantine" 2>/dev/null; then
    rollback_failed=1
    warn "could not quarantine created alias '$path' for safe cleanup; inspect it manually."
    return 0
  fi
  if alias_inode "$quarantine" && [ "$alias_inode_result" = "$expected_inode" ] && [ -L "$quarantine" ] && readlink_target "$quarantine" 2>/dev/null && [ "$link_target" = stn ]; then
    if ! rm -f "$quarantine" 2>/dev/null; then
      rollback_failed=1
      preserve_install_stage=1
      warn "could not remove residual alias '$quarantine'; remove it manually."
    fi
    return 0
  fi

  rollback_failed=1
  if { [ ! -e "$path" ] && [ ! -L "$path" ]; } && mv "$quarantine" "$path" 2>/dev/null; then
    warn "created alias '$path' changed during cleanup; the changed path was restored for manual inspection."
  else
    preserve_install_stage=1
    warn "created alias '$path' changed during cleanup; inspect '$quarantine' and '$path' manually."
  fi
}

report_activation_ambiguity() {
  [ "$activation_ambiguity_reported" -eq 0 ] || return 0
  activation_ambiguity_reported=1
  printf 'Station install failed: the staged binary disappeared during final activation; Station may have been updated.\n' >&2
  printf 'Inspect the installed runtime with: ' >&2
  print_shell_word "$binary_path" >&2
  printf ' --version\n' >&2
}

stop_children() {
  children_present=0
  for child_pid in "$tracked_child_pid" "$watchdog_pid" "$probe_pid"; do
    [ -n "$child_pid" ] || continue
    children_present=1
    kill -TERM "$child_pid" 2>/dev/null || true
  done
  if [ "$children_present" -eq 1 ]; then
    sleep 1 2>/dev/null || true
  fi
  for child_pid in "$tracked_child_pid" "$watchdog_pid" "$probe_pid"; do
    [ -n "$child_pid" ] || continue
    kill -KILL "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  done
  tracked_child_pid=""
  watchdog_pid=""
  probe_pid=""
}

release_lock() {
  release_path=$1
  release_token=$2
  release_inode=$3
  release_owner=$release_path/owner-$release_token
  if [ ! -e "$release_path" ] && [ ! -L "$release_path" ]; then
    return 0
  fi
  if ! alias_inode "$release_path" || [ -z "$release_inode" ] || [ "$alias_inode_result" != "$release_inode" ]; then
    warn "install lock '$release_path' changed ownership; it was not removed."
    return 0
  fi
  lock_token_result=""
  lock_token_count=0
  if [ -f "$release_owner" ] && [ ! -L "$release_owner" ] && [ -r "$release_owner" ]; then
    while IFS='=' read -r owner_key owner_value; do
      if [ "$owner_key" = token ]; then
        lock_token_count=$((lock_token_count + 1))
        lock_token_result=$owner_value
      fi
    done < "$release_owner"
  fi
  if [ "$lock_token_count" -ne 1 ] || [ -z "$release_token" ] || [ "$lock_token_result" != "$release_token" ]; then
    warn "install lock '$release_path' changed ownership; it was not removed."
    return 0
  fi
  rm -f "$release_owner" 2>/dev/null || warn "could not remove lock owner '$release_owner'."
  if ! alias_inode "$release_path" || [ "$alias_inode_result" != "$release_inode" ]; then
    warn "install lock '$release_path' changed ownership; it was not removed."
    return 0
  fi
  if ! rmdir "$release_path" 2>/dev/null; then
    warn "could not remove install lock '$release_path'; inspect and remove it manually before retrying."
  fi
}

cleanup() {
  status=$?
  trap - EXIT
  trap '' HUP INT TERM
  set +e

  stop_children

  if [ "$license_displaced" -eq 0 ] && [ -n "$license_backup" ] && [ -e "$license_backup" ]; then
    license_displaced=1
  fi
  if [ "$runtime_committed" -eq 0 ] && [ "$commit_started" -eq 1 ] && [ -n "$install_stage" ] && [ ! -e "$install_stage/stn" ] && [ ! -L "$install_stage/stn" ]; then
    runtime_committed=1
    report_activation_ambiguity
  fi

  if [ "$runtime_committed" -eq 0 ]; then
    if [ "$license_displaced" -eq 1 ]; then
      if ! mv -f "$license_backup" "$license_path" 2>/dev/null; then
        rollback_failed=1
        warn "could not restore the previous license from '$license_backup' to '$license_path'."
        license_stage=""
      fi
    elif [ "$license_installed" -eq 1 ]; then
      if ! rm -f "$license_path" 2>/dev/null; then
        rollback_failed=1
        warn "could not remove the new license '$license_path'."
      fi
    fi
    remove_created_alias "$install_dir/stn-ingress" "$created_ingress" "$created_ingress_inode" "$install_stage/stn-ingress.rollback"
    remove_created_alias "$install_dir/stn-tmux-popup" "$created_popup" "$created_popup_inode" "$install_stage/stn-tmux-popup.rollback"
    if [ "$activation_failed_precommit" -eq 1 ] && [ "$rollback_failed" -eq 0 ]; then
      printf 'The existing Station installation was unchanged.\n' >&2
    fi
  fi

  remove_tree "$temp_dir"
  if [ "$preserve_install_stage" -eq 0 ]; then
    remove_tree "$install_stage"
  fi
  remove_tree "$license_stage"

  if [ "$license_lock_owned" -eq 1 ]; then
    release_lock "$license_lock_dir" "$license_lock_token" "$license_lock_inode"
  fi
  if [ "$command_lock_owned" -eq 1 ]; then
    release_lock "$command_lock_dir" "$command_lock_token" "$command_lock_inode"
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
  for child_pid in "$tracked_child_pid" "$watchdog_pid" "$probe_pid"; do
    [ -n "$child_pid" ] || continue
    kill -"$signal" "$child_pid" 2>/dev/null || true
  done
  exit "$status"
}

finish_pending_signal() {
  [ "$pending_signal_status" -eq 0 ] || on_signal "$pending_signal_name" "$pending_signal_status"
}

run_gh() {
  gh_output=$1
  gh_error=$2
  shift 2
  child_starting=1
  gh "$@" > "$gh_output" 2> "$gh_error" &
  tracked_child_pid=$!
  child_starting=0
  finish_pending_signal
  if wait "$tracked_child_pid"; then
    tracked_status=0
  else
    tracked_status=$?
  fi
  tracked_child_pid=""
  return "$tracked_status"
}

read_file_value() {
  value_file=$1
  if ! file_value=$(
    cat "$value_file"
    cat_status=$?
    printf x
    exit "$cat_status"
  ); then
    return 1
  fi
  file_value=${file_value%x}
  case "$file_value" in
    *"$line_feed") file_value=${file_value%"$line_feed"} ;;
  esac
}

acquire_lock() {
  acquire_path=$1
  acquire_kind=$2
  lock_acquiring=1
  # Ignore signals only across atomic mkdir so cleanup never guesses whether this process owns the lock.
  if (
    trap '' HUP INT TERM
    mkdir "$acquire_path" 2>/dev/null
  ); then
    if ! alias_inode "$acquire_path"; then
      fail "could not identify acquired install lock '$acquire_path'."
    fi
    acquire_inode=$alias_inode_result
    acquire_token=$install_lock_token-$acquire_kind
    case "$acquire_kind" in
      command)
        command_lock_owned=1
        command_lock_token=$acquire_token
        command_lock_inode=$acquire_inode
        ;;
      license)
        license_lock_owned=1
        license_lock_token=$acquire_token
        license_lock_inode=$acquire_inode
        ;;
    esac
    acquire_owner=$acquire_path/owner-$acquire_token
    if ! printf 'pid=%s\nrequested=%s\ntoken=%s\n' "$$" "$owner_request" "$acquire_token" > "$acquire_owner"; then
      fail "could not write install lock owner '$acquire_owner'."
    fi
    lock_acquiring=0
    finish_pending_signal
    return 0
  fi

  lock_acquiring=0
  finish_pending_signal
  if [ ! -e "$acquire_path" ] && [ ! -L "$acquire_path" ]; then
    fail "could not acquire install lock '$acquire_path'; check the destination permissions."
  fi
  owner_pid=""
  owner_file=""
  owner_file_count=0
  for owner_candidate in "$acquire_path/owner" "$acquire_path"/owner-*; do
    if [ ! -e "$owner_candidate" ] && [ ! -L "$owner_candidate" ]; then
      continue
    fi
    owner_file_count=$((owner_file_count + 1))
    owner_file=$owner_candidate
  done
  if [ "$owner_file_count" -eq 1 ] && [ -f "$owner_file" ] && [ ! -L "$owner_file" ] && [ -r "$owner_file" ]; then
    while IFS='=' read -r owner_key owner_value; do
      if [ "$owner_key" = pid ]; then
        case "$owner_value" in
          ''|*[!0-9]*) ;;
          *) owner_pid=$owner_value ;;
        esac
      fi
    done < "$owner_file"
  fi
  if [ -n "$owner_pid" ]; then
    fail "another Station installer owns '$acquire_path' (owner PID $owner_pid). The existing Station installation was unchanged. Wait for it to finish. If it was interrupted, first confirm no installer process with PID $owner_pid is alive, then manually remove '$acquire_path' and retry."
  fi
  fail "another Station installer owns '$acquire_path' (owner PID unavailable). The existing Station installation was unchanged. Wait for it to finish. If it was interrupted, first confirm no installer process is alive, then manually remove '$acquire_path' and retry."
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
  fail "version must be valid v-prefixed SemVer, for example v0.7.0 or v0.7.1-rc.1."
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
# Reject after absolutizing and before external or local mutation because PATH cannot encode a literal colon in one entry.
case "$install_dir" in
  *:*) fail "install directory cannot contain ':' because PATH uses ':' to separate entries." ;;
esac

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
temp_dir=$(mktemp -d "$tmp_base/station-install.XXXXXX") || fail "could not create a temporary directory."
install_lock_token=$$-${temp_dir##*/}
if ! run_gh "$temp_dir/auth.stdout" "$temp_dir/auth.stderr" auth status --hostname "$github_host"; then
  fail "GitHub authentication is required for this private release; run 'gh auth login --hostname github.com', then retry."
fi

mkdir -p "$install_dir" || fail "could not create Station install directory '$install_dir'."
if [ "$requested_version_set" -eq 1 ]; then
  owner_request=$requested_version
else
  owner_request=latest
fi
command_lock_dir=$install_dir/.station-install.lock
acquire_lock "$command_lock_dir" command

mkdir -p "$license_dir" || fail "could not create Station data directory '$license_dir'."
license_lock_dir=$license_dir/.station-install.lock
if [ "$license_lock_dir" != "$command_lock_dir" ] && ! [ "$license_dir" -ef "$install_dir" ]; then
  acquire_lock "$license_lock_dir" license
fi

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

read_numeric_result() {
  numeric_file=$1
  numeric_error=$2
  if ! read_file_value "$numeric_file"; then
    fail "could not read the GitHub CLI response from '$numeric_file'."
  fi
  require_single_numeric_id "$file_value" "$numeric_error"
  numeric_result=$file_value
}

if [ -n "$release_id" ]; then
  tag=$requested_version
  version=${tag#v}
  archive_name="stn-v${version}-${target}.tar.gz"
  # Draft release lists can lag creation, so acceptance addresses the captured release ID directly.
  draft_endpoint="repos/$repository/releases/$release_id"
  draft_match="select(.draft == true and .id == $release_id and .tag_name == \"$tag\")"
  if ! run_gh "$temp_dir/draft-release.stdout" "$temp_dir/draft-release.stderr" api -H "X-GitHub-Api-Version: 2022-11-28" "$draft_endpoint" --jq "$draft_match | .id"; then
    fail "could not read draft release $release_id; check your authentication and repository access."
  fi
  read_numeric_result "$temp_dir/draft-release.stdout" "no single draft matched ID $release_id and requested version '$tag'."

  lookup_draft_asset() {
    asset_name=$1
    asset_slug=$2
    filter="$draft_match | .assets[] | select(.name == \"$asset_name\") | .id"
    if ! run_gh "$temp_dir/$asset_slug.stdout" "$temp_dir/$asset_slug.stderr" api -H "X-GitHub-Api-Version: 2022-11-28" "$draft_endpoint" --jq "$filter"; then
      fail "could not read assets for draft release $tag."
    fi
    read_numeric_result "$temp_dir/$asset_slug.stdout" "release $tag must contain exactly one '$asset_name' asset."
    asset_result=$numeric_result
  }

  lookup_draft_asset "$archive_name" draft-archive
  archive_id=$asset_result
  lookup_draft_asset SHA256SUMS draft-checksums
  checksums_id=$asset_result
elif [ "$requested_version_set" -eq 1 ]; then
  tag=$requested_version
  release_endpoint="repos/$repository/releases/tags/$tag"
else
  if ! run_gh "$temp_dir/latest.stdout" "$temp_dir/latest.stderr" api "repos/$repository/releases/latest" --jq '.tag_name'; then
    fail "could not resolve the latest stable Station release; check 'gh auth status' and repository access."
  fi
  if ! read_file_value "$temp_dir/latest.stdout"; then
    fail "could not read the latest stable Station release tag."
  fi
  tag=$file_value
  if ! valid_version "$tag"; then
    fail "the latest Station release returned an invalid tag."
  fi
  release_endpoint="repos/$repository/releases/tags/$tag"
fi

if [ -z "$release_id" ]; then
  version=${tag#v}
  archive_name="stn-v${version}-${target}.tar.gz"
fi

lookup_asset() {
  asset_name=$1
  asset_slug=$2
  if ! run_gh "$temp_dir/$asset_slug.stdout" "$temp_dir/$asset_slug.stderr" api "$release_endpoint" --jq ".assets[] | select(.name == \"$asset_name\") | .id"; then
    fail "could not read release $tag; check that the release exists and your account can access it."
  fi
  read_numeric_result "$temp_dir/$asset_slug.stdout" "release $tag must contain exactly one '$asset_name' asset."
  asset_result=$numeric_result
}

if [ -z "$release_id" ]; then
  lookup_asset "$archive_name" release-archive
  archive_id=$asset_result
  lookup_asset SHA256SUMS release-checksums
  checksums_id=$asset_result
fi
archive_path=$temp_dir/$archive_name
checksums_path=$temp_dir/SHA256SUMS

if ! run_gh "$archive_path" "$temp_dir/archive-download.stderr" api -H "Accept: application/octet-stream" "repos/$repository/releases/assets/$archive_id"; then
  fail "could not download $archive_name from release $tag."
fi
if ! run_gh "$checksums_path" "$temp_dir/checksums-download.stderr" api -H "Accept: application/octet-stream" "repos/$repository/releases/assets/$checksums_id"; then
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
verbose_manifest_path=$temp_dir/manifest.verbose
manifest_types_path=$temp_dir/manifest.types
if ! tar -tvzf "$archive_path" > "$verbose_manifest_path"; then
  fail "$archive_name does not expose readable Station member types."
fi
awk '{ print substr($1, 1, 1) }' "$verbose_manifest_path" > "$manifest_types_path"
actual_typed_manifest=$(LC_ALL=C paste "$manifest_path" "$manifest_types_path" | LC_ALL=C sort)
expected_typed_manifest=$(printf 'LICENSE\t-\nstn\t-\nstn-ingress\tl\nstn-tmux-popup\tl\n' | LC_ALL=C sort)
if [ "$actual_typed_manifest" != "$expected_typed_manifest" ]; then
  fail "$archive_name does not contain the required Station member types; nothing was installed."
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
watchdog_ready=$temp_dir/watchdog.ready
watchdog_failed=$temp_dir/watchdog.failed
child_starting=1
(
  if ! ulimit -f 8; then
    exit 125
  fi
  # The untrusted compatibility probe must not inherit download or CI credentials.
  unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
  unset ACTIONS_RUNTIME_TOKEN ACTIONS_ID_TOKEN_REQUEST_TOKEN STATION_INSTALL_RELEASE_ID
  exec "$install_stage/stn" --version
) > "$probe_output" 2> "$probe_error" &
probe_pid=$!
child_starting=0
finish_pending_signal
child_starting=1
(
  watchdog_timer=""
  watchdog_result=0

  stop_watchdog() {
    if [ -n "$watchdog_timer" ]; then
      kill -TERM "$watchdog_timer" 2>/dev/null || true
      kill -KILL "$watchdog_timer" 2>/dev/null || true
      wait "$watchdog_timer" 2>/dev/null || true
    fi
    exit "$watchdog_result"
  }

  stop_probe() {
    watchdog_result=$1
    kill -TERM "$probe_pid" 2>/dev/null || true
    if ! sleep 1; then
      watchdog_result=125
      kill -KILL "$probe_pid" 2>/dev/null || true
      exit "$watchdog_result"
    fi
    kill -KILL "$probe_pid" 2>/dev/null || true
    exit "$watchdog_result"
  }

  report_watchdog_setup_failure() {
    [ -e "$watchdog_ready" ] || : > "$watchdog_failed"
  }
  trap report_watchdog_setup_failure EXIT
  trap '' HUP INT TERM

  sleep 10 &
  watchdog_timer=$!
  trap stop_watchdog HUP INT TERM
  if ! : > "$watchdog_ready"; then
    watchdog_result=125
    stop_watchdog
  fi
  trap - EXIT
  if wait "$watchdog_timer"; then
    watchdog_timer=""
    if kill -0 "$probe_pid" 2>/dev/null; then
      stop_probe 124
    fi
    exit 0
  else
    timer_status=$?
    watchdog_result=125
  fi
  watchdog_timer=""

  if kill -0 "$probe_pid" 2>/dev/null; then
    stop_probe 125
  fi
  [ "$timer_status" -eq 0 ] || exit 125
  exit 0
) &
watchdog_pid=$!
# Do not cancel a fast probe's watchdog until its timer and cleanup trap are coherent.
while [ ! -e "$watchdog_ready" ] && [ ! -e "$watchdog_failed" ] && [ "$pending_signal_status" -eq 0 ]; do
  sleep 0.01 2>/dev/null || true
done
child_starting=0
finish_pending_signal
if [ ! -e "$watchdog_ready" ]; then
  wait "$watchdog_pid" 2>/dev/null || true
  watchdog_pid=""
  fail "the compatibility probe supervisor failed; the existing Station installation was unchanged."
fi

probe_status=0
if wait "$probe_pid"; then
  probe_status=0
else
  probe_status=$?
fi
probe_pid=""
kill -TERM "$watchdog_pid" 2>/dev/null || true
if wait "$watchdog_pid"; then
  watchdog_status=0
else
  watchdog_status=$?
fi
watchdog_pid=""

print_probe_diagnostics() {
  [ -s "$probe_error" ] || return 0
  printf 'Compatibility probe stderr (up to 4096 sanitized bytes):\n' >&2
  dd if="$probe_error" bs=4096 count=1 2>/dev/null | LC_ALL=C tr -cd "[:print:]$tab$line_feed" >&2
  printf '\n' >&2
}

if [ "$watchdog_status" -eq 124 ]; then
  print_probe_diagnostics
  fail "the verified Station binary did not respond to '--version' within 10 seconds; the existing Station installation was unchanged."
fi
if [ "$watchdog_status" -eq 125 ]; then
  print_probe_diagnostics
  fail "the compatibility probe timer failed; the existing Station installation was unchanged."
fi
if [ "$watchdog_status" -ne 0 ]; then
  print_probe_diagnostics
  fail "the compatibility probe supervisor failed; the existing Station installation was unchanged."
fi
if [ "$probe_status" -ne 0 ]; then
  print_probe_diagnostics
  fail "the verified Station binary cannot run on this system; the existing installation was not changed."
fi
if ! probed_version=$(cat "$probe_output"); then
  fail "could not read the verified Station binary version; the existing installation was not changed."
fi
if [ "$probed_version" != "$version" ]; then
  fail "the verified Station binary reports an unexpected version; expected '$version'. The existing installation was not changed."
fi

create_alias() {
  alias_path=$1
  alias_kind=$2
  alias_name=${alias_path##*/}
  alias_source_dir=$install_stage/$alias_kind.alias-source
  alias_source=$alias_source_dir/$alias_name
  alias_owner=$install_stage/$alias_kind.alias-inode
  child_starting=1
  # Publish the recorded symlink inode atomically so cleanup never adopts an external replacement.
  if (
    trap '' HUP INT TERM
    mkdir "$alias_source_dir" || exit
    ln -s stn "$alias_source" || exit
    alias_inode "$alias_source" || exit
    printf '%s\n' "$alias_inode_result" > "$alias_owner" || exit
    alias_status=0
    ln -P "$alias_source" "$install_dir" || alias_status=$?
    rm -rf "$alias_source_dir"
    exit "$alias_status"
  ); then
    if ! read_file_value "$alias_owner"; then
      child_starting=0
      finish_pending_signal
      fail "created Station launcher '$alias_path' but could not read its ownership record; inspect it manually."
    fi
    case "$file_value" in
      ''|*[!0-9]*)
        child_starting=0
        finish_pending_signal
        fail "created Station launcher '$alias_path' with an invalid ownership record; inspect it manually."
        ;;
    esac
    case "$alias_kind" in
      ingress)
        created_ingress=1
        created_ingress_inode=$file_value
        ;;
      popup)
        created_popup=1
        created_popup_inode=$file_value
        ;;
    esac
    child_starting=0
    finish_pending_signal
    return 0
  fi
  child_starting=0
  finish_pending_signal
  fail "could not create Station launcher '$alias_path'."
}

if [ ! -L "$ingress_path" ]; then
  create_alias "$ingress_path" ingress
fi
if [ ! -L "$popup_path" ]; then
  create_alias "$popup_path" popup
fi

revalidate_managed_paths() {
  if [ -e "$binary_path" ] || [ -L "$binary_path" ]; then
    if [ ! -f "$binary_path" ] || [ -L "$binary_path" ]; then
      fail "Station binary destination '$binary_path' changed during installation; it must remain absent or a regular non-symlink file."
    fi
  fi
  for managed_launcher in "$ingress_path" "$popup_path"; do
    if [ ! -L "$managed_launcher" ] || ! readlink_target "$managed_launcher" 2>/dev/null || [ "$link_target" != stn ]; then
      fail "Station launcher '$managed_launcher' changed during installation; it must remain a symlink exactly targeting 'stn'."
    fi
  done
  if [ -e "$license_path" ] || [ -L "$license_path" ]; then
    if [ ! -f "$license_path" ] || [ -L "$license_path" ]; then
      fail "Station license destination '$license_path' changed during installation; it must remain absent or a regular non-symlink file."
    fi
  fi
}

new_license=$license_stage/LICENSE.new
if ! cp "$extracted_dir/LICENSE" "$new_license"; then
  fail "could not stage the Station license in $license_dir."
fi
chmod 0644 "$new_license" || fail "could not set permissions on the staged Station license."
revalidate_managed_paths
if [ -e "$license_path" ] || [ -L "$license_path" ]; then
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
revalidate_managed_paths
commit_started=1
if mv -f "$install_stage/stn" "$binary_path"; then
  runtime_committed=1
elif [ -e "$install_stage/stn" ] || [ -L "$install_stage/stn" ]; then
  activation_failed_precommit=1
  fail "could not activate the verified Station binary; restoring the previous installation."
else
  runtime_committed=1
  report_activation_ambiguity
  exit 1
fi

set +e
printf 'Installed Station %s to ' "$tag"
print_shell_word "$binary_path"
printf '\n'

path_mismatch=0
check_launcher_resolution() {
  launcher_name=$1
  expected_launcher=$2
  if ! raw_resolved=$(
    command -v "$launcher_name" 2>/dev/null
    resolve_status=$?
    printf x
    exit "$resolve_status"
  ); then
    printf 'PATH mismatch: %s is not available in the current shell.\n' "$launcher_name"
    path_mismatch=1
    return 0
  fi
  raw_resolved=${raw_resolved%x}
  case "$raw_resolved" in
    *"$line_feed") resolved_launcher=${raw_resolved%"$line_feed"} ;;
    *) resolved_launcher=$raw_resolved ;;
  esac
  if { [ -e "$resolved_launcher" ] || [ -L "$resolved_launcher" ]; } && [ "$resolved_launcher" -ef "$expected_launcher" ]; then
    return 0
  fi
  printf 'PATH mismatch: %s resolves to ' "$launcher_name"
  print_shell_word "$resolved_launcher"
  printf ', not the newly installed launcher '
  print_shell_word "$expected_launcher"
  printf '.\n'
  path_mismatch=1
}

check_launcher_resolution stn "$binary_path"
check_launcher_resolution stn-ingress "$ingress_path"
check_launcher_resolution stn-tmux-popup "$popup_path"

if [ "$path_mismatch" -eq 0 ]; then
  printf 'Next: run stn setup\n'
else
  printf 'To use Station in future shells, add this command to your chosen shell configuration:\n'
  printf '  export PATH='
  print_shell_word "$install_dir"
  printf '${PATH:+":$PATH"}\n\n'
  printf 'Run this block in the current shell, then continue setup:\n'
  printf '  PATH='
  print_shell_word "$install_dir"
  printf '${PATH:+":$PATH"}\n'
  printf '  export PATH\n'
  printf '  hash -r\n'
  printf '  stn setup\n'
  printf 'Absolute fallback: '
  print_shell_word "$binary_path"
  printf ' setup\n'
fi
