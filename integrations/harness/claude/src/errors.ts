import { harnessProviderErrorClass } from "@station/harness-shared";

export type ClaudeHarnessErrorCode =
  | "HARNESS_CLAUDE_UNAVAILABLE"
  | "HARNESS_CLAUDE_RESUME_UNSUPPORTED"
  | "HARNESS_CLAUDE_EVENT_INVALID"
  | "HARNESS_CLAUDE_EVENT_UNSUPPORTED"
  | "HARNESS_CLAUDE_EVENT_INGEST_FAILED";

export const ClaudeHarnessProviderError = harnessProviderErrorClass<ClaudeHarnessErrorCode>({
  name: "ClaudeHarnessProviderError",
  provider: "claude",
});

export function claudeHarnessError(code: ClaudeHarnessErrorCode, message: string, cause?: unknown) {
  return new ClaudeHarnessProviderError(code, message, { cause });
}
