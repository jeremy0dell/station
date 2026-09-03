import { type HookSetupErrorClass, hookSetupErrorClass } from "@station/harness-shared";

export type ClaudeHookSetupErrorCode =
  | "CLAUDE_HOOK_CONFIG_UNREADABLE"
  | "CLAUDE_HOOK_INVALID_JSON"
  | "CLAUDE_HOOK_WRITE_FAILED";

// Annotated so declaration emit names the class type instead of a deep package path.
export const ClaudeHookSetupError: HookSetupErrorClass<ClaudeHookSetupErrorCode> =
  hookSetupErrorClass({
    tag: "ClaudeHookSetupError",
    provider: "claude",
  });
