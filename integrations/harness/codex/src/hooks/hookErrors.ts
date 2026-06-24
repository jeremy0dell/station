export type CodexHookSetupErrorCode =
  | "CODEX_HOOK_CONFIG_UNREADABLE"
  | "CODEX_HOOK_INVALID_TOML"
  | "CODEX_HOOK_WRITE_FAILED";

export class CodexHookSetupError extends Error {
  readonly tag = "CodexHookSetupError";
  readonly code: CodexHookSetupErrorCode;
  readonly provider = "codex";

  constructor(code: CodexHookSetupErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    Object.defineProperty(this, "name", {
      value: this.tag,
      enumerable: false,
      configurable: true,
    });
    this.code = code;
  }
}
