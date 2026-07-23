#!/bin/sh

set -eu
umask 077

repository=jeremy0dell/station
install_dir=${STATION_INSTALL_DIR:-"$HOME/.local/bin"}
gh_bin=${STATION_GH_BIN:-gh}
tmux_bin=${STATION_TMUX_BIN:-tmux}
term_grace=${STATION_NUKE_TERM_GRACE_SECONDS:-2}
assume_yes=0
tmp_dir=""

cleanup() {
  [ -z "$tmp_dir" ] || rm -rf "$tmp_dir"
}
trap cleanup EXIT HUP INT TERM

usage() {
  cat <<'EOF'
Usage: pnpm nuke [-- --yes]

Install the newest published Station release, terminate every process and pane
owned by the installed runtime, refresh integrations, and launch the new TUI.

Options:
  --yes, -y  Skip the destructive confirmation prompt.
  --help     Show this help.
EOF
}

parse_options() {
  for option in "$@"; do
    case "$option" in
      --) ;;
      --yes|-y) assume_yes=1 ;;
      --help|-h) usage; return 10 ;;
      *) printf 'nuke: unknown option: %s\n' "$option" >&2; return 2 ;;
    esac
  done
}

select_newest_release() {
  awk -F '\t' '
    NF == 2 && $1 != "" && $2 ~ /^v[0-9]/ && $1 > newest {
      newest = $1
      tag = $2
    }
    END { if (tag != "") print tag }
  '
}

runtime_role() {
  command_line=$1
  binary_path=$2
  case "$command_line" in
    "$binary_path __observer"|"$binary_path __observer "*) printf 'observer\n' ;;
    "$binary_path __station-host"|"$binary_path __station-host "*) printf 'host\n' ;;
    "$binary_path __tui"|"$binary_path __tui "*) printf 'tui\n' ;;
  esac
}

select_process_targets() {
  process_file=$1
  roots_file=$2
  awk -F '\t' '
    NR == FNR { selected[$1] = 1; next }
    { pid[NR] = $1; parent[NR] = $2 }
    END {
      changed = 1
      while (changed) {
        changed = 0
        for (i in pid) {
          if (!selected[pid[i]] && selected[parent[i]]) {
            selected[pid[i]] = 1
            changed = 1
          }
        }
      }
      for (value in selected) if (selected[value]) print value
    }
  ' "$roots_file" "$process_file" | sort -n
}

line_count() {
  awk 'END { print NR + 0 }' "$1"
}

select_station_tmux_panes() {
  awk -F '\t' '$5 == "0" && $6 != "" && $7 != "" && $8 != "" { print $1 "\t" $2 "\t" $3 "\t" $4 }'
}

native_pty_count() {
  awk -F '\t' '
    NR == FNR { hosts[$1] = 1; next }
    hosts[$2] { count += 1 }
    END { print count + 0 }
  ' "$host_roots" "$processes"
}

print_scope() {
  native_count=$(native_pty_count)
  tmux_count=$(line_count "$tmux_panes")
  tui_count=$(awk -F '\t' '$2 == "tui" || $2 == "tui-launcher" || $2 == "tmux-ui" { count += 1 } END { print count + 0 }' "$roots")
  host_count=$(line_count "$host_roots")
  observer_count=$(awk -F '\t' '$2 == "observer" { count += 1 } END { print count + 0 }' "$roots")
  printf 'Station nuke will install %s and terminate:\n' "$tag"
  printf '  %s native PTY process tree(s)\n' "$native_count"
  printf '  %s Station-bound tmux pane(s)\n' "$tmux_count"
  printf '  %s Station TUI process/session root(s)\n' "$tui_count"
  printf '  %s Host(s) and %s Observer(s)\n\n' "$host_count" "$observer_count"
  printf 'Worktrees, repositories, configuration, logs, and session records remain.\n'
  printf 'Live agents, shells, panes, and terminal contents will be permanently ended.\n'
  printf 'They are not moved or preserved; the new production TUI opens afterward.\n'
}

