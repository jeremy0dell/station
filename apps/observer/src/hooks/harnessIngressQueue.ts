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
  type RuntimeClock,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import type { StationLogger } from "../stationLogger.js";

export type HarnessIngressQueue = {
  enqueue(report: HarnessEventReport): HarnessEventReportReceipt;
  drain(): Promise<void>;
  shutdown(): Promise<void>;
  health(): HarnessIngressQueueHealth;
  recordSpoolDrain(input: { scanned: number; drained: number; failed: number }): void;
};

export type CreateHarnessIngressQueueOptions = {
  processReport(report: HarnessEventReport): Promise<HarnessEventReportReceipt>;
  clock?: RuntimeClock;
  logger?: StationLogger;
  maxPendingReports?: number;
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

const maxRememberedReportIds = 10_000;
const defaultMaxPendingReports = 10_000;

export function createHarnessIngressQueue(
  options: CreateHarnessIngressQueueOptions,
): HarnessIngressQueue {
  const clock = options.clock ?? systemClock;
  const maxPendingReports = options.maxPendingReports ?? defaultMaxPendingReports;
  const pending = new Map<string, HarnessEventReport>();
  const readyKeys = new Set<string>();
  const seenReportIds = new Set<string>();
  const drainWaiters = new Set<() => void>();
  const metrics: QueueMetrics = {
    enqueued: 0,
    processed: 0,
    coalesced: 0,
    dropped: 0,
    failed: 0,
  };
  let active = 0;
  let workerRunning = false;
  let shuttingDown = false;

  const queue: HarnessIngressQueue = {
    enqueue: (inputReport) => {
      const report = HarnessEventReportSchema.parse(inputReport);
      const receivedAt = toIsoTimestamp(clock.now());
      if (shuttingDown) {
        const error: SafeError = {
          tag: "CancellationError",
          code: "HARNESS_INGRESS_QUEUE_SHUTTING_DOWN",
          message: "Observer harness ingress queue is shutting down.",
          provider: report.provider,
        };
        metrics.dropped += 1;
        metrics.lastError = error;
        return rejectedReceipt(report, receivedAt, error);
      }
      if (seenReportIds.has(report.reportId)) {
        return acceptedReceipt(report, receivedAt, true);
      }

      const key = coalesceKey(report);
      const alreadyPending = pending.has(key);
      if (!alreadyPending && pending.size + active >= maxPendingReports) {
        const error: SafeError = {
          tag: "BackpressureError",
          code: "HARNESS_INGRESS_QUEUE_FULL",
          message: "Observer harness ingress queue is full.",
          provider: report.provider,
        };
        metrics.dropped += 1;
        metrics.lastError = error;
        return rejectedReceipt(report, receivedAt, error);
      }

      pending.set(key, report);
      metrics.enqueued += 1;
      if (alreadyPending) metrics.coalesced += 1;
      rememberReportId(report.reportId);
      if (!alreadyPending) {
        readyKeys.add(key);
        startWorker();
      }
      return acceptedReceipt(report, receivedAt, false);
    },

    drain: () => {
      if (pending.size === 0 && active === 0) return Promise.resolve();
      return new Promise<void>((resolve) => drainWaiters.add(resolve));
    },

    shutdown: async () => {
      shuttingDown = true;
      await queue.drain();
    },

    health: () => {
      const health: HarnessIngressQueueHealth = {
        depth: pending.size + active,
        enqueued: metrics.enqueued,
        processed: metrics.processed,
        coalesced: metrics.coalesced,
        dropped: metrics.dropped,
        failed: metrics.failed,
      };
      if (metrics.lastProcessedAt !== undefined) health.lastProcessedAt = metrics.lastProcessedAt;
      if (metrics.lastError !== undefined) health.lastError = metrics.lastError;
      if (metrics.lastDrain !== undefined) health.lastDrain = metrics.lastDrain;
      return health;
    },

    recordSpoolDrain: (input) => {
      metrics.lastDrain = {
        scanned: input.scanned,
        drained: input.drained,
        failed: input.failed,
        finishedAt: toIsoTimestamp(clock.now()),
      };
    },
  };

  // Defer processing once so one synchronous ingress burst can coalesce before work begins.
  function startWorker(): void {
    if (workerRunning) return;
    workerRunning = true;
    queueMicrotask(() => {
      void runWorker().finally(() => {
        workerRunning = false;
        if (readyKeys.size > 0) startWorker();
        resolveDrainWaiters();
      });
    });
  }

  async function runWorker(): Promise<void> {
    while (readyKeys.size > 0) {
      const key = readyKeys.values().next().value;
      if (key === undefined) return;
      readyKeys.delete(key);
      const report = pending.get(key);
      if (report === undefined) continue;
      pending.delete(key);
      active += 1;
      try {
        const receipt = await options.processReport(report);
        metrics.processed += 1;
        metrics.lastProcessedAt = toIsoTimestamp(clock.now());
        if (receipt.status === "rejected") {
          metrics.failed += 1;
          if (receipt.error !== undefined) metrics.lastError = receipt.error;
        }
      } catch (cause) {
        const error = safeErrorFromUnknown(cause, {
          tag: "HarnessIngressQueueError",
          code: "HARNESS_INGRESS_PROCESS_FAILED",
          message: "Observer harness ingress queue could not process a queued report.",
          provider: report.provider,
        });
        metrics.failed += 1;
        metrics.lastProcessedAt = toIsoTimestamp(clock.now());
        metrics.lastError = error;
        try {
          await options.logger?.error("Harness ingress queue processing failed.", {
            provider: report.provider,
            reportId: report.reportId,
            error,
          });
        } catch {
          // Queue progress and failure evidence do not depend on best-effort logging.
        }
      } finally {
        active -= 1;
        resolveDrainWaiters();
      }
    }
  }

  function resolveDrainWaiters(): void {
    if (pending.size > 0 || active > 0 || drainWaiters.size === 0) return;
    const waiters = [...drainWaiters];
    drainWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  function rememberReportId(reportId: string): void {
    seenReportIds.add(reportId);
    while (seenReportIds.size > maxRememberedReportIds) {
      const oldest = seenReportIds.values().next().value;
      if (oldest === undefined) return;
      seenReportIds.delete(oldest);
    }
  }

  return queue;
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
    error,
  });
}

function coalesceKey(report: HarnessEventReport): string {
  const correlation = report.correlation;
  const stableAgentKey =
    correlation?.nativeSessionId ??
    correlation?.harnessRunId ??
    correlation?.sessionId ??
    correlation?.worktreeId ??
    correlation?.terminalTargetId ??
    correlation?.cwd ??
    report.reportId;
  return [report.provider, stableAgentKey, report.eventType, report.coalesceKey ?? "-"].join(":");
}
