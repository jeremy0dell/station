import type {
  DiagnosticSnapshot,
  DoctorReport,
  HarnessEventReportReceipt,
  ObserverApi,
  ObserverHealth,
  ObserverStopReceipt,
  ProviderHookReceipt,
  ReconcileReceipt,
  StationEvent,
  StationSnapshot,
} from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";

export const protocolTestNow = "2026-05-20T12:00:00.000Z";

export function createFakeObserverApi(
  overrides: Partial<ObserverApi> & { snapshot?: StationSnapshot } = {},
): ObserverApi {
  const snapshot = overrides.snapshot ?? emptySnapshot();
  return {
    health: async (): Promise<ObserverHealth> => healthyObserver(),
    stop: async (): Promise<ObserverStopReceipt> => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      stopped: true,
      at: protocolTestNow,
    }),
    getSnapshot: async () => snapshot,
    subscribe: () => stream([]),
    dispatch: async () => ({ commandId: "cmd_1", accepted: true, status: "accepted" }),
    getCommand: async () => undefined,
    reconcile: async (reason = "manual"): Promise<ReconcileReceipt> => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      reason,
      reconciledAt: protocolTestNow,
      snapshot,
    }),
    ingestProviderHookEvent: async (event): Promise<ProviderHookReceipt> => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: "hook_1",
      provider: event.provider,
      event: event.event,
      accepted: true,
      status: "ingested",
      receivedAt: event.receivedAt,
      reconciled: true,
    }),
    reportHarnessEvent: async (report): Promise<HarnessEventReportReceipt> => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      reportId: report.reportId,
      provider: report.provider,
      eventType: report.eventType,
      accepted: true,
      status: "accepted",
      receivedAt: report.observedAt,
      projected: false,
      scheduledReconcile: true,
    }),
    prepareExternalLaunch: async (params) => ({
      kind: "existing-session",
      sessionId: `ses_${params.worktreeId}`,
      harnessProvider: "fake-harness",
    }),
    reportExternalExit: async (params) => ({
      acknowledged: true,
      terminalTargetId: params.terminalTargetId,
    }),
    runDoctor: async (): Promise<DoctorReport> => doctorReport(snapshot),
    collectDiagnostics: async (): Promise<DiagnosticSnapshot> => diagnosticSnapshot(snapshot),
    ...overrides,
  };
}

export function emptySnapshot(): StationSnapshot {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    generatedAt: protocolTestNow,
    observer: {
      pid: 1234,
      startedAt: protocolTestNow,
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

export async function* stream(events: readonly StationEvent[]): AsyncIterable<StationEvent> {
  for (const event of events) {
    yield event;
  }
}

export function ids(prefix: string): () => string {
  let id = 0;
  return () => `${prefix}_${++id}`;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for predicate.");
}

function healthyObserver(): ObserverHealth {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    status: "healthy",
    pid: 1234,
    startedAt: protocolTestNow,
    version: "0.0.0",
  };
}

function diagnosticSnapshot(snapshot: StationSnapshot): DiagnosticSnapshot {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    collectedAt: protocolTestNow,
    observerHealth: healthyObserver(),
    snapshot,
    providerHealth: {},
    commands: [],
    events: [],
    errors: [],
    logs: [],
  };
}

function doctorReport(snapshot: StationSnapshot): DoctorReport {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    generatedAt: protocolTestNow,
    status: "healthy",
    checks: [
      {
        name: "observer",
        status: "ok",
        message: "Observer is healthy.",
      },
    ],
    observer: healthyObserver(),
    config: {
      projectCount: 0,
      diagnostics: [],
    },
    providers: {},
    snapshot,
    logs: {
      paths: [],
      recent: [],
    },
    localState: {
      stateDir: "/tmp/station/state",
      totalBytes: 0,
      limitBytes: 262144000,
      overLimit: false,
      entries: [],
    },
    retention: {
      maxDays: 14,
      maxTotalMb: 250,
      maxFileMb: 10,
      maxFilesPerComponent: 5,
      components: {
        observerMaxMb: 100,
        cliMaxMb: 25,
        tuiMaxMb: 25,
        hookRunnerMaxMb: 25,
        providerMaxMb: 75,
      },
      sqlite: {
        eventsMaxDays: 30,
        commandsMaxDays: 60,
        errorsMaxDays: 60,
        providerObservationsMaxDays: 14,
      },
      debugBundles: {
        maxBundles: 10,
        maxDays: 30,
      },
      hookSpool: {
        deliveredDeleteImmediately: true,
        failedMaxDays: 7,
        failedMaxItems: 1000,
      },
    },
    recentErrors: [],
    debugBundle: {
      available: true,
      diagnosticsDir: "/tmp/station/state/diagnostics",
    },
  };
}
