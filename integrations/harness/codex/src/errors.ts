import type { SafeError } from "@station/contracts";

export type CodexHarnessErrorCode =
  | "HARNESS_CODEX_UNAVAILABLE"
  | "HARNESS_CODEX_RESUME_UNSUPPORTED"
  | "HARNESS_CODEX_EVENT_INVALID"
  | "HARNESS_CODEX_EVENT_UNSUPPORTED"
  | "HARNESS_CODEX_EVENT_INGEST_FAILED";

export class CodexHarnessProviderError extends Error implements SafeError {
  readonly tag = "HarnessProviderError";
  readonly code: CodexHarnessErrorCode;
  readonly provider = "codex";
  readonly hint: string | undefined;

  constructor(
    code: CodexHarnessErrorCode,
    message: string,
    options: { cause?: unknown; hint?: string } = {},
  ) {
    super(`${code}: ${message}`, { cause: options.cause });
    Object.defineProperty(this, "name", {
      value: "CodexHarnessProviderError",
      configurable: true,
    });
    this.code = code;
    this.hint = options.hint;
  }
}

export function codexHarnessError(
  code: CodexHarnessErrorCode,
  message: string,
  cause?: unknown,
): CodexHarnessProviderError {
  return new CodexHarnessProviderError(code, message, { cause });
}

export function codexProviderErrorFromUnknown(
  error: unknown,
  fallback: {
    code: CodexHarnessErrorCode;
    message: string;
    hint?: string | undefined;
  },
): CodexHarnessProviderError {
  if (error instanceof CodexHarnessProviderError) {
    return error;
  }
  const options: { cause?: unknown; hint?: string } = {
    cause: error,
  };
  if (fallback.hint !== undefined) {
    options.hint = fallback.hint;
  }
  return new CodexHarnessProviderError(fallback.code, fallback.message, options);
}
