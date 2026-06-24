export type CursorHookSetupErrorCode =
  | "CURSOR_HOOK_CONFIG_UNREADABLE"
  | "CURSOR_HOOK_INVALID_JSON"
  | "CURSOR_HOOK_WRITE_FAILED";

export class CursorHookSetupError extends Error {
  readonly tag = "CursorHookSetupError";
  readonly code: CursorHookSetupErrorCode;
  readonly provider = "cursor";

  constructor(code: CursorHookSetupErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    Object.defineProperty(this, "name", {
      value: this.tag,
      enumerable: false,
      configurable: true,
    });
    this.code = code;
  }
}
