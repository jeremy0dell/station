import type { SafeError } from "@station/contracts";

export const STATION_TERMINAL_PROVIDER_ID = "native";

export type StationTerminalProviderErrorCode =
  | "TERMINAL_STATION_HOSTED"
  | "TERMINAL_TARGET_MISSING";

/** Native focus remains Station-owned; Host backing adds lifecycle close but not external focus. */
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
