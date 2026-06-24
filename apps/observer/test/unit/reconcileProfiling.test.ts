import type { StationSnapshot } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandQueue } from "../../src/commands/queue";
import type { ObserverPersistence } from "../../src/persistence";
import type { ObserverCore } from "../../src/reconcile/core";
import { createObserverApi } from "../../src/runtime/api";
import { createObserverEventBus } from "../../src/runtime/eventBus";

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
  logger: JsonlLogger & { records: LogRecord[] };
  reconcileDelayMs: number;
  hookReconcileDebounceMs?: number;
}) {
  const eventBus = createObserverEventBus();
  const options = {
    core: fakeCore(input.reconcileDelayMs),
    persistence: fakePersistence(),
    commandQueue: fakeCommandQueue(),
    eventBus,
    clock: { now: () => new Date(now) },
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
      return snapshot();
    },
    projectHarnessEventStatus: async () => ({ projected: false, events: [] }),
    updateConfig: () => undefined,
    getProjects: () => [],
    getSnapshot: snapshot,
    getHealth: () => ({
      status: "healthy",
      startedAt: now,
      providerHealth: {},
    }),
  };
}

function fakePersistence(): ObserverPersistence {
  return {
    recordEventWithIngressDedupe: async () => ({ deduped: false }),
  } as unknown as ObserverPersistence;
}

function fakeCommandQueue(): CommandQueue {
  return {
    dispatch: async () => {
      throw new Error("dispatch is not used by reconcile profiling tests.");
    },
    drain: async () => undefined,
    shutdown: async () => undefined,
    registerHandler: () => undefined,
  };
}

type LogRecord = {
  level: string;
  message: string;
  attributes?: Record<string, unknown>;
};

function fakeLogger(): JsonlLogger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    path: "memory://observer.jsonl",
    records,
    log: async (record) => {
      records.push({
        level: record.level,
        message: record.message,
        attributes: record.attributes,
      });
      return {
        timestamp: now,
        component: "observer",
        level: record.level,
        message: record.message,
        ...(record.attributes === undefined ? {} : { attributes: record.attributes }),
      };
    },
    debug: async (message, attributes) => {
      records.push({ level: "debug", message, attributes });
      return logReturn("debug", message, attributes);
    },
    info: async (message, attributes) => {
      records.push({ level: "info", message, attributes });
      return logReturn("info", message, attributes);
    },
    warn: async (message, attributes) => {
      records.push({ level: "warn", message, attributes });
      return logReturn("warn", message, attributes);
    },
    error: async (message, attributes) => {
      records.push({ level: "error", message, attributes });
      return logReturn("error", message, attributes);
    },
  };
}

function logReturn(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  attributes?: Record<string, unknown>,
) {
  return {
    timestamp: now,
    component: "observer" as const,
    level,
    message,
    ...(attributes === undefined ? {} : { attributes }),
  };
}

function snapshot(): StationSnapshot {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    generatedAt: now,
    observer: {
      pid: 1,
      startedAt: now,
      version: "0.0.0",
      healthy: true,
    },
    providerHealth: {},
    projects: [],
    rows: [],
    sessions: [],
    counts: {
      projects: 0,
      worktrees: 0,
      agents: 0,
      working: 0,
      idle: 0,
      attention: 0,
      unknown: 0,
    },
    alerts: [],
  };
}
