import { type HookSetupErrorClass, hookSetupErrorClass } from "@station/harness-shared";

export type CodexHookSetupErrorCode =
  | "CODEX_HOOK_CONFIG_UNREADABLE"
  | "CODEX_HOOK_INVALID_TOML"
  | "CODEX_HOOK_RECONCILIATION_CANCELLED"
  | "CODEX_HOOK_RECONCILIATION_OWNER_REQUIRED"
  | "CODEX_HOOK_RECONCILIATION_TIMEOUT"
  | "CODEX_HOOK_RECONCILIATION_LOCK_FAILED"
  | "CODEX_HOOK_RECONCILIATION_LOCK_RELEASE_FAILED"
  | "CODEX_HOOK_WRITE_FAILED";

// Annotated so declaration emit names the class type instead of a deep package path.
export const CodexHookSetupError: HookSetupErrorClass<CodexHookSetupErrorCode> =
  hookSetupErrorClass({
    tag: "CodexHookSetupError",
    provider: "codex",
  });

// The lock helpers annotate their return type, which a class expression does not name on its own.
export type CodexHookSetupErrorInstance = InstanceType<typeof CodexHookSetupError>;
