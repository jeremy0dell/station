import type { SafeError } from "@station/contracts";

export const STATION_TERMINAL_PROVIDER_ID = "native";

export type StationTerminalProviderErrorCode =
  | "TERMINAL_STATION_HOSTED"
  | "TERMINAL_TARGET_MISSING";

/**
 * SafeError raised by the native (Station) terminal provider when it is not host-backed:
 * the provider owns no terminal of its own (the PTY lives in the Station UI), so
 * observer-side focus/close cannot drive it. When a host is attached, those
 * operations are real host-backed calls instead.
 */
export class StationTerminalProviderError extends Error implements SafeError {
  readonly tag = "TerminalProviderError";
  readonly provider = STATION_TERMINAL_PROVIDER_ID;
  readonly code: StationTerminalProviderErrorCode;
  readonly hint?: string;
  readonly worktreeId?: string;
  readonly sessionId?: string;

  constructor(
    code: StationTerminalProviderErrorCode,
    message: string,
    options: {
      hint?: string;
      cause?: unknown;
      worktreeId?: string;
      sessionId?: string;
    } = {},
  ) {
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
