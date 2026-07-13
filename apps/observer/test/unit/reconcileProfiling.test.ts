import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ObserverCore } from "../../src/reconcile/core";
import { createObserverApi } from "../../src/runtime/api";
import { createObserverEventBus } from "../../src/runtime/eventBus";
import type { StationLogger } from "../../src/stationLogger";
import { createInMemoryObserverPersistence } from "../support/inMemoryObserverPersistence";
import { emptyStationSnapshot, fakeObserverCommandQueue } from "../support/testObserver";

const now = "2026-05-20T12:00:00.000Z";

describe("observer reconcile profiling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs slow reconcile phase profiles with useful dimensions", async () => {
    vi.useFakeTimers();
    const logger = fakeLogger();
    const api = createProfilingApi({ logger, reconcileDelayMs: 1100 });

    const reconcile = api.reconcile("hook:batch(42)");
    await vi.advanceTimersByTimeAsync(1100);
    await reconcile;

    expect(logger.records).toEqual([
      {
        level: "info",
        message: "Reconcile profile.",
        attributes: expect.objectContaining({
          reason: "hook:batch(42)",
          metadataRefreshScheduled: true,
          rows: 0,
          projectsScanned: 0,
        }),
      },
    ]);
    expect(logger.records[0]?.attributes).toMatchObject({
      totalMs: expect.any(Number),
      drainMs: expect.any(Number),
      coreReconcileMs: expect.any(Number),
      publishMs: expect.any(Number),
    });
    expect(logger.records[0]?.attributes?.totalMs).toBeGreaterThanOrEqual(1000);
    expect(logger.records[0]?.attributes?.coreReconcileMs).toBeGreaterThanOrEqual(1000);
  });

  it("does not log fast reconcile profiles", async () => {
    const logger = fakeLogger();
    const api = createProfilingApi({ logger, reconcileDelayMs: 0 });

    await api.reconcile("manual");

    expect(logger.records).toEqual([]);
  });

  it("logs scheduler profiles for large hook queues even when reconcile is fast", async () => {
    vi.useFakeTimers();
    const logger = fakeLogger();
    const api = createProfilingApi({
      logger,
      reconcileDelayMs: 0,
      hookReconcileDebounceMs: 100,
    });

    const reports = Array.from({ length: 25 }, (_, index) =>
      api.ingestProviderHookEvent({
        schemaVersion: STATION_SCHEMA_VERSION,
        hookId: `hook_${index}`,
        provider: "worktrunk",
        kind: "worktree",
        event: "worktree.created",
        receivedAt: now,
      }),
    );
    await Promise.all(reports);
    await vi.advanceTimersByTimeAsync(100);

    expect(logger.records).toEqual([
      {
        level: "info",
        message: "Reconcile scheduler profile.",
        attributes: expect.objectContaining({
          reason: "hook:worktrunk:worktree.created",
          queuedCount: 25,
          queuedAfter: 0,
        }),
      },
    ]);
    expect(logger.records[0]?.attributes?.durationMs).toEqual(expect.any(Number));
    expect(logger.records[0]?.attributes?.waitMs).toEqual(expect.any(Number));
  });
});

function createProfilingApi(input: {
  logger: StationLogger & { records: LogRecord[] };
  reconcileDelayMs: number;
  hookReconcileDebounceMs?: number;
}) {
  const eventBus = createObserverEventBus();
  const clock = { now: () => new Date(now) };
  const options = {
    core: fakeCore(input.reconcileDelayMs),
    persistence: createInMemoryObserverPersistence({ clock }),
    persistenceHealth: {
      health: () => ({
        path: ":memory:",
        open: true,
        status: "healthy" as const,
        schemaVersion: 0,
        lastCheckedAt: now,
      }),
    },
    commandQueue: fakeObserverCommandQueue(),
    eventBus,
    clock,
    logger: input.logger,
    metadataRefresh: {
      refresh: async () => undefined,
      shutdown: async () => undefined,
    },
  };
  return createObserverApi(
    input.hookReconcileDebounceMs === undefined
      ? options
      : { ...options, hookReconcileDebounceMs: input.hookReconcileDebounceMs },
  );
}

function fakeCore(reconcileDelayMs: number): ObserverCore {
  return {
    reconcile: async () => {
      if (reconcileDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, reconcileDelayMs));
      }
      return emptyStationSnapshot(now);
    },
    projectHarnessEventStatus: async () => ({ projected: false, events: [] }),
    updateConfig: () => undefined,
    getProjects: () => [],
    getSnapshot: () => emptyStationSnapshot(now),
    getHealth: () => ({
      status: "healthy",
      startedAt: now,
      providerHealth: {},
    }),
  };
}

type LogRecord = {
  level: string;
  message: string;
  attributes?: Record<string, unknown>;
};

function fakeLogger(): StationLogger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const record = async (
    level: LogRecord["level"],
    message: string,
    attributes?: Record<string, unknown>,
  ): Promise<void> => {
    records.push({
      level,
      message,
      ...(attributes === undefined ? {} : { attributes }),
    });
  };
  return {
    records,
    info: (message, attributes) => record("info", message, attributes),
    warn: (message, attributes) => record("warn", message, attributes),
    error: (message, attributes) => record("error", message, attributes),
  };
}
