export type CursorHookEventName = (typeof CURSOR_HOOK_EVENT_NAMES)[number];

export const CURSOR_HOOKS_FILE = "hooks.json";
export const GENERATED_HOOK_SCRIPT_NAME = "station-cursor-hook.sh";

export const CURSOR_HOOK_EVENT_NAMES = [
  "sessionStart",
  "stop",
  "sessionEnd",
  "beforeShellExecution",
  "afterShellExecution",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
] as const;
