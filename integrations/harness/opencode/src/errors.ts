import {
  defineHarnessProviderErrors,
  type HarnessProviderErrorClass,
  type HarnessProviderErrors,
} from "@station/harness-shared";

export type OpenCodeHarnessErrorCode =
  | "HARNESS_OPENCODE_UNAVAILABLE"
  | "HARNESS_OPENCODE_EXEC_UNSUPPORTED"
  | "HARNESS_OPENCODE_RESUME_UNSUPPORTED"
  | "HARNESS_OPENCODE_EVENT_INVALID"
  | "HARNESS_OPENCODE_EVENT_INGEST_FAILED"
  | "HARNESS_OPENCODE_PLUGIN_INSTALL_FAILED";

const openCodeErrors: HarnessProviderErrors<OpenCodeHarnessErrorCode> = defineHarnessProviderErrors(
  {
    name: "OpenCodeHarnessProviderError",
    provider: "opencode",
  },
);

export const OpenCodeHarnessProviderError: HarnessProviderErrorClass<OpenCodeHarnessErrorCode> =
  openCodeErrors.ErrorClass;
export const openCodeHarnessError: HarnessProviderErrors<OpenCodeHarnessErrorCode>["create"] =
  openCodeErrors.create;
export const openCodeProviderErrorFromUnknown: HarnessProviderErrors<OpenCodeHarnessErrorCode>["fromUnknown"] =
  openCodeErrors.fromUnknown;
