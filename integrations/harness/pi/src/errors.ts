import { harnessProviderErrorClass } from "@station/harness-shared";

export type PiHarnessErrorCode =
  | "HARNESS_PI_UNAVAILABLE"
  | "HARNESS_PI_EXEC_UNSUPPORTED"
  | "HARNESS_PI_RESUME_UNSUPPORTED"
  | "HARNESS_PI_EVENT_INVALID"
  | "HARNESS_PI_EVENT_INGEST_FAILED";

export const PiHarnessProviderError = harnessProviderErrorClass<PiHarnessErrorCode>({
  name: "PiHarnessProviderError",
  provider: "pi",
});

export function piHarnessError(code: PiHarnessErrorCode, message: string, cause?: unknown) {
  return new PiHarnessProviderError(code, message, { cause });
}