confirm_destruction() {
  [ "$assume_yes" -eq 0 ] || return 0
  if [ "${STATION_NUKE_TEST_TTY:-0}" != 1 ] && [ ! -t 0 ]; then
    printf 'nuke: confirmation requires an interactive terminal; rerun with --yes.\n' >&2
    return 2
  fi
  printf '\nContinue? [y/N] '
  answer=""
  IFS= read -r answer || true
  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) printf 'Station nuke cancelled.\n'; return 3 ;;
  esac
}

launch_installed_binary() {
  binary_path=$1
  shift
  exec "$binary_path" "$@"
}

collect_census() {
  : > "$processes"
  : > "$roots"
  : > "$host_roots"
  : > "$sockets"
  : > "$tmux_panes"
  : > "$tmux_ui_sessions"

  ps -axo pid=,ppid=,command= | awk '
    {
      pid = $1; ppid = $2
      sub(/^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+/, "")
      printf "%s\t%s\t%s\n", pid, ppid, $0
    }
  ' > "$processes"

  # Internal roles are exact argv boundaries; Observer and host roots must also own a Unix socket.
  while IFS="$(printf '\t')" read -r pid ppid command_line; do
    role=$(runtime_role "$command_line" "$binary")
    if [ -z "$role" ] && { [ "$command_line" = stn ] || [ "$command_line" = "$binary" ]; }; then
      executable=$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | awk '/^n\// { print substr($0, 2); exit }')
      [ "$executable" = "$binary" ] && role=tui-launcher
    fi
    [ -n "$role" ] || continue
    if [ "$role" = tui ] || [ "$role" = tui-launcher ]; then
      printf '%s\t%s\n' "$pid" "$role" >> "$roots"
      continue
    fi
    owned_sockets=$(lsof -a -p "$pid" -U -Fn 2>/dev/null | awk '/^n\// && /\.sock$/ { print substr($0, 2) }' | sort -u)
    [ -n "$owned_sockets" ] || continue
    printf '%s\t%s\n' "$pid" "$role" >> "$roots"
    [ "$role" != host ] || printf '%s\n' "$pid" >> "$host_roots"
    printf '%s\n' "$owned_sockets" >> "$sockets"
  done < "$processes"

  command -v "$tmux_bin" >/dev/null 2>&1 || return 0
  "$tmux_bin" list-panes -a -F '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{@station.session_id}\t#{@station.project_id}\t#{@station.worktree_id}' 2>/dev/null |
    select_station_tmux_panes > "$tmux_panes"
  while IFS="$(printf '\t')" read -r session window pane pane_pid; do
    [ -n "$pane_pid" ] || continue
    printf '%s\ttmux-pane\n' "$pane_pid" >> "$roots"
  done < "$tmux_panes"

  "$tmux_bin" list-sessions -F '#{session_name}' 2>/dev/null | while IFS= read -r session; do
    signature=$("$tmux_bin" show-options -t "$session" -qv @station_popup_ui_signature 2>/dev/null || true)
    [ -n "$signature" ] || continue
    printf '%s\n' "$session" >> "$tmux_ui_sessions"
    "$tmux_bin" list-panes -t "$session" -F '#{pane_pid}' 2>/dev/null | while IFS= read -r pane_pid; do
      [ -z "$pane_pid" ] || printf '%s\ttmux-ui\n' "$pane_pid" >> "$roots"
    done
  done
}

if [ "${STATION_NUKE_SOURCE_ONLY:-0}" = 1 ]; then
  return 0 2>/dev/null || exit 0
fi

option_status=0
parse_options "$@" || option_status=$?
case "$option_status" in
  0) ;;
  10) exit 0 ;;
  *) exit "$option_status" ;;
esac

