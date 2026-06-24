import { Effect } from "@station/runtime";

export type ReconcileScheduler = {
  request(reason: string): void;
};

export type CreateReconcileSchedulerOptions = {
  reconcile(reason: string): Promise<unknown>;
  debounceMs?: number;
  backlogDebounceMs?: number;
  onError?: (error: unknown) => Promise<void> | void;
  onFlushFinish?: (profile: ReconcileSchedulerFlushProfile) => Promise<void> | void;
};

export type ReconcileSchedulerFlushProfile = {
  reason: string;
  queuedCount: number;
  queuedWhileRunning: number;
  waitMs: number;
  durationMs: number;
  queuedAfter: number;
};

const defaultDebounceMs = 100;
const defaultBacklogDebounceMs = 1000;

export function createReconcileScheduler(
  options: CreateReconcileSchedulerOptions,
): ReconcileScheduler {
  const debounceMs = options.debounceMs ?? defaultDebounceMs;
  const backlogDebounceMs = options.backlogDebounceMs ?? defaultBacklogDebounceMs;
  let running = false;
  let timerScheduled = false;
  let firstQueuedAt: number | undefined;
  const queuedReasons: string[] = [];

  return {
    request: (reason) => {
      if (queuedReasons.length === 0) {
        firstQueuedAt = Date.now();
      }
      queuedReasons.push(reason);
      if (running || timerScheduled) {
        return;
      }
      scheduleFlush(debounceMs);
    },
  };

  function scheduleFlush(delayMs: number): void {
    timerScheduled = true;
    void sleep(delayMs).then(
      () => {
        timerScheduled = false;
        void flush().catch((error: unknown) => reportError(error));
      },
      () => {
        timerScheduled = false;
      },
    );
  }

  async function flush(): Promise<void> {
    if (running) {
      return;
    }
    const reasons = queuedReasons.splice(0);
    if (reasons.length === 0) {
      return;
    }
    const queuedAt = firstQueuedAt;
    firstQueuedAt = undefined;
    const reason = summarizeReasons(reasons);
    const startedAt = Date.now();

    running = true;
    try {
      await options.reconcile(reason);
    } finally {
      const queuedAfter = queuedReasons.length;
      running = false;
      reportFlushFinish({
        reason,
        queuedCount: reasons.length,
        queuedWhileRunning: queuedAfter,
        waitMs: queuedAt === undefined ? 0 : Math.max(0, startedAt - queuedAt),
        durationMs: Math.max(0, Date.now() - startedAt),
        queuedAfter,
      });
      if (queuedReasons.length > 0 && !timerScheduled) {
        scheduleFlush(backlogDebounceMs);
      }
    }
  }

  function reportError(error: unknown): void {
    if (options.onError === undefined) {
      return;
    }
    void Promise.resolve(options.onError(error)).catch(() => undefined);
  }

  function reportFlushFinish(profile: ReconcileSchedulerFlushProfile): void {
    if (options.onFlushFinish === undefined) {
      return;
    }
    void Promise.resolve(options.onFlushFinish(profile)).catch(() => undefined);
  }
}

function summarizeReasons(reasons: string[]): string {
  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length === 1) {
    return uniqueReasons[0] ?? "scheduled";
  }
  if (uniqueReasons.every((reason) => reason.startsWith("hook:"))) {
    return `hook:batch(${reasons.length})`;
  }
  return `scheduled:batch(${reasons.length})`;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    await Promise.resolve();
    return;
  }
  await Effect.runPromise(Effect.sleep(`${ms} millis`));
}
