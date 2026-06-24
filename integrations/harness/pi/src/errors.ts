import type { SafeError } from "@station/contracts";

export type PiHarnessErrorCode =
  | "HARNESS_PI_UNAVAILABLE"
  | "HARNESS_PI_EXEC_UNSUPPORTED"
  | "HARNESS_PI_RESUME_UNSUPPORTED"
  | "HARNESS_PI_EVENT_INVALID"
  | "HARNESS_PI_EVENT_INGEST_FAILED";

export class PiHarnessProviderError extends Error implements SafeError {
  readonly tag = "HarnessProviderError";
  readonly code: PiHarnessErrorCode;
  readonly provider = "pi";
  readonly hint: string | undefined;

  constructor(
    code: PiHarnessErrorCode,
    message: string,
    options: { cause?: unknown; hint?: string } = {},
  ) {
    super(`${code}: ${message}`, { cause: options.cause });
    Object.defineProperty(this, "name", {
      value: "PiHarnessProviderError",
      configurable: true,
    });
    this.code = code;
    this.hint = options.hint;
  }
}

export function piHarnessError(
  code: PiHarnessErrorCode,
  message: string,
  cause?: unknown,
): PiHarnessProviderError {
  return new PiHarnessProviderError(code, message, { cause });
}

export function piProviderErrorFromUnknown(
  error: unknown,
  fallback: {
    code: PiHarnessErrorCode;
    message: string;
    hint?: string | undefined;
  },
): PiHarnessProviderError {
  if (error instanceof PiHarnessProviderError) {
    return error;
  }
  const options: { cause?: unknown; hint?: string } = { cause: error };
  if (fallback.hint !== undefined) {
    options.hint = fallback.hint;
  }
  return new PiHarnessProviderError(fallback.code, fallback.message, options);
}
