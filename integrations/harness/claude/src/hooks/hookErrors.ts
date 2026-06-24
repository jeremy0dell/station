export type ClaudeHookSetupErrorCode =
  | "CLAUDE_HOOK_CONFIG_UNREADABLE"
  | "CLAUDE_HOOK_INVALID_JSON"
  | "CLAUDE_HOOK_WRITE_FAILED";

export class ClaudeHookSetupError extends Error {
  readonly tag = "ClaudeHookSetupError";
  readonly code: ClaudeHookSetupErrorCode;
  readonly provider = "claude";

  constructor(code: ClaudeHookSetupErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    Object.defineProperty(this, "name", {
      value: this.tag,
      enumerable: false,
      configurable: true,
    });
    this.code = code;
  }
}
