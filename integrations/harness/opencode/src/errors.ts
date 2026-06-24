import {
  type HarnessProviderError,
  harnessProviderErrorClass,
  harnessProviderErrorFromUnknown,
} from "@station/harness-shared";

export type OpenCodeHarnessErrorCode =
  | "HARNESS_OPENCODE_UNAVAILABLE"
  | "HARNESS_OPENCODE_EXEC_UNSUPPORTED"
  | "HARNESS_OPENCODE_RESUME_UNSUPPORTED"
  | "HARNESS_OPENCODE_EVENT_INVALID"
  | "HARNESS_OPENCODE_EVENT_INGEST_FAILED"
  | "HARNESS_OPENCODE_PLUGIN_INSTALL_FAILED";

export const OpenCodeHarnessProviderError = harnessProviderErrorClass<OpenCodeHarnessErrorCode>({
  name: "OpenCodeHarnessProviderError",
  provider: "opencode",
});

export function openCodeHarnessError(
  code: OpenCodeHarnessErrorCode,
  message: string,
  cause?: unknown,
) {
  return new OpenCodeHarnessProviderError(code, message, { cause });
}

export function openCodeProviderErrorFromUnknown(
  error: unknown,
  fallback: { code: OpenCodeHarnessErrorCode; message: string; hint?: string | undefined },
): HarnessProviderError<OpenCodeHarnessErrorCode> {
  return harnessProviderErrorFromUnknown(OpenCodeHarnessProviderError, error, fallback);
}
