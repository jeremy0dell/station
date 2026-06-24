import type { SafeError } from "@station/contracts";
import { safeErrorFromUnknown } from "@station/runtime";

export type TmuxTerminalProviderErrorCode =
  | "TERMINAL_CAPTURE_FAILED"
  | "TERMINAL_CLOSE_FAILED"
  | "TERMINAL_FOCUS_FAILED"
  | "TERMINAL_LAUNCH_EXITED"
  | "TERMINAL_LAUNCH_FAILED"
  | "TERMINAL_LIST_FAILED"
  | "TERMINAL_OPEN_FAILED"
  | "TERMINAL_SEND_INPUT_FAILED"
  | "TERMINAL_TARGET_INVALID"
  | "TERMINAL_TARGET_MISSING"
  | "TERMINAL_TMUX_TIMEOUT"
  | "TERMINAL_TMUX_UNAVAILABLE";

export class TmuxTerminalProviderError extends Error implements SafeError {
  readonly tag = "TerminalProviderError";
  readonly provider = "tmux";
  readonly code: TmuxTerminalProviderErrorCode;
  readonly hint?: string;
  readonly projectId?: string;
  readonly worktreeId?: string;
  readonly sessionId?: string;

  constructor(
    code: TmuxTerminalProviderErrorCode,
    message: string,
    options: {
      hint?: string;
      cause?: unknown;
      projectId?: string;
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
    if (options.projectId !== undefined) {
      this.projectId = options.projectId;
    }
    if (options.worktreeId !== undefined) {
      this.worktreeId = options.worktreeId;
    }
    if (options.sessionId !== undefined) {
      this.sessionId = options.sessionId;
    }
  }
}

export function tmuxSafeError(
  error: unknown,
  fallback: {
    code: TmuxTerminalProviderErrorCode;
    message: string;
    hint?: string;
  },
): SafeError {
  return safeErrorFromUnknown(error, {
    tag: "TerminalProviderError",
    code: fallback.code,
    message: fallback.message,
    provider: "tmux",
    ...(fallback.hint === undefined ? {} : { hint: fallback.hint }),
  });
}

export function tmuxProviderErrorFromUnknown(
  error: unknown,
  fallback: {
    code: TmuxTerminalProviderErrorCode;
    message: string;
    hint?: string;
  },
): TmuxTerminalProviderError {
  if (isMissingTarget(error)) {
    return new TmuxTerminalProviderError(
      "TERMINAL_TARGET_MISSING",
      "The terminal target no longer exists.",
      {
        hint: "Refresh the dashboard or reopen the worktree.",
        cause: error,
      },
    );
  }
  if (isMissingBinary(error)) {
    return new TmuxTerminalProviderError("TERMINAL_TMUX_UNAVAILABLE", "tmux is not available.", {
      hint: "Install tmux or choose a different terminal provider.",
      cause: error,
    });
  }
  if (isTimeout(error)) {
    return new TmuxTerminalProviderError("TERMINAL_TMUX_TIMEOUT", "tmux command timed out.", {
      cause: error,
    });
  }

  const safeError = tmuxSafeError(error, fallback);
  const hint = safeError.hint ?? fallback.hint;
  const message = isGenericExternalCommandFailure(safeError) ? fallback.message : safeError.message;
  return new TmuxTerminalProviderError(fallback.code, message, {
    cause: error,
    ...(hint === undefined ? {} : { hint }),
  });
}

function isGenericExternalCommandFailure(error: SafeError): boolean {
  return (
    error.tag === "ExternalCommandError" &&
    (error.code === "EXTERNAL_COMMAND_FAILED" ||
      error.code === "EXTERNAL_COMMAND_TIMEOUT" ||
      error.code === "EXTERNAL_COMMAND_ABORTED")
  );
}

function isMissingBinary(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const cause = error as { code?: unknown; cause?: unknown };
  return cause.code === "ENOENT" || isMissingBinary(cause.cause);
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "TERMINAL_TMUX_TIMEOUT"
  );
}

function isMissingTarget(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    stderrSnippet?: unknown;
    stderr?: unknown;
    cause?: unknown;
  };
  const message = [
    typeof candidate.message === "string" ? candidate.message : "",
    typeof candidate.stderrSnippet === "string" ? candidate.stderrSnippet : "",
    typeof candidate.stderr === "string" ? candidate.stderr : "",
  ].join("\n");
  return (
    candidate.code === "TERMINAL_TARGET_MISSING" ||
    /can't find|cannot find|no such|not found|missing pane|missing window/i.test(message) ||
    isMissingTarget(candidate.cause)
  );
}
