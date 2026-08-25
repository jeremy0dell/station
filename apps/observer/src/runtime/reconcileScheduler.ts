import { Effect } from "@station/runtime";

export type ReconcileScheduler = {
  request(reason: string): void;
  requestInteractive(reason: string): void;
};

export type CreateReconcileSchedulerOptions = {
  reconcile(reason: string): Promise<unknown>;
  debounceMs?: number;
  backlogDebounceMs?: number;
  interactiveDebounceMs?: number;
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
const defaultInteractiveDebounceMs = 25;

export function createReconcileScheduler(
  options: CreateReconcileSchedulerOptions,
): ReconcileScheduler {
  const debounceMs = options.debounceMs ?? defaultDebounceMs;
  const backlogDebounceMs = options.backlogDebounceMs ?? defaultBacklogDebounceMs;
  const interactiveDebounceMs = options.interactiveDebounceMs ?? defaultInteractiveDebounceMs;
  let running = false;
  let timerScheduled = false;
  let scheduledFor: number | undefined;
  let timerGeneration = 0;
  let firstQueuedAt: number | undefined;
  let interactiveQueued = false;
  const queuedReasons: string[] = [];

  return {
    request: (reason) => request(reason, false),
    requestInteractive: (reason) => request(reason, true),
  };

  function request(reason: string, interactive: boolean): void {
    const requestedAt = Date.now();
    if (queuedReasons.length === 0) {
      firstQueuedAt = requestedAt;
    }
    queuedReasons.push(reason);
    interactiveQueued ||= interactive;
    if (running) return;
    const delayMs = interactive ? interactiveDebounceMs : debounceMs;
    if (timerScheduled) {
      if (interactive && (scheduledFor === undefined || scheduledFor > requestedAt + delayMs)) {
        scheduleFlush(delayMs);
      }
      return;
    }
    scheduleFlush(delayMs);
  }

  function scheduleFlush(delayMs: number): void {
    const generation = ++timerGeneration;
    timerScheduled = true;
    scheduledFor = Date.now() + delayMs;
    void sleep(delayMs).then(
      () => {
        if (generation !== timerGeneration) return;
        timerScheduled = false;
        scheduledFor = undefined;
        void flush().catch((error: unknown) => reportError(error));
      },
      () => {
        if (generation === timerGeneration) {
          timerScheduled = false;
          scheduledFor = undefined;
        }
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
    interactiveQueued = false;
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
        scheduleFlush(interactiveQueued ? interactiveDebounceMs : backlogDebounceMs);
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
