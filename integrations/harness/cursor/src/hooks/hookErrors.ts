import { type HookSetupErrorClass, hookSetupErrorClass } from "@station/harness-shared";

export type CursorHookSetupErrorCode =
  | "CURSOR_HOOK_CONFIG_UNREADABLE"
  | "CURSOR_HOOK_INVALID_JSON"
  | "CURSOR_HOOK_WRITE_FAILED";

// Annotated so declaration emit names the class type instead of a deep package path.
export const CursorHookSetupError: HookSetupErrorClass<CursorHookSetupErrorCode> =
  hookSetupErrorClass({
    tag: "CursorHookSetupError",
    provider: "cursor",
  });
