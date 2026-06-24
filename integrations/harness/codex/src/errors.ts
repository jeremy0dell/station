import { harnessProviderErrorClass } from "@station/harness-shared";

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
