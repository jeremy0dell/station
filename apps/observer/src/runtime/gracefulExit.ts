export type ForcedExitTimer = { unref(): void };

export type ForcedExitDeps = {
  exit: (code: number) => void;
  setTimer: (fn: () => void, ms: number) => ForcedExitTimer;
  clearTimer: (timer: ForcedExitTimer) => void;
};

/**
 * Runs a shutdown sequence but guarantees the process still exits if a step
 * hangs. A command handler that ignores its abort would otherwise leave
 * `commandQueue.shutdown()` (and therefore the whole stop) pending forever,
 * keeping a stopping observer alive. The backstop is armed BEFORE the first
 * step and cleared only if the drain completes.
 */
export async function runShutdownWithBackstop(
  drain: () => Promise<void>,
  budgetMs: number,
  deps: ForcedExitDeps,
): Promise<void> {
  const timer = deps.setTimer(() => deps.exit(0), budgetMs);
  timer.unref();
  try {
    await drain();
  } finally {
    deps.clearTimer(timer);
  }
}
