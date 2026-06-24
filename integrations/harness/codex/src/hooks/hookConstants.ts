export const CODEX_STATION_PROFILE_NAME = "station";
export const CODEX_STATION_PROFILE_CONFIG_FILE = "station.config.toml";
export const CODEX_BASE_CONFIG_FILE = "config.toml";
export const GENERATED_HOOK_STATUS_MESSAGE = "Notify station";
export const GENERATED_HOOK_SCRIPT_NAME = "station-codex-hook.sh";

export const CODEX_HOOK_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;

export type CodexHookEventName = (typeof CODEX_HOOK_EVENT_NAMES)[number];
