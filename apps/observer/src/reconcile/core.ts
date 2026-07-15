import type { StationConfig } from "@station/config";
import type {
  HarnessEventReport,
  ProviderHealth,
  ProviderProjectConfig,
  SafeError,
  StationEvent,
  StationSnapshot,
  WorktreeRow,
} from "@station/contracts";
import { ProviderProjectConfigSchema } from "@station/contracts";
import { type RuntimeClock, systemClock, toIsoTimestamp } from "@station/runtime";
import type { FeatureFlagEvaluator } from "../features/evaluator.js";
import {
  decideSessionHarnessExecution,
  sessionHarnessExecutionEvidenceFromReport,
} from "../harnessExecutionIdentity.js";
import type {
  EventJournal,
  ObservationStore,
  ReconcileStore,
  SessionStore,
  WorktreeMetadataStore,
} from "../persistence/index.js";
import { providerObservationRetentionDays } from "../persistence/retention.js";
import type { PersistedSessionTurnReadiness } from "../persistence/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { StationLogger } from "../stationLogger.js";
import {
  buildInitialSnapshot,
  harnessesFromRegistry,
  type ProviderReadOptions,
  runReconcileOnce,
} from "./run.js";
import {
  projectHarnessEventReportOntoSnapshot,
  type StatusProjectionResult,
} from "./statusProjection.js";

export type ReconcileTiming = {
  reason: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  projectsScanned: number;
  worktreesObserved: number;
  terminalTargetsObserved: number;
  harnessRunsObserved: number;
  eventsEmitted: number;
  errors: SafeError[];
};

export type ObserverCoreHealth = {
  status: "healthy" | "degraded";
  startedAt: string;
  providerHealth: Record<string, ProviderHealth>;
  lastReconcile?: ReconcileTiming;
};

export type ObserverCore = {
  reconcile(reason?: string): Promise<StationSnapshot>;
  projectHarnessEventStatus(report: HarnessEventReport): Promise<StatusProjectionResult>;
  clearTurnReadiness(input: { sessionId: string; token: string }): StationEvent | undefined;
  updateConfig(config: StationConfig): void;
  getProjects(): readonly ProviderProjectConfig[];
  getSnapshot(): StationSnapshot;
  getHealth(): ObserverCoreHealth;
};

export type CreateObserverCoreInput = {
  config: StationConfig;
  providers: ProviderRegistry;
  clock?: RuntimeClock;
  persistence?: ObservationStore &
    ReconcileStore &
    SessionStore &
    WorktreeMetadataStore &
    EventJournal;
  logger?: StationLogger;
  pid?: number;
  version?: string;
  providerTimeoutMs?: number;
  providerReadRetries?: number;
  featureFlags?: FeatureFlagEvaluator;
};

