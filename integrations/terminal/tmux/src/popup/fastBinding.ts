import { isAbsolute, join } from "node:path";
import { shellQuote } from "../shell.js";
import {
  activePopupClaimOption,
  activePopupClientOption,
  defaultPersistentPopupSessionName,
  focusPopupClientOption,
  persistentUiLeaseOption,
  persistentUiRouteOption,
  persistentUiSignatureOption,
  registeredDevPopupCommandOption,
  registeredDevPopupOwnerOption,
  registeredDevPopupRootOption,
  registeredDevPopupSessionNameOption,
  registeredPopupExpectedSignatureOption,
  registeredPopupRootOption,
  registeredPopupSessionNameOption,
} from "./constants.js";
import { popupProtocolSha256 } from "./fastProtocol.js";
import { persistentPopupSignature } from "./persistentUi.js";

export type BuildManagedFastPopupRunShellCommandOptions = {
  configPath?: string;
  fallbackAlias: string;
  installedRoot: string;
  tmuxCommand: string;
};

function containsUnsafeShellValue(value: string): boolean {
  return (
    value.includes("\0") || value.includes("\r") || value.includes("\n") || value.includes("\u001f")
  );
}

function validateManagedBindingOptions(options: BuildManagedFastPopupRunShellCommandOptions): void {
  if (
    !isAbsolute(options.installedRoot) ||
    options.installedRoot === "/" ||
    containsUnsafeShellValue(options.installedRoot)
  ) {
    throw new Error("Station popup ownership requires a safe canonical installed root.");
  }
  if (
    options.fallbackAlias !== join(options.installedRoot, "stn-tmux-popup") ||
    containsUnsafeShellValue(options.fallbackAlias)
  ) {
    throw new Error("Station popup fallback must be the installed stn-tmux-popup sibling alias.");
  }
  if (!isAbsolute(options.tmuxCommand) || containsUnsafeShellValue(options.tmuxCommand)) {
    throw new Error("Station popup binding requires a safe resolved tmux executable.");
  }
  if (
    options.configPath !== undefined &&
    (!isAbsolute(options.configPath) || containsUnsafeShellValue(options.configPath))
  ) {
    throw new Error("Station popup binding requires a safe absolute config path.");
  }
}

function snapshotFormat(): string {
  const fields = [
    persistentUiRouteOption,
    persistentUiLeaseOption,
    activePopupClaimOption,
    persistentUiSignatureOption,
    registeredPopupSessionNameOption,
    registeredPopupExpectedSignatureOption,
    registeredPopupRootOption,
    activePopupClientOption,
    focusPopupClientOption,
    registeredDevPopupSessionNameOption,
    registeredDevPopupCommandOption,
    registeredDevPopupOwnerOption,
    registeredDevPopupRootOption,
  ].map((name) => `\${fmt}{${name}}`);
  fields.push("v1");
  return fields.join(`\${sep}`);
}

