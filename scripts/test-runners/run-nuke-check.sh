#!/bin/sh

set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
nuke=$repo_root/scripts/maintenance/nuke.sh
tmp=$(mktemp -d "${TMPDIR:-/tmp}/station-nuke-check.XXXXXX")
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT HUP INT TERM

STATION_NUKE_SOURCE_ONLY=1 . "$nuke"

selected=$(cat <<'EOF' | select_newest_release
2028-07-20T03:09:21Z	v8.0.0-rc.1
2028-06-30T21:41:00Z	v7.9.0
2028-07-23T02:15:17Z	v8.0.0-rc.3
2028-07-22T15:35:45Z	v8.0.0-rc.2
EOF
)
[ "$selected" = v8.0.0-rc.3 ] || {
  printf 'release selection failed: %s\n' "$selected" >&2
  exit 1
}

[ "$(runtime_role '/opt/station/stn __observer --socket /tmp/observer.sock' /opt/station/stn)" = observer ]
[ "$(runtime_role '/opt/station/stn __station-host --socket /tmp/host.sock' /opt/station/stn)" = host ]
[ "$(runtime_role '/opt/station/stn __tui' /opt/station/stn)" = tui ]
[ -z "$(runtime_role '/opt/station/stn --version' /opt/station/stn)" ]
[ -z "$(runtime_role '/opt/station/stn-helper __observer' /opt/station/stn)" ]

cat > "$tmp/processes" <<'EOF'
100	1	/opt/station/stn __observer --socket /tmp/observer.sock
110	100	/opt/station/stn __station-host --socket /tmp/station-host.sock
120	110	codex
130	120	/bin/zsh
140	110	/bin/zsh
200	1	unrelated-server
210	200	unrelated-child
300	1	/opt/station/stn --version
400	1	/opt/station/stn __tui
EOF
cat > "$tmp/roots" <<'EOF'
100	observer
110	host
400	tui
EOF
cat > "$tmp/host-roots" <<'EOF'
110
EOF
processes=$tmp/processes
roots=$tmp/roots
host_roots=$tmp/host-roots
select_process_targets "$processes" "$roots" > "$tmp/targets"
printf '%s\n' 100 110 120 130 140 400 > "$tmp/expected"
cmp "$tmp/expected" "$tmp/targets"
[ "$(native_pty_count)" = 2 ]
if grep -Eq '^(200|210|300)$' "$tmp/targets"; then
  printf 'process boundary selected an unrelated process\n' >&2
  exit 1
fi

printf '%s\n' \
  'station-workbench	@1	%1	501	0	ses_one	project	worktree' \
  'station-workbench	@1	%2	502	0	ses_one	project	worktree' \
  'ordinary	@2	%3	503	0			' \
  'partial	@3	%4	504	0	ses_two	project	' \
  'stale	@4	%5	505	1	ses_three	project	worktree' \
  > "$tmp/tmux-input"
select_station_tmux_panes < "$tmp/tmux-input" > "$tmp/tmux-panes"
printf 'station-workbench\t@1\t%%1\t501\nstation-workbench\t@1\t%%2\t502\n' > "$tmp/expected-tmux"
cmp "$tmp/expected-tmux" "$tmp/tmux-panes"

tmux_panes=$tmp/tmux-panes
tmux_ui_sessions=$tmp/tmux-ui
sockets=$tmp/sockets
: > "$tmux_ui_sessions"
: > "$sockets"
tag=v8.0.0-rc.3
scope=$(print_scope)
printf '%s\n' "$scope" | grep -F '2 native PTY process tree(s)' >/dev/null
printf '%s\n' "$scope" | grep -F '2 Station-bound tmux pane(s)' >/dev/null
printf '%s\n' "$scope" | grep -F 'They are not moved or preserved' >/dev/null

assume_yes=0
confirmation_status=0
confirm_destruction </dev/null >/dev/null 2> "$tmp/noninteractive-error" || confirmation_status=$?
[ "$confirmation_status" = 2 ]
grep -F 'rerun with --yes' "$tmp/noninteractive-error" >/dev/null

confirmation_status=0
printf 'n\n' | STATION_NUKE_TEST_TTY=1 confirm_destruction > "$tmp/cancel-output" || confirmation_status=$?
[ "$confirmation_status" = 3 ]
grep -F 'Station nuke cancelled.' "$tmp/cancel-output" >/dev/null
printf 'y\n' | STATION_NUKE_TEST_TTY=1 confirm_destruction >/dev/null

assume_yes=0
parse_options -- --yes
[ "$assume_yes" = 1 ]
confirm_destruction </dev/null >/dev/null
if parse_options --unknown >/dev/null 2>&1; then
  printf 'unknown nuke option was accepted\n' >&2
  exit 1
fi

mkdir -p "$tmp/bin"
cat > "$tmp/bin/stn" <<'EOF'
#!/bin/sh
printf '%s\n' "$0 $*" > "$STATION_NUKE_EXEC_LOG"
EOF
chmod +x "$tmp/bin/stn"
STATION_NUKE_EXEC_LOG=$tmp/exec.log
export STATION_NUKE_EXEC_LOG
(
  STATION_NUKE_SOURCE_ONLY=1 . "$nuke"
  launch_installed_binary "$tmp/bin/stn" tui-check
)
[ "$(cat "$tmp/exec.log")" = "$tmp/bin/stn tui-check" ] || {
  printf 'final binary execution did not use the exact installed path\n' >&2
  exit 1
}

printf 'nuke check passed: confirmation, scope, boundaries, and final exec\n'
