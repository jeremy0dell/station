import {
  defineHarnessProviderErrors,
  type HarnessProviderErrorClass,
  type HarnessProviderErrors,
} from "@station/harness-shared";

export type CursorHarnessErrorCode =
  | "HARNESS_CURSOR_UNAVAILABLE"
  | "HARNESS_CURSOR_EXEC_UNSUPPORTED"
  | "HARNESS_CURSOR_RESUME_UNSUPPORTED"
  | "HARNESS_CURSOR_EVENT_INVALID"
  | "HARNESS_CURSOR_EVENT_INGEST_FAILED";

const cursorErrors: HarnessProviderErrors<CursorHarnessErrorCode> = defineHarnessProviderErrors({
  name: "CursorHarnessProviderError",
  provider: "cursor",
});

export const CursorHarnessProviderError: HarnessProviderErrorClass<CursorHarnessErrorCode> =
  cursorErrors.ErrorClass;
export const cursorHarnessError: HarnessProviderErrors<CursorHarnessErrorCode>["create"] =
  cursorErrors.create;
export const cursorProviderErrorFromUnknown: HarnessProviderErrors<CursorHarnessErrorCode>["fromUnknown"] =
  cursorErrors.fromUnknown;
