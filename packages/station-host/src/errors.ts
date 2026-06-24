import type { SafeError } from "@station/contracts";

export const STATION_HOST_PROVIDER_ID = "native";

export type StationHostErrorCode =
  | "HOST_SPAWN_FAILED"
  | "HOST_PTY_NOT_FOUND"
  | "HOST_ATTACH_GONE"
  | "HOST_UNREACHABLE"
  | "HOST_REQUEST_FAILED"
  | "HOST_BAD_REQUEST";

export type StationHostErrorOptions = {
  hint?: string;
  cause?: unknown;
  worktreeId?: string;
  sessionId?: string;
};

/**
 * SafeError for the standalone station host. Shares the native terminal
 * provider's envelope shape (`tag:"TerminalProviderError"`, `provider:"native"`)
 * so a host fault surfaces identically whether it is raised host-side, returned
 * to the UI data plane, or wrapped onto a CommandRecord by the provider.
 */
export class StationHostProviderError extends Error implements SafeError {
  readonly tag = "TerminalProviderError";
  readonly provider = STATION_HOST_PROVIDER_ID;
  readonly code: StationHostErrorCode;
  readonly hint?: string;
  readonly worktreeId?: string;
  readonly sessionId?: string;

  constructor(code: StationHostErrorCode, message: string, options: StationHostErrorOptions = {}) {
    super(message, { cause: options.cause });
    Object.defineProperty(this, "name", {
      value: this.tag,
      enumerable: false,
      configurable: true,
    });
    this.code = code;
    if (options.hint !== undefined) {
      this.hint = options.hint;
    }
    if (options.worktreeId !== undefined) {
      this.worktreeId = options.worktreeId;
    }
    if (options.sessionId !== undefined) {
      this.sessionId = options.sessionId;
    }
  }
}

/** Plain `SafeError` view (what travels on the wire / onto an envelope). */
export function stationHostSafeError(
  code: StationHostErrorCode,
  message: string,
  options: StationHostErrorOptions = {},
): SafeError {
  const error: SafeError = {
    tag: "TerminalProviderError",
    code,
    message,
    provider: STATION_HOST_PROVIDER_ID,
  };
  if (options.hint !== undefined) error.hint = options.hint;
  if (options.worktreeId !== undefined) error.worktreeId = options.worktreeId;
  if (options.sessionId !== undefined) error.sessionId = options.sessionId;
  return error;
}

function isSafeError(value: unknown): value is SafeError {
  return (
    typeof value === "object" &&
    value !== null &&
    "tag" in value &&
    "code" in value &&
    "message" in value &&
    typeof (value as { code: unknown }).code === "string"
  );
}

/**
 * Classify any thrown value into a stable station-host `SafeError`. A value that
 * is already a SafeError passes through; everything else collapses to the given
 * fallback so the host never leaks an unclassified failure.
 */
export function stationHostErrorFromUnknown(
  error: unknown,
  fallback: { code: StationHostErrorCode; message: string; hint?: string },
): SafeError {
  if (error instanceof StationHostProviderError) {
    return stationHostSafeError(error.code, error.message, {
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.worktreeId === undefined ? {} : { worktreeId: error.worktreeId }),
      ...(error.sessionId === undefined ? {} : { sessionId: error.sessionId }),
    });
  }
  if (isSafeError(error)) {
    return error;
  }
  return stationHostSafeError(fallback.code, fallback.message, {
    ...(fallback.hint === undefined ? {} : { hint: fallback.hint }),
  });
}
