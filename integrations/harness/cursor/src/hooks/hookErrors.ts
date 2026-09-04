import { type HookSetupErrorClass, hookSetupErrorClass } from "@station/harness-shared";

export type CursorHookSetupErrorCode =
  | "CURSOR_HOOK_CONFIG_UNREADABLE"
  | "CURSOR_HOOK_INVALID_JSON"
  | "CURSOR_HOOK_WRITE_FAILED";

export const CursorHookSetupError: HookSetupErrorClass<CursorHookSetupErrorCode> =
  hookSetupErrorClass({
    tag: "CursorHookSetupError",
    provider: "cursor",
  });