function encodePrintfScript(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

function escapeTmuxFormat(value: string): string {
  return value.replaceAll("#", "##");
}

function expectedPersistentPopupSignature(options: {
  configPath?: string;
  installedRoot: string;
}): string {
  const command = [
    shellQuote(join(options.installedRoot, "stn")),
    ...(options.configPath === undefined ? [] : ["--config", shellQuote(options.configPath)]),
    "tui",
    "--popup",
    "--persistent",
  ].join(" ");
  return persistentPopupSignature(command);
}

/**
 * ADAPTER
 *
 * Translates an installed popup owner into a silent tmux warm-path command that falls back to
 * the exact compiled alias whenever its versioned route cannot be acted on safely.
 */
export function buildManagedFastPopupRunShellCommand(
  options: BuildManagedFastPopupRunShellCommandOptions,
): string {
  validateManagedBindingOptions(options);

  const sessionName = defaultPersistentPopupSessionName;
  const expectedRootSha256 = popupProtocolSha256(options.installedRoot);
  const expectedSessionSha256 = popupProtocolSha256(sessionName);
  const expectedSignatureSha256 = popupProtocolSha256(expectedPersistentPopupSignature(options));
  const installedRoot = escapeTmuxFormat(options.installedRoot);
  const fallbackAlias = escapeTmuxFormat(options.fallbackAlias);
  const configPath = escapeTmuxFormat(options.configPath ?? "");
  const tmuxCommand = escapeTmuxFormat(options.tmuxCommand);
  const nestedTmuxCommand = escapeTmuxFormat(tmuxCommand);
  const attachCommand = [
    "env -u TMUX",
    shellQuote(nestedTmuxCommand),
    "-T hyperlinks attach-session -t",
    shellQuote(sessionName),
  ].join(" ");

  const script = `
set +e
set -f
binding_client_name=$1
binding_client_pid=$2
binding_client_session=$3
tmux_bin=${shellQuote(tmuxCommand)}
fallback_alias=${shellQuote(fallbackAlias)}
config_path=${shellQuote(configPath)}
installed_root=${shellQuote(installedRoot)}
session_name=${shellQuote(sessionName)}
expected_root_sha=${shellQuote(expectedRootSha256)}
expected_session_sha=${shellQuote(expectedSessionSha256)}
expected_signature_sha=${shellQuote(expectedSignatureSha256)}
attach_arg=${shellQuote(shellQuote(attachCommand))}
fmt='#'
sep=$(printf '\\037')
trap 'exit 0' HUP INT TERM

fallback_popup() {
  fallback_client_name=\${client_name:-$binding_client_name}
  if [ -n "$config_path" ]; then
    if valid_client_name "$fallback_client_name"; then
      STATION_CONFIG_PATH=$config_path STATION_FOCUS_CLIENT_ID=$fallback_client_name "$fallback_alias" --config "$config_path" >/dev/null 2>&1
    else
      STATION_CONFIG_PATH=$config_path "$fallback_alias" --config "$config_path" >/dev/null 2>&1
    fi
  elif valid_client_name "$fallback_client_name"; then
    STATION_FOCUS_CLIENT_ID=$fallback_client_name "$fallback_alias" >/dev/null 2>&1
  else
    "$fallback_alias" >/dev/null 2>&1
  fi
  fallback_status=$?
  case "$fallback_status" in
    0|129) return 0 ;;
  esac
  "$tmux_bin" display-message -d 3000 'Station popup failed; run stn popup for details' >/dev/null 2>&1 || :
  return 0
}

valid_nonce() {
  [ "\${#1}" -eq 32 ] || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
  return 0
}

valid_client_pid() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "\${#1}" -le 10 ] || return 1
  case "$1" in 0*) return 1 ;; esac
  [ "$1" -gt 0 ] 2>/dev/null || return 1
  [ "$1" -le 2147483647 ] 2>/dev/null || return 1
  return 0
}

valid_client_name() {
  [ -n "$1" ] && [ "\${#1}" -le 128 ] || return 1
  case "$1" in *[!A-Za-z0-9_/@%+=:-]*) return 1 ;; esac
  return 0
}

sha256_value() {
  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(printf '%s' "$1" | sha256sum 2>/dev/null) || return 1
  elif command -v shasum >/dev/null 2>&1; then
    digest=$(printf '%s' "$1" | shasum -a 256 2>/dev/null) || return 1
  else
    return 1
  fi
  set -- $digest
  [ "\${#1}" -eq 64 ] || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
  printf '%s' "$1"
}

dev_registration_is_live() {
  [ -n "$dev_session$dev_command$dev_owner$dev_root" ] || return 1
  owner_pid=\${dev_owner%%:*}
  case "$owner_pid" in ''|*[!0-9]*) return 0 ;; esac
  [ "$owner_pid" -gt 0 ] 2>/dev/null || return 0
  if kill -0 "$owner_pid" 2>/dev/null; then
    return 0
  fi
  # A denied signal probe is inconclusive; only a working process table may prove absence.
  command -v ps >/dev/null 2>&1 || return 0
  ps -p "$$" -o pid= >/dev/null 2>&1 || return 0
  ps -p "$owner_pid" -o pid= >/dev/null 2>&1
}

parse_route() {
  old_ifs=$IFS
  IFS=.
  set -- $route
  IFS=$old_ifs
  [ "$#" -eq 6 ] || return 1
  [ "$1" = v1 ] && [ "$2" = n ] || return 1
  [ "$3" = "$expected_root_sha" ] || return 1
  [ "$4" = "$expected_session_sha" ] || return 1
  [ "$5" = "$registered_signature_sha" ] || return 1
  valid_nonce "$6" || return 1
  registration_nonce=$6
  return 0
}

parse_claim() {
  claim_state=
  claim_registration_nonce=
  claim_action_nonce=
  claim_client_pid=
  claim_client_name=
  [ -n "$claim" ] || return 0
  old_ifs=$IFS
  IFS=.
  set -- $claim
  IFS=$old_ifs
  [ "$#" -eq 6 ] || return 1
  [ "$1" = v1 ] || return 1
  case "$2" in open|closing) claim_state=$2 ;; *) return 1 ;; esac
  valid_nonce "$3" || return 1
  valid_nonce "$4" || return 1
  valid_client_pid "$5" || return 1
  valid_client_name "$6" || return 1
  claim_registration_nonce=$3
  claim_action_nonce=$4
  claim_client_pid=$5
  claim_client_name=$6
  return 0
}

clear_exact_claim() {
  exact_claim=$1
  exact_client=$2
  clear_condition="\${fmt}{==:\${fmt}{${activePopupClaimOption}},$exact_claim}"
  clear_commands="set-option -gq -u ${activePopupClaimOption} ; if-shell -F \\"\${fmt}{==:\${fmt}{${activePopupClientOption}},$exact_client}\\" \\"set-option -gq -u ${activePopupClientOption}\\" ; if-shell -F \\"\${fmt}{==:\${fmt}{${focusPopupClientOption}},$exact_client}\\" \\"set-option -gq -u ${focusPopupClientOption}\\""
  "$tmux_bin" if-shell -F -t "$session_name:" "$clear_condition" "$clear_commands" >/dev/null 2>&1 || :
}

run_action() {
  expected_claim=$1
  new_claim=$2
  action_kind=$3
  previous_client=$4
  action_condition="\${fmt}{&&:\${fmt}{==:\${fmt}{${persistentUiRouteOption}},$route},\${fmt}{&&:\${fmt}{==:\${fmt}{${persistentUiLeaseOption}},$route},\${fmt}{==:\${fmt}{${activePopupClaimOption}},$expected_claim}}}"
  clear_condition="\${fmt}{==:\${fmt}{${activePopupClaimOption}},$new_claim}"
  clear_commands="set-option -gq -u ${activePopupClaimOption} ; if-shell -F \\"\${fmt}{==:\${fmt}{${activePopupClientOption}},$claim_target_client}\\" \\"set-option -gq -u ${activePopupClientOption}\\" ; if-shell -F \\"\${fmt}{==:\${fmt}{${focusPopupClientOption}},$claim_target_client}\\" \\"set-option -gq -u ${focusPopupClientOption}\\""
  finish="if-shell -F '$clear_condition' '$clear_commands'"
  prefix="set-option -gq ${activePopupClaimOption} $new_claim ; set-option -gq ${activePopupClientOption} $claim_target_client ; set-option -gq ${focusPopupClientOption} $claim_target_client"
  case "$action_kind" in
    open)
      action="$prefix ; set-option -t $session_name mouse on ; display-popup -c $client_name -w 50% -h 50% -E $attach_arg ; $finish"
      ;;
    replace)
      action="$prefix ; display-popup -c $previous_client -C ; set-option -t $session_name mouse on ; display-popup -c $client_name -w 50% -h 50% -E $attach_arg ; $finish"
      ;;
    close)
      action="$prefix ; display-popup -c $previous_client -C ; $finish"
      ;;
    *) return 1 ;;
  esac
  action_output=$("$tmux_bin" if-shell -F -t "$session_name:" "$action_condition" "$action" 'display-message -p STATION_POPUP_CAS_MISS' 2>/dev/null)
  action_status=$?
  if [ "$action_output" = STATION_POPUP_CAS_MISS ]; then
    return 2
  fi
  case "$action_status" in
    0|129) return 0 ;;
  esac
  clear_exact_claim "$new_claim" "$claim_target_client"
  return 1
}

try_fast_popup() {
  valid_client_name "$binding_client_name" || return 1
  valid_client_pid "$binding_client_pid" || return 1
  [ -n "$binding_client_session" ] && [ "\${#binding_client_session}" -le 256 ] || return 1
  snapshot_format="${snapshotFormat()}"
  snapshot=$("$tmux_bin" display-message -p -t "$session_name:" "$snapshot_format" 2>/dev/null) || return 1
  old_ifs=$IFS
  IFS="$sep"
  set -- $snapshot
  IFS=$old_ifs
  [ "$#" -eq 14 ] || return 1
  route=$1
  lease=$2
  claim=$3
  session_signature=$4
  registered_session=$5
  registered_signature=$6
  registered_root=$7
  active_client=$8
  focus_client=$9
  shift 9
  dev_session=$1
  dev_command=$2
  dev_owner=$3
  dev_root=$4
  snapshot_version=$5
  [ "$snapshot_version" = v1 ] || return 1
  client_pid=$binding_client_pid
  client_name=$binding_client_name
  client_session=$binding_client_session

  if dev_registration_is_live; then
    return 1
  fi
  [ -n "$route" ] && [ "$lease" = "$route" ] || return 1
  [ "$session_signature" = "$registered_signature" ] || return 1
  [ "\${#registered_signature}" -le 4096 ] || return 1
  case "$registered_signature" in v2:*) ;; *) return 1 ;; esac
  registered_signature_sha=$(sha256_value "$registered_signature") || return 1
  [ "$registered_signature_sha" = "$expected_signature_sha" ] || return 1
  parse_route || return 1
  [ "$registered_session" = "$session_name" ] || return 1
  [ "$registered_root" = "$installed_root" ] || return 1
  parse_claim || return 1

  if [ -z "$claim" ]; then
    [ -z "$active_client$focus_client" ] || return 1
  else
    [ "$claim_registration_nonce" = "$registration_nonce" ] || return 1
    [ "$active_client" = "$claim_client_name" ] || return 1
    [ "$focus_client" = "$claim_client_name" ] || return 1
    [ "$claim_state" = open ] || return 2
  fi

  action_nonce=$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
  valid_nonce "$action_nonce" || return 1

  if [ -n "$claim" ] && { [ "$claim_client_pid" = "$client_pid" ] && [ "$claim_client_name" = "$client_name" ]; }; then
    claim_target_client=$claim_client_name
    next_claim="v1.closing.$registration_nonce.$action_nonce.$claim_client_pid.$claim_client_name"
    run_action "$claim" "$next_claim" close "$claim_client_name"
    return $?
  fi
  if [ -n "$claim" ] && [ "$client_session" = "$session_name" ]; then
    claim_target_client=$claim_client_name
    next_claim="v1.closing.$registration_nonce.$action_nonce.$claim_client_pid.$claim_client_name"
    run_action "$claim" "$next_claim" close "$claim_client_name"
    return $?
  fi

  claim_target_client=$client_name
  next_claim="v1.open.$registration_nonce.$action_nonce.$client_pid.$client_name"
  if [ -n "$claim" ]; then
    run_action "$claim" "$next_claim" replace "$claim_client_name"
  else
    run_action '' "$next_claim" open ''
  fi
}

attempt=1
while [ "$attempt" -le 2 ]; do
  try_fast_popup
  fast_status=$?
  case "$fast_status" in
    0) exit 0 ;;
    2) attempt=$((attempt + 1)); continue ;;
    *) break ;;
  esac
done
fallback_popup
exit 0
`.trim();

  const loader = `trap 'exit 0' HUP INT TERM; encoded_script=$1; shift; eval "$(printf '%b' "$encoded_script")"; exit 0`;
  return `sh -c ${shellQuote(loader)} station-popup-binding ${shellQuote(encodePrintfScript(script))} #{q:client_name} #{client_pid} #{q:client_session} >/dev/null 2>&1`;
}
