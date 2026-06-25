import {
  type HarnessProviderError,
  harnessProviderErrorClass,
  harnessProviderErrorFromUnknown,
} from "@station/harness-shared";

export type CrushHarnessErrorCode =
  | "HARNESS_CRUSH_UNAVAILABLE"
  | "HARNESS_CRUSH_RESUME_UNSUPPORTED"
  | "HARNESS_CRUSH_EXEC_YOLO_UNSUPPORTED"
  | "HARNESS_CRUSH_EXEC_PROMPT_REQUIRED"
  | "HARNESS_CRUSH_EVENT_INGEST_FAILED";

export const CrushHarnessProviderError = harnessProviderErrorClass<CrushHarnessErrorCode>({
  name: "CrushHarnessProviderError",
  provider: "crush",
});

export function crushHarnessError(code: CrushHarnessErrorCode, message: string, cause?: unknown) {
  return new CrushHarnessProviderError(code, message, { cause });
}

export function crushProviderErrorFromUnknown(
  error: unknown,
  fallback: { code: CrushHarnessErrorCode; message: string; hint?: string | undefined },
): HarnessProviderError<CrushHarnessErrorCode> {
  return harnessProviderErrorFromUnknown(CrushHarnessProviderError, error, fallback);
}
