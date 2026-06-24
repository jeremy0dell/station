import { harnessProviderErrorClass } from "@station/harness-shared";

export type CursorHarnessErrorCode =
  | "HARNESS_CURSOR_UNAVAILABLE"
  | "HARNESS_CURSOR_EXEC_UNSUPPORTED"
  | "HARNESS_CURSOR_RESUME_UNSUPPORTED"
  | "HARNESS_CURSOR_EVENT_INVALID"
  | "HARNESS_CURSOR_EVENT_INGEST_FAILED";

export const CursorHarnessProviderError = harnessProviderErrorClass<CursorHarnessErrorCode>({
  name: "CursorHarnessProviderError",
  provider: "cursor",
});

export function cursorHarnessError(code: CursorHarnessErrorCode, message: string, cause?: unknown) {
  return new CursorHarnessProviderError(code, message, { cause });
}
