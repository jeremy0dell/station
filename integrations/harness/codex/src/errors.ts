import {
  type HarnessProviderError,
  harnessProviderErrorClass,
  harnessProviderErrorFromUnknown,
} from "@station/harness-shared";

export type CodexHarnessErrorCode =
  | "HARNESS_CODEX_UNAVAILABLE"
  | "HARNESS_CODEX_RESUME_UNSUPPORTED"
  | "HARNESS_CODEX_EVENT_INVALID"
  | "HARNESS_CODEX_EVENT_UNSUPPORTED"
  | "HARNESS_CODEX_EVENT_INGEST_FAILED";

export const CodexHarnessProviderError = harnessProviderErrorClass<CodexHarnessErrorCode>({
  name: "CodexHarnessProviderError",
  provider: "codex",
});

export function codexHarnessError(code: CodexHarnessErrorCode, message: string, cause?: unknown) {
  return new CodexHarnessProviderError(code, message, { cause });
}

export function codexProviderErrorFromUnknown(
  error: unknown,
  fallback: { code: CodexHarnessErrorCode; message: string; hint?: string | undefined },
): HarnessProviderError<CodexHarnessErrorCode> {
  return harnessProviderErrorFromUnknown(CodexHarnessProviderError, error, fallback);
}
