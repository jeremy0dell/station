import type { SafeError } from "@station/contracts";

export function commandCancellationError(): SafeError {
  return {
    tag: "CancellationError",
    code: "COMMAND_CANCELLED",
    message: "Observer command was cancelled.",
  };
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? commandCancellationError();
  }
}

export function linkAbortSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  cleanup(): void;
} {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason ?? commandCancellationError());
    }
  };

  for (const signal of signals) {
    if (signal === undefined) {
      continue;
    }
    if (signal.aborted) {
      abort(signal);
      continue;
    }
    const listener = () => abort(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push(() => signal.removeEventListener("abort", listener));
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}
