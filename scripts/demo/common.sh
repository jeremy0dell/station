#!/usr/bin/env bash

canonicalize_demo_root() {
  local path="$1" suffix="" leaf
  case "/$path/" in
    */./*|*/../*)
      echo "Demo root must not contain '.' or '..' path components: $path" >&2
      return 1
      ;;
  esac
  case "$path" in
    /*) ;;
    *) path="$PWD/$path" ;;
  esac
  while [ ! -e "$path" ]; do
    leaf="$(basename "$path")"
    suffix="/$leaf$suffix"
    path="$(dirname "$path")"
  done
  if [ -d "$path" ]; then
    path="$(cd "$path" && pwd -P)"
  else
    path="$(cd "$(dirname "$path")" && pwd -P)/$(basename "$path")"
  fi
  printf '%s%s\n' "$path" "$suffix"
}

require_toml_safe_value() {
  local label="$1" value="$2"
  case "$value" in
    *\\*|*\"*|*$'\n'*|*$'\r'*)
      echo "$label contains a quote, backslash, or newline that cannot be written safely to demo config." >&2
      return 1
      ;;
  esac
}
