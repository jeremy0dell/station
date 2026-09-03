import {
  defineHarnessProviderErrors,
  type HarnessProviderErrorClass,
  type HarnessProviderErrors,
} from "@station/harness-shared";

export type PiHarnessErrorCode =
  | "HARNESS_PI_UNAVAILABLE"
  | "HARNESS_PI_VERSION_UNSUPPORTED"
  | "HARNESS_PI_EXEC_UNSUPPORTED"
  | "HARNESS_PI_RESUME_UNSUPPORTED"
  | "HARNESS_PI_EVENT_INVALID"
  | "HARNESS_PI_EVENT_INGEST_FAILED";

const piErrors: HarnessProviderErrors<PiHarnessErrorCode> = defineHarnessProviderErrors({
  name: "PiHarnessProviderError",
  provider: "pi",
});

// Annotated so declaration emit names the class type instead of a deep package path.
export const PiHarnessProviderError: HarnessProviderErrorClass<PiHarnessErrorCode> =
  piErrors.ErrorClass;
export const piHarnessError: HarnessProviderErrors<PiHarnessErrorCode>["create"] = piErrors.create;
export const piProviderErrorFromUnknown: HarnessProviderErrors<PiHarnessErrorCode>["fromUnknown"] =
  piErrors.fromUnknown;