export function createObserverCore(input: CreateObserverCoreInput): ObserverCore {
  const clock = input.clock ?? systemClock;
  const startedAt = toIsoTimestamp(clock.now());
  const pid = input.pid ?? process.pid;
  const version = input.version ?? "0.0.0";
  const providerTimeoutMs = input.providerTimeoutMs ?? 5000;
  const providerReadRetries = input.providerReadRetries ?? 1;
  let config = input.config;
  let projects = providerProjectsFromConfig(config);
  // Binding authorization and base projection share ordering with reconciles so
  // an awaited authority read cannot commit through a superseding snapshot.
  let snapshotWriterChain: Promise<void> = Promise.resolve();
  let providerHealth: Record<string, ProviderHealth> = {};
  let lastReconcile: ReconcileTiming | undefined;
  let snapshot = buildInitialSnapshot({
    generatedAt: startedAt,
    observer: { pid, startedAt, version },
    projects,
    worktreeProviderId: input.providers.worktree.id,
    harnesses: harnessesFromRegistry(input.providers),
    ...(input.featureFlags === undefined
      ? {}
      : { featureFlags: input.featureFlags.clientSnapshot() }),
  });

  const read: ProviderReadOptions = {
    clock,
    timeoutMs: providerTimeoutMs,
    retries: providerReadRetries,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  };
  const observer = { pid, startedAt, version };
  const enqueueSnapshotWrite = <T>(write: () => Promise<T>): Promise<T> => {
    const execution = snapshotWriterChain.then(write);
    snapshotWriterChain = execution.catch(() => undefined).then(() => undefined);
    return execution;
  };

  return {
    reconcile: async (reason = "manual") => {
      const run = async (): Promise<StationSnapshot> => {
        const result = await runReconcileOnce({
          reason,
          observer,
          projects,
          providers: input.providers,
          read,
          ...(input.persistence === undefined ? {} : { persistence: input.persistence }),
          providerObservationRetentionDays: providerObservationRetentionDays(
            config.observability?.retention,
          ),
          ...(input.featureFlags === undefined
            ? {}
            : { featureFlags: input.featureFlags.clientSnapshot() }),
        });
        providerHealth = result.providerHealth;
        lastReconcile = result.lastReconcile;
        snapshot = result.snapshot;
        return snapshot;
      };

      return enqueueSnapshotWrite(run);
    },
    projectHarnessEventStatus: async (report) => {
      const result = await enqueueSnapshotWrite(async (): Promise<StatusProjectionResult> => {
        const sessionId = report.correlation?.sessionId;
        // Native reports remain diagnostic-only until a durable Station-session
        // binding can authorize their projection.
        if (
          report.correlation?.nativeSessionId !== undefined &&
          (input.persistence === undefined || sessionId === undefined)
        ) {
          return { projected: false, snapshot, events: [] };
        }
        if (input.persistence !== undefined && sessionId !== undefined) {
          const binding = await input.persistence.getSessionHarnessExecution({
            provider: report.provider,
            sessionId,
          });
          const decision = decideSessionHarnessExecution({
            current: binding,
            evidence: sessionHarnessExecutionEvidenceFromReport(report),
          });
          if (!decision.mayDeriveState) {
            return { projected: false, snapshot, events: [] };
          }
        }
        const projection = projectHarnessEventReportOntoSnapshot({
          snapshot,
          report,
          projectedAt: toIsoTimestamp(clock.now()),
        });
        if (projection.projected) {
          snapshot = projection.snapshot;
        }
        return projection;
      });
      if (!result.projected) {
        return result;
      }
      if (input.persistence === undefined) {
        return result;
      }
      const persisted = await persistTurnReadinessForReport({
        result,
        report,
        persistence: input.persistence,
        updatedAt: toIsoTimestamp(clock.now()),
      });
      if (persisted === undefined) {
        return result;
      }
      // A newer completion can win the readiness conflict while this write is pending.
      if (persisted.token !== report.reportId) {
        return { projected: false, snapshot, events: [] };
      }
      // Re-resolve against the live snapshot, which may have changed during the
      // upsert await, then apply the readiness marker synchronously.
      const applied = applyTurnReadinessToSnapshot(snapshot, persisted);
      if (applied === undefined) {
        // The live graph superseded this completion during the write; remove only
        // its marker and suppress the stale idle events that would notify hooks.
        await input.persistence.deleteSessionTurnReadiness({
          sessionId: persisted.sessionId,
          token: report.reportId,
        });
        return { projected: false, snapshot, events: [] };
      }
      snapshot = applied.snapshot;
      return {
        ...result,
        snapshot: applied.snapshot,
        events: [...result.events, applied.event],
      };
    },
    clearTurnReadiness: (clearInput) => {
      const match = snapshot.rows.find(
        (row) =>
          row.agent?.sessionId === clearInput.sessionId &&
          row.agent.turnReadiness?.token === clearInput.token,
      );
      if (match?.agent === undefined) {
        return undefined;
      }
      const nextAgent = { ...match.agent };
      delete nextAgent.turnReadiness;
      snapshot = {
        ...snapshot,
        rows: snapshot.rows.map((row) =>
          row.id === match.id
            ? {
                ...row,
                agent: nextAgent,
              }
            : row,
        ),
      };
      return {
        type: "worktree.updated",
        worktreeId: match.id,
        patch: {
          agent: nextAgent,
        },
      };
    },
    updateConfig: (nextConfig) => {
      config = nextConfig;
      projects = providerProjectsFromConfig(nextConfig);
    },
    getProjects: () => projects,
    getSnapshot: () => snapshot,
    getHealth: () => ({
      status: snapshot.observer.healthy ? "healthy" : "degraded",
      startedAt,
      providerHealth,
      ...(lastReconcile === undefined ? {} : { lastReconcile }),
    }),
  };
}

