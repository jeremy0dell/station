import { type HookSetupErrorClass, hookSetupErrorClass } from "@station/harness-shared";

export type ClaudeHookSetupErrorCode =
  | "CLAUDE_HOOK_CONFIG_UNREADABLE"
  | "CLAUDE_HOOK_INVALID_JSON"
  | "CLAUDE_HOOK_WRITE_FAILED";

export const ClaudeHookSetupError: HookSetupErrorClass<ClaudeHookSetupErrorCode> =
  hookSetupErrorClass({
    tag: "ClaudeHookSetupError",
    provider: "claude",
  });
