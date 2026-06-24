import type { SafeError } from "@station/contracts";

export type ClaudeHarnessErrorCode =
  | "HARNESS_CLAUDE_UNAVAILABLE"
  | "HARNESS_CLAUDE_RESUME_UNSUPPORTED"
  | "HARNESS_CLAUDE_EVENT_INVALID"
  | "HARNESS_CLAUDE_EVENT_UNSUPPORTED"
  | "HARNESS_CLAUDE_EVENT_INGEST_FAILED";

export class ClaudeHarnessProviderError extends Error implements SafeError {
  readonly tag = "HarnessProviderError";
  readonly code: ClaudeHarnessErrorCode;
  readonly provider = "claude";
  readonly hint: string | undefined;

  constructor(
    code: ClaudeHarnessErrorCode,
    message: string,
    options: { cause?: unknown; hint?: string } = {},
  ) {
    super(`${code}: ${message}`, { cause: options.cause });
    Object.defineProperty(this, "name", {
      value: "ClaudeHarnessProviderError",
      configurable: true,
    });
    this.code = code;
    this.hint = options.hint;
  }
}

export function claudeHarnessError(
  code: ClaudeHarnessErrorCode,
  message: string,
  cause?: unknown,
): ClaudeHarnessProviderError {
  return new ClaudeHarnessProviderError(code, message, { cause });
}

export function claudeProviderErrorFromUnknown(
  error: unknown,
  fallback: {
    code: ClaudeHarnessErrorCode;
    message: string;
    hint?: string | undefined;
  },
): ClaudeHarnessProviderError {
  if (error instanceof ClaudeHarnessProviderError) {
    return error;
  }
  const options: { cause?: unknown; hint?: string } = {
    cause: error,
  };
  if (fallback.hint !== undefined) {
    options.hint = fallback.hint;
  }
  return new ClaudeHarnessProviderError(fallback.code, fallback.message, options);
}
