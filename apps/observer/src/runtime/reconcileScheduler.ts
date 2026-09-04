import { Effect } from "@station/runtime";

export type ReconcileScheduler = {
  request(reason: string): void;
  /** Coalesces already-projected work until the configured quiet interval elapses. */
  requestAfterQuiet(reason: string): void;
  requestInteractive(reason: string): void;
  requestWhenReady(reason: string, readiness: ReconcileReadiness): void;
  requestInteractiveWhenReady(reason: string, readiness: ReconcileReadiness): void;
  shutdown(): Promise<void>;
};

export type ReconcileReadiness = {
  isReady(): boolean;
  whenReady(): Promise<void>;
};

export type CreateReconcileSchedulerOptions = {
  reconcile(reason: string): Promise<unknown>;
  debounceMs?: number;
  backlogDebounceMs?: number;
  interactiveDebounceMs?: number;
  /** Quiet interval for convergence work whose user-visible projection is already applied. */
  quietDebounceMs?: number;
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
const defaultQuietDebounceMs = 250;

type QueuedReconcileRequest = {
  reason: string;
  queuedAt: number;
  interactive: boolean;
  quiet: boolean;
  readiness?: ReconcileReadiness;
};

export function createReconcileScheduler(
  options: CreateReconcileSchedulerOptions,
): ReconcileScheduler {
  const debounceMs = options.debounceMs ?? defaultDebounceMs;
  const backlogDebounceMs = options.backlogDebounceMs ?? defaultBacklogDebounceMs;
  const interactiveDebounceMs = options.interactiveDebounceMs ?? defaultInteractiveDebounceMs;
  const quietDebounceMs = options.quietDebounceMs ?? defaultQuietDebounceMs;
  let running = false;
  let timerScheduled = false;
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let scheduledFor: number | undefined;
  let timerGeneration = 0;
  let waitingForReadiness = false;
  let readinessGeneration = 0;
  const queuedRequests: QueuedReconcileRequest[] = [];

  return {
    request: (reason) =>
      request({ reason, queuedAt: Date.now(), interactive: false, quiet: false }),
    requestAfterQuiet: (reason) =>
      request({ reason, queuedAt: Date.now(), interactive: false, quiet: true }),
    requestInteractive: (reason) =>
      request({ reason, queuedAt: Date.now(), interactive: true, quiet: false }),
    requestWhenReady: (reason, readiness) =>
      request({ reason, queuedAt: Date.now(), interactive: false, quiet: false, readiness }),
    requestInteractiveWhenReady: (reason, readiness) =>
      request({ reason, queuedAt: Date.now(), interactive: true, quiet: false, readiness }),
    shutdown: async () => {
      stopped = true;
      queuedRequests.length = 0;
      waitingForReadiness = false;
      readinessGeneration += 1;
      await inFlight;
    },
  };

  function request(queued: QueuedReconcileRequest): void {
    if (stopped) return;
    queuedRequests.push(queued);
    if (running) return;
    if (queued.readiness !== undefined && !queued.readiness.isReady()) {
      armReadinessWait();
      return;
    }
    const delayMs = queued.interactive
      ? interactiveDebounceMs
      : queued.quiet
        ? quietDebounceMs
        : debounceMs;
    if (timerScheduled) {
      const requestedFor = queued.queuedAt + delayMs;
      if (!queued.quiet && (scheduledFor === undefined || requestedFor < scheduledFor)) {
        scheduleFlush(delayMs);
      } else if (queued.quiet && !hasReadyImmediateRequest()) {
        // Already-projected event streams need one canonical pass after they
        // become quiet, not a competing provider scan between visible states.
        scheduleFlush(delayMs);
      }
      return;
    }
    scheduleFlush(delayMs);
  }

  function scheduleFlush(delayMs: number): void {
    if (stopped) return;
    const generation = ++timerGeneration;
    timerScheduled = true;
    scheduledFor = Date.now() + delayMs;
    void sleep(delayMs).then(
      () => {
        if (generation !== timerGeneration) return;
        timerScheduled = false;
        scheduledFor = undefined;
        const flight = flush().catch((error: unknown) => reportError(error));
        inFlight = flight;
        void flight.finally(() => {
          if (inFlight === flight) inFlight = undefined;
        });
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
    if (running || stopped) {
      return;
    }
    const ready: QueuedReconcileRequest[] = [];
    const blocked: QueuedReconcileRequest[] = [];
    for (const queued of queuedRequests.splice(0)) {
      if (queued.readiness === undefined || queued.readiness.isReady()) {
        ready.push(queued);
      } else {
        blocked.push(queued);
      }
    }
    queuedRequests.push(...blocked);
    if (ready.length === 0) {
      armReadinessWait();
      return;
    }
    const queuedAt = Math.min(...ready.map((queued) => queued.queuedAt));
    const reason = summarizeReasons(ready.map((queued) => queued.reason));
    const startedAt = Date.now();

    running = true;
    try {
      await options.reconcile(reason);
    } finally {
      const queuedAfter = queuedRequests.length;
      running = false;
      reportFlushFinish({
        reason,
        queuedCount: ready.length,
        queuedWhileRunning: queuedAfter,
        waitMs: Math.max(0, startedAt - queuedAt),
        durationMs: Math.max(0, Date.now() - startedAt),
        queuedAfter,
      });
      if (!stopped && queuedRequests.length > 0 && !timerScheduled) {
        if (hasReadyRequest()) {
          scheduleFlush(hasReadyInteractiveRequest() ? interactiveDebounceMs : backlogDebounceMs);
        } else {
          armReadinessWait();
        }
      }
    }
  }

  function hasReadyRequest(): boolean {
    return queuedRequests.some(
      (queued) => queued.readiness === undefined || queued.readiness.isReady(),
    );
  }

  function hasReadyInteractiveRequest(): boolean {
    return queuedRequests.some(
      (queued) =>
        queued.interactive && (queued.readiness === undefined || queued.readiness.isReady()),
    );
  }

  function hasReadyImmediateRequest(): boolean {
    return queuedRequests.some(
      (queued) => !queued.quiet && (queued.readiness === undefined || queued.readiness.isReady()),
    );
  }

  function armReadinessWait(): void {
    if (stopped || waitingForReadiness || queuedRequests.length === 0 || hasReadyRequest()) return;
    const readiness = [
      ...new Set(
        queuedRequests.flatMap((queued) =>
          queued.readiness === undefined ? [] : [queued.readiness],
        ),
      ),
    ];
    if (readiness.length === 0) return;
    waitingForReadiness = true;
    const generation = ++readinessGeneration;
    for (const candidate of readiness) {
      void candidate.whenReady().then(
        () => readinessSettled(generation),
        (error: unknown) => readinessSettled(generation, error),
      );
    }
  }

  function readinessSettled(generation: number, error?: unknown): void {
    if (stopped || generation !== readinessGeneration || !waitingForReadiness) return;
    waitingForReadiness = false;
    if (error !== undefined) reportError(error);
    if (!running && !timerScheduled && queuedRequests.length > 0) {
      scheduleFlush(hasReadyInteractiveRequest() ? interactiveDebounceMs : debounceMs);
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
