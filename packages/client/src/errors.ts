import type { SafeError } from "@station/contracts";
import { publicSafeErrorFromUnknown, type RuntimeSafeErrorFallback } from "@station/runtime";
import { isObserverConnectError, observerConnectNotice } from "./connectionState.js";
import type { ClientNotice } from "./types.js";

// Schema, validation, and build-identity incoherence cannot heal by retrying
// the identical exchange against the same incompatible peer. Everything else
// — including unknown codes — remains retryable so transient failures self-heal.
const PERMANENT_OBSERVER_ERROR_CODES = new Set<SafeError["code"]>([
  "OBSERVER_BUILD_MISMATCH",
  "PROTOCOL_SCHEMA_MISMATCH",
  "PROTOCOL_RESPONSE_VALIDATION_FAILED",
  "PROTOCOL_EVENT_VALIDATION_FAILED",
  "PROTOCOL_SUBSCRIBE_ACK_MISMATCH",
]);

export function isPermanentObserverError(error: SafeError): boolean {
  return PERMANENT_OBSERVER_ERROR_CODES.has(error.code);
}

export type ToSafeErrorOptions = {
  clientLabel?: string;
};

export function toSafeError(error: unknown, options: ToSafeErrorOptions = {}): SafeError {
  return publicSafeErrorFromUnknown(error, {
    tag: "ClientObserverError",
    code: "CLIENT_OBSERVER_OPERATION_FAILED",
    message: `${clientSubject(options.clientLabel)} could not complete the observer operation.`,
  });
}

export function safeErrorToNotice(error: SafeError): ClientNotice {
  if (isObserverConnectError(error)) {
    return observerConnectNotice();
  }

  const notice: ClientNotice = {
    kind: "error",
    message: error.message,
  };
  if (error.hint !== undefined) notice.hint = error.hint;
  if (error.commandId !== undefined) notice.commandId = error.commandId;
  if (error.traceId !== undefined) notice.traceId = error.traceId;
  if (error.diagnosticId !== undefined) notice.diagnosticId = error.diagnosticId;
  return notice;
}

export function observerErrorFallback(code: string, message: string): RuntimeSafeErrorFallback {
  return {
    tag: "ClientObserverError",
    code,
    message,
  };
}

export function timeoutErrorFallback(code: string, message: string): RuntimeSafeErrorFallback {
  return {
    tag: "TimeoutError",
    code,
    message,
  };
}

function clientSubject(clientLabel: string | undefined): string {
  return clientLabel === undefined || clientLabel.length === 0
    ? "The client"
    : `The ${clientLabel}`;
}
