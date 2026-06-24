import type { SafeError } from "@station/contracts";
import type { ClientNotice, StationClientConnectionState } from "./types.js";

const OBSERVER_CONNECT_ERROR_CODES = new Set<SafeError["code"]>([
  "PROTOCOL_CONNECT_FAILED",
  "PROTOCOL_CONNECT_TIMEOUT",
]);

export function isObserverConnectError(error: SafeError): boolean {
  return OBSERVER_CONNECT_ERROR_CODES.has(error.code);
}

export function connectedConnectionState(
  previous: StationClientConnectionState,
  nowMs: number,
): StationClientConnectionState {
  return previous.state === "connected" ? previous : { state: "connected", since: nowMs };
}

// displayOnly iff a last good snapshot exists, reconnecting otherwise; `since`
// is preserved when re-entering the same failure state so downtime accumulates
// across repeated failures instead of resetting on every retry.
export function failureConnectionState(
  previous: StationClientConnectionState,
  error: SafeError,
  hasSnapshot: boolean,
  nowMs: number,
): StationClientConnectionState {
  const statusState = hasSnapshot ? "displayOnly" : "reconnecting";
  const since = previous.state === statusState ? previous.since : nowMs;
  return { state: statusState, since, lastError: error };
}

// Terminal state for permanent errors: the runtime stops retrying but keeps
// the last good snapshot available.
export function haltedConnectionState(
  error: SafeError,
  nowMs: number,
): StationClientConnectionState {
  return { state: "halted", since: nowMs, lastError: error };
}

export function observerConnectNotice(): ClientNotice {
  return {
    kind: "error",
    message: "Observer is reconnecting.",
    hint: "Try the command again when the observer is ready.",
  };
}