// Decides whether the completed turn should mark the session ready and, if so,
// persists the marker. Returns the persisted readiness (or undefined) without
// touching the in-memory snapshot, so the caller can apply it against the live
// snapshot after this await resolves.
async function persistTurnReadinessForReport(input: {
  result: StatusProjectionResult;
  report: HarnessEventReport;
  persistence: SessionStore;
  updatedAt: string;
}): Promise<PersistedSessionTurnReadiness | undefined> {
  // Readiness is an interval: a session active again (new turn, or a request
  // for the user mid-turn) makes ready_to_read stale. Without this closing
  // edge the badge survives on a working agent and cannot be acknowledged,
  // because snapshots only expose readiness on idle agents. Status drives the
  // clear regardless of turn.kind so this writer agrees with the ingress
  // readiness policy for identical input.
  const status = input.report.status?.value;
  if (status === "working" || status === "starting" || status === "needs_attention") {
    if (input.result.sessionId !== undefined) {
      await input.persistence.deleteSessionTurnReadiness({ sessionId: input.result.sessionId });
    }
    return undefined;
  }
  if (input.report.turn?.kind !== "turn_completed") {
    return undefined;
  }
  const sessionId = input.result.sessionId;
  const worktreeId = input.result.worktreeId;
  if (sessionId === undefined || worktreeId === undefined) {
    return undefined;
  }
  const row = input.result.snapshot.rows.find((candidate) => candidate.id === worktreeId);
  if (row?.agent?.state !== "idle" || row.agent.sessionId !== sessionId) {
    return undefined;
  }
  return input.persistence.upsertSessionTurnReadiness({
    sessionId,
    projectId: row.projectId,
    worktreeId,
    token: input.report.reportId,
    completedAt: input.report.status?.updatedAt ?? input.report.observedAt,
    updatedAt: input.updatedAt,
  });
}

// Applies a persisted readiness marker to the current snapshot. rowWithTurnReadiness
// re-checks the row is still idle and matches, so a row that went working (or away)
// during the persistence await is left untouched.
function applyTurnReadinessToSnapshot(
  snapshot: StationSnapshot,
  readiness: PersistedSessionTurnReadiness,
): { snapshot: StationSnapshot; event: StationEvent } | undefined {
  const row = snapshot.rows.find((candidate) => candidate.id === readiness.worktreeId);
  if (row === undefined) {
    return undefined;
  }
  const nextRow = rowWithTurnReadiness(row, readiness);
  if (nextRow === row) {
    return undefined;
  }
  const rows = snapshot.rows.map((candidate) =>
    candidate.id === readiness.worktreeId ? nextRow : candidate,
  );
  return {
    snapshot: { ...snapshot, rows },
    event: {
      type: "worktree.updated",
      worktreeId: readiness.worktreeId,
      patch: {
        agent: nextRow.agent,
      },
    },
  };
}

function rowWithTurnReadiness(
  row: WorktreeRow,
  readiness: PersistedSessionTurnReadiness,
): WorktreeRow {
  const agent = row.agent;
  if (
    agent?.state !== "idle" ||
    agent.sessionId !== readiness.sessionId ||
    row.id !== readiness.worktreeId ||
    row.projectId !== readiness.projectId
  ) {
    return row;
  }
  return {
    ...row,
    agent: {
      ...agent,
      turnReadiness: {
        state: "ready_to_read",
        token: readiness.token,
        completedAt: readiness.completedAt,
      },
    },
  };
}

export function providerProjectsFromConfig(config: StationConfig): ProviderProjectConfig[] {
  return config.projects.map((project) => {
    const providerProject: ProviderProjectConfig = {
      id: project.id,
      label: project.label,
      root: project.root,
      ...(project.defaultBranch === undefined ? {} : { defaultBranch: project.defaultBranch }),
      defaults: project.defaults,
      worktrunk: {
        enabled: project.worktrunk.enabled,
      },
    };
    if (project.worktrunk.base !== undefined) {
      providerProject.worktrunk.base = project.worktrunk.base;
    }
    if (project.worktrunk.managedRoot !== undefined) {
      providerProject.worktrunk.managedRoot = project.worktrunk.managedRoot;
    }
    if (project.worktrunk.includeMain !== undefined) {
      providerProject.worktrunk.includeMain = project.worktrunk.includeMain;
    }
    if (project.worktrunk.includeExternal !== undefined) {
      providerProject.worktrunk.includeExternal = project.worktrunk.includeExternal;
    }
    if (project.recoveryBreadcrumbs !== undefined) {
      providerProject.recoveryBreadcrumbs = {
        location: project.recoveryBreadcrumbs.location,
      };
      if (project.recoveryBreadcrumbs.path !== undefined) {
        providerProject.recoveryBreadcrumbs.path = project.recoveryBreadcrumbs.path;
      }
    }
    return ProviderProjectConfigSchema.parse(providerProject);
  });
}
