import {
  defineHarnessProviderErrors,
  type HarnessProviderErrorClass,
  type HarnessProviderErrors,
} from "@station/harness-shared";

export type CodexHarnessErrorCode =
  | "HARNESS_CODEX_UNAVAILABLE"
  | "HARNESS_CODEX_RESUME_UNSUPPORTED"
  | "HARNESS_CODEX_EVENT_INVALID"
  | "HARNESS_CODEX_EVENT_UNSUPPORTED"
  | "HARNESS_CODEX_EVENT_INGEST_FAILED";

const codexErrors: HarnessProviderErrors<CodexHarnessErrorCode> = defineHarnessProviderErrors({
  name: "CodexHarnessProviderError",
  provider: "codex",
});

// Annotated so declaration emit names the class type instead of a deep package path.
export const CodexHarnessProviderError: HarnessProviderErrorClass<CodexHarnessErrorCode> =
  codexErrors.ErrorClass;
export const codexHarnessError: HarnessProviderErrors<CodexHarnessErrorCode>["create"] =
  codexErrors.create;
export const codexProviderErrorFromUnknown: HarnessProviderErrors<CodexHarnessErrorCode>["fromUnknown"] =
  codexErrors.fromUnknown;
