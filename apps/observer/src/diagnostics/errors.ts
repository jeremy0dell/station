import type { ErrorEnvelope, SafeError } from "@station/contracts";
import * as observability from "@station/observability";

export type { ErrorEnvelopeInput } from "@station/observability";

export function toSafeError(
  error: unknown,
  fallback: observability.SafeErrorFallback = {
    tag: "ObserverError",
    code: "OBSERVER_UNKNOWN",
    message: "Observer operation failed.",
  },
  context: Partial<
    Pick<
      SafeError,
      "commandId" | "projectId" | "worktreeId" | "sessionId" | "traceId" | "diagnosticId"
    >
  > = {},
): SafeError {
  return observability.toSafeError(error, fallback, context);
}

export function createErrorEnvelope(input: observability.ErrorEnvelopeInput): ErrorEnvelope {
  return observability.createErrorEnvelope(input);
}
