import type { SafeError } from "@station/contracts";

export type OpenCodeHarnessErrorCode =
  | "HARNESS_OPENCODE_UNAVAILABLE"
  | "HARNESS_OPENCODE_EXEC_UNSUPPORTED"
  | "HARNESS_OPENCODE_RESUME_UNSUPPORTED"
  | "HARNESS_OPENCODE_EVENT_INVALID"
  | "HARNESS_OPENCODE_EVENT_INGEST_FAILED"
  | "HARNESS_OPENCODE_PLUGIN_INSTALL_FAILED";

export class OpenCodeHarnessProviderError extends Error implements SafeError {
  readonly tag = "HarnessProviderError";
  readonly code: OpenCodeHarnessErrorCode;
  readonly provider = "opencode";
  readonly hint: string | undefined;

  constructor(
    code: OpenCodeHarnessErrorCode,
    message: string,
    options: { cause?: unknown; hint?: string } = {},
  ) {
    super(`${code}: ${message}`, { cause: options.cause });
    Object.defineProperty(this, "name", {
      value: "OpenCodeHarnessProviderError",
      configurable: true,
    });
    this.code = code;
    this.hint = options.hint;
  }
}

export function openCodeHarnessError(
  code: OpenCodeHarnessErrorCode,
  message: string,
  cause?: unknown,
): OpenCodeHarnessProviderError {
  return new OpenCodeHarnessProviderError(code, message, { cause });
}

export function openCodeProviderErrorFromUnknown(
  error: unknown,
  fallback: {
    code: OpenCodeHarnessErrorCode;
    message: string;
    hint?: string | undefined;
  },
): OpenCodeHarnessProviderError {
  if (error instanceof OpenCodeHarnessProviderError) {
    return error;
  }
  const options: { cause?: unknown; hint?: string } = { cause: error };
  if (fallback.hint !== undefined) {
    options.hint = fallback.hint;
  }
  return new OpenCodeHarnessProviderError(fallback.code, fallback.message, options);
}
