import type { SafeError } from "@station/contracts";

export type CursorHarnessErrorCode =
  | "HARNESS_CURSOR_UNAVAILABLE"
  | "HARNESS_CURSOR_EXEC_UNSUPPORTED"
  | "HARNESS_CURSOR_RESUME_UNSUPPORTED"
  | "HARNESS_CURSOR_EVENT_INVALID"
  | "HARNESS_CURSOR_EVENT_INGEST_FAILED";

export class CursorHarnessProviderError extends Error implements SafeError {
  readonly tag = "HarnessProviderError";
  readonly code: CursorHarnessErrorCode;
  readonly provider = "cursor";
  readonly hint: string | undefined;

  constructor(
    code: CursorHarnessErrorCode,
    message: string,
    options: { cause?: unknown; hint?: string } = {},
  ) {
    super(`${code}: ${message}`, { cause: options.cause });
    Object.defineProperty(this, "name", {
      value: "CursorHarnessProviderError",
      configurable: true,
    });
    this.code = code;
    this.hint = options.hint;
  }
}

export function cursorHarnessError(
  code: CursorHarnessErrorCode,
  message: string,
  cause?: unknown,
): CursorHarnessProviderError {
  return new CursorHarnessProviderError(code, message, { cause });
}

export function cursorProviderErrorFromUnknown(
  error: unknown,
  fallback: {
    code: CursorHarnessErrorCode;
    message: string;
    hint?: string;
  },
): CursorHarnessProviderError {
  if (error instanceof CursorHarnessProviderError) {
    return error;
  }
  const options: { cause?: unknown; hint?: string } = { cause: error };
  if (fallback.hint !== undefined) {
    options.hint = fallback.hint;
  }
  return new CursorHarnessProviderError(fallback.code, fallback.message, options);
}
