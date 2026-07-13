import type {
  HarnessEventReport,
  HarnessEventReportReceipt,
  HarnessIngressQueueHealth,
  SafeError,
} from "@station/contracts";
import {
  HarnessEventReportReceiptSchema,
  HarnessEventReportSchema,
  STATION_SCHEMA_VERSION,
} from "@station/contracts";
import {
  Deferred,
  Effect,
  Fiber,
  Queue,
  Ref,
  type RuntimeClock,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import type { StationLogger } from "../stationLogger.js";

export type HarnessIngressProcessResult = {
  receipt: HarnessEventReportReceipt;
  reconcileReason?: string | undefined;
};

export type HarnessIngressQueue = {
  enqueue(report: HarnessEventReport): HarnessEventReportReceipt;
  drain(): Promise<void>;
  shutdown(): Promise<void>;
  health(): HarnessIngressQueueHealth;
  recordSpoolDrain(input: { scanned: number; drained: number; failed: number }): void;
};

export type CreateHarnessIngressQueueOptions = {
  processReport(report: HarnessEventReport): Promise<HarnessIngressProcessResult>;
  requestReconcile?: (reason: string) => void;
  clock?: RuntimeClock;
  logger?: StationLogger;
  maxPendingReports?: number;
};

type QueuedHarnessReport = {
  report: HarnessEventReport;
  receivedAt: string;
};

type ReadyKey = {
  key: string;
};

type QueueMetrics = {
  enqueued: number;
  processed: number;
  coalesced: number;
  dropped: number;
  failed: number;
  lastProcessedAt?: string;
  lastError?: SafeError;
  lastDrain?: HarnessIngressQueueHealth["lastDrain"];
};

type HarnessIngressQueueState = {
  pending: Map<string, QueuedHarnessReport>;
  seenReportIds: Set<string>;
  seenReportIdOrder: string[];
  metrics: QueueMetrics;
  active: number;
  shuttingDown: boolean;
  waiters: Deferred.Deferred<void>[];
};

type EnqueueStateResult = {
  receipt: HarnessEventReportReceipt;
  readyKey?: string;
};

const maxRememberedReportIds = 10_000;
const defaultMaxPendingReports = 10_000;

export function createHarnessIngressQueue(
  options: CreateHarnessIngressQueueOptions,
): HarnessIngressQueue {
  const clock = options.clock ?? systemClock;
  const maxPendingReports = options.maxPendingReports ?? defaultMaxPendingReports;
  const workQueue = Effect.runSync(Queue.unbounded<ReadyKey>());
  const state = Effect.runSync(Ref.make<HarnessIngressQueueState>(initialState()));
  const worker = Effect.runFork(
    Queue.take(workQueue).pipe(
      Effect.flatMap(({ key }) => processKey(key)),
      Effect.forever,
    ),
  );

  const queue: HarnessIngressQueue = {
    enqueue: (inputReport) => {
      const report = HarnessEventReportSchema.parse(inputReport);
      const receivedAt = toIsoTimestamp(clock.now());

      const result = Effect.runSync(
        Ref.modify(state, (current) =>
          enqueueInState(current, report, receivedAt, maxPendingReports),
        ),
      );
      if (result.readyKey !== undefined) {
        void Effect.runFork(Queue.offer(workQueue, { key: result.readyKey }));
      }
      return result.receipt;
    },

    drain: () => Effect.runPromise(drainEffect()),

    shutdown: () =>
      Effect.runPromise(
        updateState((current) => [undefined, { ...current, shuttingDown: true }] as const).pipe(
          Effect.zipRight(drainEffect()),
          Effect.zipRight(Queue.shutdown(workQueue)),
          Effect.zipRight(Fiber.interrupt(worker)),
          Effect.asVoid,
        ),
      ),

    health: () => {
      const current = Effect.runSync(Ref.get(state));
      const metrics = current.metrics;
      const health: HarnessIngressQueueHealth = {
        depth: current.pending.size + current.active,
        enqueued: metrics.enqueued,
        processed: metrics.processed,
        coalesced: metrics.coalesced,
        dropped: metrics.dropped,
        failed: metrics.failed,
      };
      if (metrics.lastProcessedAt !== undefined) {
        health.lastProcessedAt = metrics.lastProcessedAt;
      }
      if (metrics.lastError !== undefined) {
        health.lastError = metrics.lastError;
      }
      if (metrics.lastDrain !== undefined) {
        health.lastDrain = metrics.lastDrain;
      }
      return health;
    },

    recordSpoolDrain: (input) => {
      Effect.runSync(
        Ref.update(state, (current) => recordSpoolDrainInState(current, input, clock)),
      );
    },
  };

  function drainEffect(): Effect.Effect<void> {
    return Effect.gen(function* () {
      const waiter = yield* Deferred.make<void>();
      const alreadyIdle = yield* Ref.modify(state, (current) => {
        if (isIdle(current)) {
          return [true, current] as const;
        }
        const waiters: Deferred.Deferred<void>[] = [...current.waiters, waiter];
        return [false, { ...current, waiters }] as const;
      });

      if (!alreadyIdle) {
        yield* Deferred.await(waiter);
      }
    });
  }

  function processKey(key: string): Effect.Effect<void> {
    return Effect.gen(function* () {
      const queued = yield* updateState((current) => takeQueuedReport(current, key));
      if (queued === undefined) {
        return;
      }

      const reconcileReason = yield* Effect.tryPromise({
        try: () => options.processReport(queued.report),
        catch: (error) =>
          safeErrorFromUnknown(error, {
            tag: "HarnessIngressQueueError",
            code: "HARNESS_INGRESS_PROCESS_FAILED",
            message: "Observer harness ingress queue could not process a queued report.",
            provider: queued.report.provider,
          }),
      }).pipe(
        Effect.flatMap((result) =>
          updateState(
            (current) => [result.reconcileReason, recordProcessed(current, result, clock)] as const,
          ),
        ),
        Effect.catchAll((error) =>
          updateState((current) => [undefined, recordFailed(current, error, clock)] as const).pipe(
            Effect.zipRight(logProcessingError(queued.report, error)),
            Effect.as(undefined),
          ),
        ),
        Effect.ensuring(updateState((current) => [undefined, decrementActive(current)] as const)),
      );

      if (reconcileReason !== undefined) {
        options.requestReconcile?.(reconcileReason);
      }
    });
  }

  function updateState<A>(
    f: (current: HarnessIngressQueueState) => readonly [A, HarnessIngressQueueState],
  ): Effect.Effect<A> {
    return Ref.modify(
      state,
      (current): readonly [readonly [A, Deferred.Deferred<void>[]], HarnessIngressQueueState] => {
        const [value, next] = f(current);
        if (!isIdle(next) || next.waiters.length === 0) {
          const waiters: Deferred.Deferred<void>[] = [];
          return [[value, waiters] as const, next] as const;
        }
        const waiters = next.waiters;
        return [[value, waiters] as const, { ...next, waiters: [] }] as const;
      },
    ).pipe(
      Effect.flatMap(([value, waiters]) =>
        Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, undefined), {
          discard: true,
        }).pipe(Effect.as(value)),
      ),
    );
  }

  function logProcessingError(report: HarnessEventReport, error: SafeError): Effect.Effect<void> {
    const logger = options.logger;
    if (logger === undefined) {
      return Effect.succeed(undefined);
    }
    return Effect.tryPromise({
      try: async () => {
        await logger.error("Harness ingress queue processing failed.", {
          provider: report.provider,
          reportId: report.reportId,
          error,
        });
      },
      catch: (logError) =>
        safeErrorFromUnknown(logError, {
          tag: "HarnessIngressQueueError",
          code: "HARNESS_INGRESS_LOG_FAILED",
          message: "Observer harness ingress queue could not log a processing failure.",
          provider: report.provider,
        }),
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
  }

  return queue;
}

function initialState(): HarnessIngressQueueState {
  return {
    pending: new Map(),
    seenReportIds: new Set(),
    seenReportIdOrder: [],
    metrics: {
      enqueued: 0,
      processed: 0,
      coalesced: 0,
      dropped: 0,
      failed: 0,
    },
    active: 0,
    shuttingDown: false,
    waiters: [],
  };
}

function enqueueInState(
  current: HarnessIngressQueueState,
  report: HarnessEventReport,
  receivedAt: string,
  maxPendingReports: number,
): readonly [EnqueueStateResult, HarnessIngressQueueState] {
  if (current.shuttingDown) {
    const error: SafeError = {
      tag: "CancellationError",
      code: "HARNESS_INGRESS_QUEUE_SHUTTING_DOWN",
      message: "Observer harness ingress queue is shutting down.",
      provider: report.provider,
    };
    return [
      { receipt: rejectedReceipt(report, receivedAt, error) },
      recordDropped(current, error),
    ] as const;
  }

  if (current.seenReportIds.has(report.reportId)) {
    return [{ receipt: acceptedReceipt(report, receivedAt, true) }, current] as const;
  }

  const key = coalesceKey(report);
  const alreadyPending = current.pending.has(key);
  if (!alreadyPending && current.pending.size + current.active >= maxPendingReports) {
    const error: SafeError = {
      tag: "BackpressureError",
      code: "HARNESS_INGRESS_QUEUE_FULL",
      message: "Observer harness ingress queue is full.",
      provider: report.provider,
    };
    return [
      { receipt: rejectedReceipt(report, receivedAt, error) },
      recordDropped(current, error),
    ] as const;
  }

  const pending = new Map(current.pending);
  pending.set(key, { report, receivedAt });

  const metrics: QueueMetrics = {
    ...current.metrics,
    enqueued: current.metrics.enqueued + 1,
  };
  if (alreadyPending) {
    metrics.coalesced = current.metrics.coalesced + 1;
  }

  const { seenReportIds, seenReportIdOrder } = rememberReportId(current, report.reportId);
  const result: EnqueueStateResult = {
    receipt: acceptedReceipt(report, receivedAt, false),
  };
  if (!alreadyPending) {
    result.readyKey = key;
  }

  return [
    result,
    {
      ...current,
      pending,
      seenReportIds,
      seenReportIdOrder,
      metrics,
    },
  ] as const;
}

function takeQueuedReport(
  current: HarnessIngressQueueState,
  key: string,
): readonly [QueuedHarnessReport | undefined, HarnessIngressQueueState] {
  const queued = current.pending.get(key);
  if (queued === undefined) {
    return [undefined, current] as const;
  }

  const pending = new Map(current.pending);
  pending.delete(key);
  return [queued, { ...current, pending, active: current.active + 1 }] as const;
}

function recordProcessed(
  current: HarnessIngressQueueState,
  result: HarnessIngressProcessResult,
  clock: RuntimeClock,
): HarnessIngressQueueState {
  const metrics: QueueMetrics = {
    ...current.metrics,
    processed: current.metrics.processed + 1,
    lastProcessedAt: toIsoTimestamp(clock.now()),
  };
  if (result.receipt.status === "rejected") {
    metrics.failed = current.metrics.failed + 1;
    if (result.receipt.error !== undefined) {
      metrics.lastError = result.receipt.error;
    }
  }
  return { ...current, metrics };
}

function recordFailed(
  current: HarnessIngressQueueState,
  error: SafeError,
  clock: RuntimeClock,
): HarnessIngressQueueState {
  return {
    ...current,
    metrics: {
      ...current.metrics,
      failed: current.metrics.failed + 1,
      lastProcessedAt: toIsoTimestamp(clock.now()),
      lastError: error,
    },
  };
}

function recordDropped(
  current: HarnessIngressQueueState,
  error: SafeError,
): HarnessIngressQueueState {
  return {
    ...current,
    metrics: {
      ...current.metrics,
      dropped: current.metrics.dropped + 1,
      lastError: error,
    },
  };
}

function recordSpoolDrainInState(
  current: HarnessIngressQueueState,
  input: { scanned: number; drained: number; failed: number },
  clock: RuntimeClock,
): HarnessIngressQueueState {
  return {
    ...current,
    metrics: {
      ...current.metrics,
      lastDrain: {
        scanned: input.scanned,
        drained: input.drained,
        failed: input.failed,
        finishedAt: toIsoTimestamp(clock.now()),
      },
    },
  };
}

function decrementActive(current: HarnessIngressQueueState): HarnessIngressQueueState {
  return { ...current, active: Math.max(0, current.active - 1) };
}

function isIdle(current: HarnessIngressQueueState): boolean {
  return current.pending.size === 0 && current.active === 0;
}

function rememberReportId(
  current: HarnessIngressQueueState,
  reportId: string,
): Pick<HarnessIngressQueueState, "seenReportIds" | "seenReportIdOrder"> {
  const seenReportIds = new Set(current.seenReportIds);
  const seenReportIdOrder = [...current.seenReportIdOrder, reportId];
  seenReportIds.add(reportId);
  while (seenReportIdOrder.length > maxRememberedReportIds) {
    const oldReportId = seenReportIdOrder.shift();
    if (oldReportId !== undefined) {
      seenReportIds.delete(oldReportId);
    }
  }
  return { seenReportIds, seenReportIdOrder };
}

function acceptedReceipt(
  report: HarnessEventReport,
  receivedAt: string,
  deduped: boolean,
): HarnessEventReportReceipt {
  return HarnessEventReportReceiptSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: report.reportId,
    provider: report.provider,
    eventType: report.eventType,
    accepted: true,
    status: "accepted",
    receivedAt,
    projected: false,
    scheduledReconcile: !deduped,
    deduped,
  });
}

function rejectedReceipt(
  report: HarnessEventReport,
  receivedAt: string,
  error: SafeError,
): HarnessEventReportReceipt {
  return HarnessEventReportReceiptSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: report.reportId,
    provider: report.provider,
    eventType: report.eventType,
    accepted: false,
    status: "rejected",
    receivedAt,
    projected: false,
    scheduledReconcile: false,
    error,
  });
}

function coalesceKey(report: HarnessEventReport): string {
  const correlation = report.correlation;
  const stableAgentKey =
    correlation?.harnessRunId ??
    correlation?.sessionId ??
    correlation?.worktreeId ??
    correlation?.terminalTargetId ??
    correlation?.cwd ??
    report.reportId;
  return [report.provider, stableAgentKey, report.eventType, report.coalesceKey ?? "-"].join(":");
}
