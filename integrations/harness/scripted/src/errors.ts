import type { SafeError } from "@station/contracts";

export type ScriptedHarnessErrorCode =
  | "HARNESS_SCRIPTED_DISCOVER_FAILED"
  | "HARNESS_SCRIPTED_EVENT_INVALID"
  | "HARNESS_SCRIPTED_EVENT_INGEST_FAILED";

export class ScriptedHarnessProviderError extends Error implements SafeError {
  readonly tag = "HarnessProviderError";
  readonly code: ScriptedHarnessErrorCode;
  readonly provider = "scripted";
  readonly hint: string | undefined;

  constructor(
    code: ScriptedHarnessErrorCode,
    message: string,
    options?: { cause?: unknown; hint?: string },
  ) {
    super(`${code}: ${message}`, { cause: options?.cause });
    this.name = "ScriptedHarnessProviderError";
    this.code = code;
    this.hint = options?.hint;
  }
}

export function scriptedHarnessError(
  code: ScriptedHarnessErrorCode,
  message: string,
  cause?: unknown,
): ScriptedHarnessProviderError {
  return new ScriptedHarnessProviderError(code, message, { cause });
}
