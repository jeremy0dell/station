import type { DiagnosticDetail, SafeError } from "@station/contracts";
import {
  isExternalCommandError,
  type RuntimeSafeError,
  safeErrorFromUnknown,
} from "@station/runtime";

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
  readonly diagnosticDetails?: DiagnosticDetail[];

  constructor(
    code: TmuxTerminalProviderErrorCode,
    message: string,
    options: {
      hint?: string;
      cause?: unknown;
      projectId?: string;
      worktreeId?: string;
      sessionId?: string;
      diagnosticDetails?: DiagnosticDetail[];
    } = {},
  ) {
    super(message, { cause: options.cause });
    Object.defineProperty(this, "name", {
      value: this.tag,
      enumerable: false,
      configurable: true,
    });
    this.code = code;
    if (options.hint !== undefined) this.hint = options.hint;
    if (options.projectId !== undefined) this.projectId = options.projectId;
    if (options.worktreeId !== undefined) this.worktreeId = options.worktreeId;
    if (options.sessionId !== undefined) this.sessionId = options.sessionId;
    if (options.diagnosticDetails !== undefined) {
      this.diagnosticDetails = options.diagnosticDetails;
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
): RuntimeSafeError {
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
  const normalized = tmuxSafeError(error, fallback);
  const diagnosticDetails = normalized.diagnosticDetails;
  if (isMissingTarget(normalized)) {
    return new TmuxTerminalProviderError(
      "TERMINAL_TARGET_MISSING",
      "The terminal target no longer exists.",
      {
        hint: "Refresh the dashboard or reopen the worktree.",
        cause: normalized,
        ...(diagnosticDetails === undefined ? {} : { diagnosticDetails }),
      },
    );
  }
  if (normalized.code === "ENOENT") {
    return new TmuxTerminalProviderError("TERMINAL_TMUX_UNAVAILABLE", "tmux is not available.", {
      hint: "Install tmux or choose a different terminal provider.",
      cause: normalized,
      ...(diagnosticDetails === undefined ? {} : { diagnosticDetails }),
    });
  }
  if (
    normalized.code === "TERMINAL_TMUX_TIMEOUT" ||
    normalized.code === "EXTERNAL_COMMAND_TIMEOUT"
  ) {
    return new TmuxTerminalProviderError("TERMINAL_TMUX_TIMEOUT", "tmux command timed out.", {
      cause: normalized,
      ...(diagnosticDetails === undefined ? {} : { diagnosticDetails }),
    });
  }

  const hint = normalized.hint ?? fallback.hint;
  const message = isGenericExternalCommandFailure(normalized)
    ? fallback.message
    : normalized.message;
  return new TmuxTerminalProviderError(fallback.code, message, {
    cause: normalized,
    ...(hint === undefined ? {} : { hint }),
    ...(diagnosticDetails === undefined ? {} : { diagnosticDetails }),
  });
}

function isGenericExternalCommandFailure(error: RuntimeSafeError): boolean {
  return (
    isExternalCommandError(error) &&
    (error.code === "EXTERNAL_COMMAND_FAILED" ||
      error.code === "EXTERNAL_COMMAND_TIMEOUT" ||
      error.code === "EXTERNAL_COMMAND_ABORTED")
  );
}

function isMissingTarget(error: RuntimeSafeError): boolean {
  if (error.code === "TERMINAL_TARGET_MISSING") {
    return true;
  }
  const text = [error.message];
  for (const detail of error.diagnosticDetails ?? []) {
    if (detail.type !== "external_command") continue;
    text.push(detail.command);
    if (detail.stdoutSnippet !== undefined) text.push(detail.stdoutSnippet);
    if (detail.stderrSnippet !== undefined) text.push(detail.stderrSnippet);
  }
  return /can't find|cannot find|no such|not found|missing pane|missing window/i.test(
    text.join("\n"),
  );
}
