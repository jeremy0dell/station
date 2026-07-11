import { type SafeError, SafeErrorSchema } from "@station/contracts";
import {
  classifyHostCompatibility,
  HOST_PROTOCOL_VERSION,
  type HostHealthResult,
} from "./protocol.js";

export const STATION_HOST_PROVIDER_ID = "native";

export type StationHostErrorCode =
  | "HOST_SPAWN_FAILED"
  | "HOST_PTY_NOT_FOUND"
  | "HOST_ATTACH_GONE"
  | "HOST_UNREACHABLE"
  | "HOST_REQUEST_FAILED"
  | "HOST_VERSION_INCOMPATIBLE"
  | "HOST_UPGRADE_BLOCKED"
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

/** Identify compatibility failures that callers must not collapse into host absence. */
export function isStationHostCompatibilityError(error: unknown): error is SafeError {
  const parsed = SafeErrorSchema.safeParse(error);
  return (
    parsed.success &&
    (parsed.data.code === "HOST_VERSION_INCOMPATIBLE" ||
      parsed.data.code === "HOST_UPGRADE_BLOCKED")
  );
}

/** Build the canonical compatibility error, or return undefined when reuse is safe. */
export function stationHostCompatibilityError(
  health: HostHealthResult,
  expectedBuildVersion: string,
): StationHostProviderError | undefined {
  const compatibility = classifyHostCompatibility(health, expectedBuildVersion);
  if (compatibility.action === "reuse") {
    return undefined;
  }

  const hint =
    "Reopen Station with the build that started this host, finish or close its terminals, then retry.";
  if (compatibility.action === "replace") {
    return new StationHostProviderError(
      "HOST_VERSION_INCOMPATIBLE",
      `Station host build "${compatibility.runningBuildVersion}" does not match this Station build "${expectedBuildVersion}".`,
      { hint },
    );
  }
  if (compatibility.reason === "protocol-mismatch") {
    return new StationHostProviderError(
      "HOST_VERSION_INCOMPATIBLE",
      `Station host protocol ${health.protocolVersion} does not match protocol ${HOST_PROTOCOL_VERSION} for Station build "${expectedBuildVersion}".`,
      { hint },
    );
  }
  return new StationHostProviderError(
    "HOST_VERSION_INCOMPATIBLE",
    `Station host did not report a build version and cannot be safely reused by Station build "${expectedBuildVersion}".`,
    { hint },
  );
}

/** Require exact protocol/build reuse and throw the canonical compatibility SafeError otherwise. */
export function assertHostReusable(health: HostHealthResult, expectedBuildVersion: string): void {
  const error = stationHostCompatibilityError(health, expectedBuildVersion);
  if (error !== undefined) {
    throw error;
  }
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
  const safeError = SafeErrorSchema.safeParse(error);
  if (safeError.success) {
    return safeError.data;
  }
  return stationHostSafeError(fallback.code, fallback.message, {
    ...(fallback.hint === undefined ? {} : { hint: fallback.hint }),
  });
}
