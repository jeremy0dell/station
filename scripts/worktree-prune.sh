#!/bin/bash
# Removes dead linked worktrees under ~/.worktrees for one checkout. Dry run unless --apply is given.
# A worktree is dead only when every check below passes; any failed or unknown check keeps it.
set -u

usage() { echo "usage: $0 <checkout-path> [--apply]" >&2; exit 2; }
[ $# -ge 1 ] || usage
REPO=$1
APPLY=0
[ "${2:-}" = "--apply" ] && APPLY=1
[ -d "$REPO/.git" ] || [ -f "$REPO/.git" ] || usage

ARCHIVE_ROOT="$HOME/archive/$(hostname -s)-local-$(date -u +%Y%m%d)"
OWNER_REPO=$(git -C "$REPO" remote get-url origin | sed -E 's#^.*[:/]([^/]+/[^/]+)$#\1#; s#\.git$##')
git -C "$REPO" fetch --quiet origin || { echo "fetch failed; nothing removed" >&2; exit 1; }
PANE_PATHS=$(tmux list-panes -a -F '#{pane_current_path}' 2>/dev/null)

git -C "$REPO" worktree list --porcelain | awk '
  /^worktree /{p=substr($0,10)} /^HEAD /{h=substr($0,6)} /^branch /{b=substr($0,8); sub("refs/heads/","",b)}
  /^locked/{l="locked"} /^detached/{b="(detached)"}
  /^$/{ if(p!="") print p"\t"b"\t"h"\t"(l==""?"-":l); p="";b="";h="";l="" }
  END{ if(p!="") print p"\t"b"\t"h"\t"(l==""?"-":l) }' |
while IFS=$'\t' read -r path branch head locked; do
  case "$path" in "$HOME"/.worktrees/*) ;; *) continue;; esac
  reason=""
  [ "$locked" = "-" ] || reason="locked"
  [ -z "$reason" ] && [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ] && reason="uncommitted"
  [ -z "$reason" ] && [ -n "$(find "$path" \( -name .git -o -name node_modules -o -name .local \) -prune -o -type f -mmin -360 -print -quit 2>/dev/null)" ] && reason="changed-6h"
  [ -z "$reason" ] && printf '%s\n' "$PANE_PATHS" | awk -v p="$path" 'index($0,p)==1 && (length($0)==length(p) || substr($0,length(p)+1,1)=="/") {found=1} END{exit !found}' && reason="tmux-pane"
  [ -z "$reason" ] && pgrep -f -- "$path" >/dev/null 2>&1 && reason="process-cwd"
  if [ -z "$reason" ] && ! git -C "$path" merge-base --is-ancestor "$head" origin/main 2>/dev/null; then
    pr_match=no
    if [ "$branch" != "(detached)" ] && [ -n "$branch" ] && gh api "repos/$OWNER_REPO/pulls?state=closed&head=${OWNER_REPO%%/*}:$branch&per_page=10" --jq '.[].head.sha' 2>/dev/null | grep -qx "$head"; then
      pr_match=yes
    fi
    [ "$pr_match" = "yes" ] || reason="head-not-merged"
  fi
  if [ -n "$reason" ]; then
    echo "KEEP   $path [$reason]"
    continue
  fi
  echo "DEAD   $path ($branch)"
  [ "$APPLY" -eq 1 ] || continue
  if [ -d "$path/.local" ] && [ "$(du -sm "$path/.local" | cut -f1)" -gt 50 ]; then
    dest="$ARCHIVE_ROOT/$(basename "$path")/.local"
    mkdir -p "$dest" && rsync -a "$path/.local/" "$dest/" || { echo "  archive failed; keeping $path"; continue; }
    if [ "$(find "$path/.local" | wc -l)" != "$(find "$dest" | wc -l)" ] || [ "$(du -sk "$path/.local" | cut -f1)" != "$(du -sk "$dest" | cut -f1)" ]; then
      echo "  archive verification failed; keeping $path"; continue
    fi
  fi
  git -C "$REPO" worktree remove "$path" && echo "  removed $path"
done
[ "$APPLY" -eq 1 ] && git -C "$REPO" worktree prune
exit 0
