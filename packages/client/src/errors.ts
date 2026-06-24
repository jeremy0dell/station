import type { SafeError } from "@station/contracts";
import type { RuntimeSafeErrorFallback } from "@station/runtime";
import { isObserverConnectError, observerConnectNotice } from "./connectionState.js";
import type { ClientNotice } from "./types.js";

// Schema and validation incoherence means the client and observer builds
// disagree; retrying re-runs the identical exchange against the same
// incompatible peer. Everything else — including unknown codes — is treated
// as retryable so transient failures self-heal at max backoff.
const PERMANENT_OBSERVER_ERROR_CODES = new Set<SafeError["code"]>([
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
  if (isSafeError(error)) {
    return error;
  }
  const cause = safeErrorCause(error);
  if (cause !== undefined) {
    return cause;
  }
  return {
    tag: "ClientObserverError",
    code: "CLIENT_OBSERVER_OPERATION_FAILED",
    message: `${clientSubject(options.clientLabel)} could not complete the observer operation.`,
  };
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

function isSafeError(value: unknown): value is SafeError {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SafeError>;
  return (
    typeof candidate.tag === "string" &&
    candidate.tag.length > 0 &&
    typeof candidate.code === "string" &&
    candidate.code.length > 0 &&
    typeof candidate.message === "string" &&
    candidate.message.length > 0
  );
}

function clientSubject(clientLabel: string | undefined): string {
  return clientLabel === undefined || clientLabel.length === 0
    ? "The client"
    : `The ${clientLabel}`;
}

function safeErrorCause(error: unknown, seen = new Set<unknown>()): SafeError | undefined {
  if (!error || typeof error !== "object" || seen.has(error)) {
    return undefined;
  }
  seen.add(error);
  const cause = (error as { cause?: unknown }).cause;
  if (isSafeError(cause)) {
    return cause;
  }
  return safeErrorCause(cause, seen);
}
