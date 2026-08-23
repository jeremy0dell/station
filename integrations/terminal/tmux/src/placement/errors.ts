import { TmuxTerminalProviderError } from "../errors.js";

export function callerContextRejected(message: string, hint?: string): TmuxTerminalProviderError {
  return new TmuxTerminalProviderError("TERMINAL_CALLER_CONTEXT_REJECTED", message, {
    ...(hint === undefined ? {} : { hint }),
  });
}

export function placementRejected(message: string, cause?: unknown): TmuxTerminalProviderError {
  return new TmuxTerminalProviderError("TERMINAL_PLACEMENT_REJECTED", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

export function cleanupUncertain(message: string, cause?: unknown): TmuxTerminalProviderError {
  return new TmuxTerminalProviderError("TERMINAL_CLEANUP_UNCERTAIN", message, {
    ...(cause === undefined ? {} : { cause }),
    hint: "Inspect the configured tmux endpoint before removing the retained session worktree.",
  });
}
