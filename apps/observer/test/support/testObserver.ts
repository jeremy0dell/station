import type { StationConfig } from "@station/config";
import { STATION_SCHEMA_VERSION, type StationSnapshot } from "@station/contracts";
import type { CommandQueue } from "../../src/commands/queue";
import {
  createCommandQueue,
  createObserverApi,
  createObserverCore,
  createObserverEventBus,
  createSqliteObserverPersistence,
  type ObserverIdFactory,
  openObserverSqlite,
  type ProviderRegistry,
} from "../../src/internal";

export type TestClock = { now: () => Date };

export function fakeObserverCommandQueue(): CommandQueue {
  return {
    dispatch: async () => {
      throw new Error("dispatch is not used by this test.");
    },
    drain: async () => undefined,
    shutdown: async () => undefined,
    registerHandler: () => undefined,
  };
}

export function emptyStationSnapshot(generatedAt: string): StationSnapshot {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    generatedAt,
    observer: {
      pid: 1,
      startedAt: generatedAt,
      version: "0.0.0",
      healthy: true,
    },
    providerHealth: {},
    projects: [],
    rows: [],
    sessions: [],
    counts: {
      projects: 0,
      sessions: 0,
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

/** Sequential id factory mirroring the per-file `ids()` helper the tests used to inline. */
export function createTestIdFactory() {
  let command = 0;
  let event = 0;
  let observation = 0;
  return {
    commandId: () => `cmd_${++command}`,
    eventId: () => `evt_${++event}`,
    observationId: () => `obs_${++observation}`,
  };
}

export type CreateTestObserverCoreInput = {
  config: StationConfig;
  providers: ProviderRegistry;
  clock: TestClock;
  /** Override the in-memory sqlite location (tests that persist under a state dir). */
  sqlitePath?: string;
  idFactory?: ObserverIdFactory;
};

/**
 * The persistence-backed core half of the stack (sqlite → persistence → core), for
 * tests that reconcile and assert persisted state without the api/eventBus/queue.
 * Builds no reconcile scheduler or metadata-refresh service, so there is nothing to tear down.
 */
export function createTestObserverCore(input: CreateTestObserverCoreInput) {
  const { config, providers, clock } = input;
  const sqliteOptions: { clock: TestClock; path?: string } = { clock };
  if (input.sqlitePath !== undefined) sqliteOptions.path = input.sqlitePath;
  const sqlite = openObserverSqlite(sqliteOptions);
  const persistence = createSqliteObserverPersistence({
    sqlite,
    clock,
    idFactory: input.idFactory ?? createTestIdFactory(),
  });
  const core = createObserverCore({ config, providers, persistence, clock });
  return { sqlite, persistence, core };
}

export type CreateTestObserverInput = CreateTestObserverCoreInput & {
  hookReconcileDebounceMs?: number;
};

/**
 * Wires the full sqlite → persistence → eventBus → commandQueue → core → api stack the
 * reconcile/report tests previously hand-rolled. Persistence and the command queue
 * each get their own id factory, preserving the two-factory layout of the inline setup.
 */
export function createTestObserver(input: CreateTestObserverInput) {
  const { config, providers, clock } = input;
  const { sqlite, persistence, core } = createTestObserverCore(input);
  const eventBus = createObserverEventBus();
  const commandQueue = createCommandQueue({
    persistence,
    clock,
    idFactory: createTestIdFactory(),
    eventBus,
  });
  const api = createObserverApi({
    core,
    providers,
    persistence,
    persistenceHealth: persistence,
    commandQueue,
    eventBus,
    clock,
    config,
    hookReconcileDebounceMs: input.hookReconcileDebounceMs ?? 0,
  });
  return { sqlite, persistence, eventBus, commandQueue, core, api };
}
