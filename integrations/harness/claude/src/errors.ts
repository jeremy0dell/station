import {
  defineHarnessProviderErrors,
  type HarnessProviderErrorClass,
  type HarnessProviderErrors,
} from "@station/harness-shared";

export type ClaudeHarnessErrorCode =
  | "HARNESS_CLAUDE_UNAVAILABLE"
  | "HARNESS_CLAUDE_RESUME_UNSUPPORTED"
  | "HARNESS_CLAUDE_EVENT_INVALID"
  | "HARNESS_CLAUDE_EVENT_UNSUPPORTED"
  | "HARNESS_CLAUDE_EVENT_INGEST_FAILED";

const claudeErrors: HarnessProviderErrors<ClaudeHarnessErrorCode> = defineHarnessProviderErrors({
  name: "ClaudeHarnessProviderError",
  provider: "claude",
});

// Annotated so declaration emit names the class type instead of a deep package path.
export const ClaudeHarnessProviderError: HarnessProviderErrorClass<ClaudeHarnessErrorCode> =
  claudeErrors.ErrorClass;
export const claudeHarnessError: HarnessProviderErrors<ClaudeHarnessErrorCode>["create"] =
  claudeErrors.create;
export const claudeProviderErrorFromUnknown: HarnessProviderErrors<ClaudeHarnessErrorCode>["fromUnknown"] =
  claudeErrors.fromUnknown;