case "$install_dir" in
  /*) ;;
  *) printf 'nuke: install directory must be absolute: %s\n' "$install_dir" >&2; exit 1 ;;
esac

for command in "$gh_bin" lsof ps awk sort kill sleep mktemp sh; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'nuke: required command not found: %s\n' "$command" >&2
    exit 1
  }
done

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/station-nuke.XXXXXX")
releases=$tmp_dir/releases.tsv
installer=$tmp_dir/install.sh
processes=$tmp_dir/processes.tsv
roots=$tmp_dir/roots.tsv
host_roots=$tmp_dir/host-roots
targets=$tmp_dir/targets
sockets=$tmp_dir/sockets
tmux_panes=$tmp_dir/tmux-panes
tmux_ui_sessions=$tmp_dir/tmux-ui-sessions
binary=$install_dir/stn

"$gh_bin" api --paginate "repos/$repository/releases?per_page=100" \
  --jq '.[] | select(.draft == false and .published_at != null) | [.published_at, .tag_name] | @tsv' \
  > "$releases"
tag=$(select_newest_release < "$releases")
[ -n "$tag" ] || {
  printf 'nuke: no published Station release was found\n' >&2
  exit 1
}
version=${tag#v}
collect_census
print_scope
confirmation_status=0
confirm_destruction || confirmation_status=$?
case "$confirmation_status" in
  0) ;;
  3) exit 0 ;;
  *) exit "$confirmation_status" ;;
esac

# Fetch installer code and release assets from the same immutable release before stopping anything.
"$gh_bin" api --method GET -H 'Accept: application/vnd.github.raw+json' -f ref="$tag" \
  "repos/$repository/contents/scripts/install.sh" > "$installer"
[ -s "$installer" ]
sh -n "$installer"
sh "$installer" --version "$tag" --install-dir "$install_dir"

[ -x "$binary" ] || {
  printf 'nuke: installer did not create executable %s\n' "$binary" >&2
  exit 1
}
installed_version=$($binary --version)
[ "$installed_version" = "$version" ] || {
  printf 'nuke: installed CLI reports %s, expected %s\n' "$installed_version" "$version" >&2
  exit 1
}

# Refresh exact ownership after the download; no runtime process has been stopped yet.
collect_census
select_process_targets "$processes" "$roots" > "$targets"
printf 'NUKE: exact processes selected for termination:\n'
while IFS= read -r pid; do
  awk -F '\t' -v selected="$pid" '$1 == selected { printf "  pid %s (ppid %s): %s\n", $1, $2, $3 }' "$processes"
done < "$targets"
while IFS="$(printf '\t')" read -r session window pane pane_pid; do
  printf '  tmux pane %s in %s/%s (pid %s)\n' "$pane" "$session" "$window" "$pane_pid"
done < "$tmux_panes"
while IFS= read -r session; do
  printf '  signed tmux UI session %s\n' "$session"
done < "$tmux_ui_sessions"

signal_captured_processes() {
  signal=$1
  while IFS= read -r pid; do
    expected=$(awk -F '\t' -v selected="$pid" '$1 == selected { print $3; exit }' "$processes")
    actual=$(ps -ww -p "$pid" -o command= 2>/dev/null || true)
    [ -n "$expected" ] && [ "$actual" = "$expected" ] || continue
    kill "-$signal" "$pid" 2>/dev/null || true
  done < "$targets"
}

if [ -s "$targets" ]; then
  # Rechecking exact argv before each signal prevents PID reuse from crossing the ownership boundary.
  signal_captured_processes TERM
  sleep "$term_grace"
  signal_captured_processes KILL
fi

# Pane and session selectors came from Station identity/signature options, never names alone.
while IFS="$(printf '\t')" read -r session window pane pane_pid; do
  "$tmux_bin" kill-pane -t "$pane" 2>/dev/null || true
done < "$tmux_panes"
while IFS= read -r session; do
  "$tmux_bin" kill-session -t "$session" 2>/dev/null || true
done < "$tmux_ui_sessions"

sort -u "$sockets" | while IFS= read -r socket; do
  [ -n "$socket" ] || continue
  if [ -S "$socket" ] && [ -z "$(lsof -t "$socket" 2>/dev/null || true)" ]; then
    rm -f "$socket" "$socket.pid"
  elif [ ! -e "$socket" ]; then
    rm -f "$socket.pid"
  fi
done

# Existing setup owns launcher, hook, and popup-binding refresh semantics.
"$binary" setup apply --yes
"$binary" observer start
snapshot=$($binary snapshot --json)
printf '%s\n' "$snapshot" | grep -F '"version": '"\"$installed_version\"" >/dev/null || {
  printf 'nuke: Observer version does not exactly match installed CLI %s\n' "$installed_version" >&2
  exit 1
}
printf 'NUKE: Observer and CLI both report %s; launching %s.\n' "$installed_version" "$binary"
trap - EXIT HUP INT TERM
cleanup
launch_installed_binary "$binary"
