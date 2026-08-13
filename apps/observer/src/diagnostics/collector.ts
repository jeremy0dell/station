import type { ConfigDiagnostic, StationConfig } from "@station/config";
import type {
  DiagnosticCollectionOptions,
  DiagnosticSnapshot,
  DoctorCheck,
  DoctorOptions,
  DoctorReport,
  HarnessProvider,
  LogRecord,
  ProviderDoctorCheck,
  ProviderDoctorContext,
  ProviderHealth,
  RepositoryProvider,
  SafeError,
  TerminalProvider,
  WorktreeProvider,
} from "@station/contracts";
import {
  DiagnosticSnapshotSchema,
  DoctorReportSchema,
  STATION_SCHEMA_VERSION,
} from "@station/contracts";
import { mergeRetentionPolicy } from "@station/observability";
import type { RuntimeClock } from "@station/runtime";
import { runRuntimeBoundaryWithTimeout, systemClock, toIsoTimestamp } from "@station/runtime";
import { commandRecordFromPersisted } from "../commands/record.js";
import type {
  CommandJournal,
  EventJournal,
  PersistedCommand,
  PersistedCommandError,
  PersistedEvent,
  PersistenceHealthSource,
} from "../persistence/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ObserverCore } from "../reconcile/core.js";
import type { ObserverReapPlan } from "../runtime/observerReap.js";
import { buildSessionEnvironmentCheck } from "./environmentCheck.js";
import type { DiagnosticEvidenceSource } from "./evidenceSource.js";

export type ObserverDiagnosticsDeps = {
  config: StationConfig;
  configPath?: string;
  configDiagnostics?: ConfigDiagnostic[];
  core: ObserverCore;
  commandJournal: CommandJournal;
  eventJournal: EventJournal;
  persistenceHealth: PersistenceHealthSource;
  evidenceSource: DiagnosticEvidenceSource;
  providers?: ProviderRegistry;
  clock?: RuntimeClock;
  providerDoctorTimeoutMs?: number;
  duplicateInspection?: () => Promise<ObserverReapPlan> | undefined;
};

type DiagnosticCollectionResult = {
  snapshot: DiagnosticSnapshot;
  diagnosticsDir: string;
  recentLogPaths?: string[];
};

/**
 * USE CASE
 *
 * Aggregates current core health, purpose-specific journals, persistence health,
 * configuration, and typed local evidence into a bounded read-only diagnostic snapshot.
 */
export async function collectDiagnosticSnapshot(
  deps: ObserverDiagnosticsDeps,
  options: DiagnosticCollectionOptions = {},
): Promise<DiagnosticSnapshot> {
  return (await collectDiagnosticResult(deps, options ?? {})).snapshot;
}

async function collectDiagnosticResult(
  deps: ObserverDiagnosticsDeps,
  options: NonNullable<DiagnosticCollectionOptions>,
): Promise<DiagnosticCollectionResult> {
  const clock = deps.clock ?? systemClock;
  const collectedAt = toIsoTimestamp(clock.now());
  const coreHealth = deps.core.getHealth();
  const snapshot = deps.core.getSnapshot();
  const sqliteHealth = deps.persistenceHealth.health();
  const commands = await deps.commandJournal.listCommands();
  const latestFailure = options.latestFailure
    ? commands.findLast((command) => command.status === "failed")
    : undefined;
  const commandIdFilter = options.commandId ?? latestFailure?.id;
  const traceIdFilter = options.traceId ?? latestFailure?.traceId;
  const hasCommandFilter = commandIdFilter !== undefined || traceIdFilter !== undefined;
  const filteredCommands = filterCommands(commands, {
    commandId: commandIdFilter,
    traceId: traceIdFilter,
  });
  const commandIds = new Set<string>();
  if (commandIdFilter !== undefined) commandIds.add(commandIdFilter);
  const traceIds = new Set<string>();
  if (traceIdFilter !== undefined) traceIds.add(traceIdFilter);
  if (hasCommandFilter) {
    for (const command of filteredCommands) {
      commandIds.add(command.id);
      if (command.traceId !== undefined) traceIds.add(command.traceId);
    }
  }
  const eventFilter: { commandId?: string } = {};
  if (commandIdFilter !== undefined) {
    eventFilter.commandId = commandIdFilter;
  }
  const events = (await deps.eventJournal.listEvents(eventFilter)).filter((event) =>
    persistedEventMatches(event, { commandIds, traceIds }),
  );
  const commandErrors = (await deps.commandJournal.listCommandErrors(commandIdFilter)).filter(
    (error) => commandErrorMatches(error, { commandIds, traceIds }),
  );
  const policy = mergeRetentionPolicy(deps.config.observability?.retention);
  const localStateEvidence = await deps.evidenceSource.scanLocalState(policy);
  const maxLogRecords = options.maxLogRecords ?? 500;
  const recentLogEvidence =
    options.includeLogs === false
      ? undefined
      : await deps.evidenceSource.readRecentLogs(maxLogRecords);
  const logs = prioritizeLogs(
    recentLogEvidence?.records ?? [],
    { commandIds, traceIds },
    maxLogRecords,
  );
  const hookSpool = await deps.evidenceSource.summarizeHookSpool();
  const observerHealth: DiagnosticSnapshot["observerHealth"] = {
    schemaVersion: STATION_SCHEMA_VERSION,
    ...coreHealth,
    pid: snapshot.observer.pid,
    version: snapshot.observer.version,
    stateDir: localStateEvidence.usage.stateDir,
    sqlite: sqliteHealth,
  };
  if (localStateEvidence.socketPath !== undefined) {
    observerHealth.socketPath = localStateEvidence.socketPath;
  }

  const diagnosticSnapshot: DiagnosticSnapshot = {
    schemaVersion: STATION_SCHEMA_VERSION,
    collectedAt,
    observerHealth,
    snapshot,
    providerHealth: snapshot.providerHealth,
    commands: filteredCommands.map(commandRecordFromPersisted),
    events: events.map((event) => event.event),
    errors: commandErrors.map((error) => error.envelope),
    logs,
    configSummary: configSummary(deps),
    localState: localStateEvidence.usage,
    retention: policy,
  };
  if (hookSpool !== undefined) {
    diagnosticSnapshot.hookSpool = hookSpool;
  }

  const result: DiagnosticCollectionResult = {
    snapshot: DiagnosticSnapshotSchema.parse(diagnosticSnapshot),
    diagnosticsDir: localStateEvidence.diagnosticsDir,
  };
  if (recentLogEvidence !== undefined) {
    result.recentLogPaths = recentLogEvidence.paths;
  }
  return result;
}

/**
 * USE CASE
 *
 * Aggregates current runtime, persistence, provider, typed local, and
 * singleton-cleanup evidence into the read-only health report. Top-level health
 * comes from current checks; persisted command errors remain historical evidence.
 */
export async function runDoctor(
  deps: ObserverDiagnosticsDeps,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const clock = deps.clock ?? systemClock;
  const collection = await collectDiagnosticResult(deps, {
    includeLogs: true,
    maxLogRecords: 50,
  });
  const doctorSnapshot = requireDoctorSnapshotState(collection.snapshot);
  const recentLogPaths = requireDoctorRecentLogPaths(collection);
  const providerHealth = await collectProviderHealth(deps);
  const providers = {
    ...doctorSnapshot.providerHealth,
    ...providerHealth,
  };
  const providerChecks = await collectProviderDoctorChecks(deps, options);
  const duplicatePlan = await deps.duplicateInspection?.();
  const sqliteCheck: DoctorCheck = {
    name: "sqlite",
    status: doctorSnapshot.observerHealth.sqlite?.status === "healthy" ? "ok" : "warn",
    message: `SQLite is ${doctorSnapshot.observerHealth.sqlite?.status ?? "unavailable"}.`,
  };
  if (doctorSnapshot.observerHealth.sqlite?.lastError !== undefined) {
    sqliteCheck.error = doctorSnapshot.observerHealth.sqlite.lastError;
  }

  const checks: DoctorCheck[] = [
    {
      name: "observer",
      status: doctorSnapshot.observerHealth.status === "healthy" ? "ok" : "warn",
      message: `Observer is ${doctorSnapshot.observerHealth.status}.`,
    },
    {
      name: "config",
      status: doctorSnapshot.configSummary.diagnostics.length === 0 ? "ok" : "warn",
      message: `${doctorSnapshot.configSummary.projectCount} project(s) configured.`,
    },
    sqliteCheck,
    buildObserverSingletonCheck(duplicatePlan),
    {
      name: "providers",
      status: providerStatus(providers) === "healthy" ? "ok" : "warn",
      message: `${Object.keys(providers).length} provider(s) reported health.`,
    },
    ...providerChecks,
    buildSessionEnvironmentCheck(doctorSnapshot.snapshot),
    {
      name: "retention",
      status: doctorSnapshot.localState.overLimit ? "warn" : "ok",
      message: `Local state uses ${doctorSnapshot.localState.totalBytes} bytes.`,
    },
  ];
  const recentErrors = doctorSnapshot.errors.map((error) => errorToSafeError(error));
  const status = checks.some((check) => check.status === "error")
    ? "unavailable"
    : checks.some((check) => check.status === "warn")
      ? "degraded"
      : "healthy";

  const report: DoctorReport = {
    schemaVersion: STATION_SCHEMA_VERSION,
    generatedAt: toIsoTimestamp(clock.now()),
    status,
    checks,
    observer: doctorSnapshot.observerHealth,
    config: doctorSnapshot.configSummary,
    providers,
    snapshot: doctorSnapshot.snapshot,
    logs: {
      paths: recentLogPaths,
      recent: doctorSnapshot.logs,
    },
    localState: doctorSnapshot.localState,
    retention: doctorSnapshot.retention,
    recentErrors,
    debugBundle: {
      available: true,
      diagnosticsDir: collection.diagnosticsDir,
    },
  };
  if (doctorSnapshot.observerHealth.sqlite !== undefined) {
    report.sqlite = doctorSnapshot.observerHealth.sqlite;
  }
  if (doctorSnapshot.hookSpool !== undefined) {
    report.hooks = doctorSnapshot.hookSpool;
  }

  return DoctorReportSchema.parse(report);
}

function buildObserverSingletonCheck(plan: ObserverReapPlan | undefined): DoctorCheck {
  if (plan === undefined || (plan.duplicates === 0 && plan.refusals.length === 0)) {
    return {
      name: "observer-singleton",
      status: "ok",
      message: "No duplicate Observer process requires operator action.",
    };
  }
  if (plan.targets.some((target) => target.automaticEligibility.eligible)) {
    return {
      name: "observer-singleton",
      status: "warn",
      message:
        "A duplicate Observer candidate was reported but not signaled; inspect it with `stn observer reap`.",
    };
  }
  return {
    name: "observer-singleton",
    status: "warn",
    message:
      "Singleton inspection could not prove a safe action; inspect refusal evidence with `stn observer reap`.",
  };
}

function filterCommands(
  commands: readonly PersistedCommand[],
  filter: { commandId?: string | undefined; traceId?: string | undefined },
): PersistedCommand[] {
  return commands.filter((command) => {
    if (filter.commandId !== undefined && command.id !== filter.commandId) {
      return false;
    }
    if (filter.traceId !== undefined && command.traceId !== filter.traceId) {
      return false;
    }
    return true;
  });
}

function persistedEventMatches(
  event: PersistedEvent,
  filter: { commandIds: ReadonlySet<string>; traceIds: ReadonlySet<string> },
): boolean {
  if (filter.commandIds.size === 0 && filter.traceIds.size === 0) {
    return true;
  }
  return (
    (event.commandId !== undefined && filter.commandIds.has(event.commandId)) ||
    (event.traceId !== undefined && filter.traceIds.has(event.traceId))
  );
}

function commandErrorMatches(
  error: PersistedCommandError,
  filter: { commandIds: ReadonlySet<string>; traceIds: ReadonlySet<string> },
): boolean {
  if (filter.commandIds.size === 0 && filter.traceIds.size === 0) {
    return true;
  }
  return (
    filter.commandIds.has(error.commandId) ||
    (error.envelope.traceId !== undefined && filter.traceIds.has(error.envelope.traceId))
  );
}

function prioritizeLogs(
  logs: readonly LogRecord[],
  filter: { commandIds: ReadonlySet<string>; traceIds: ReadonlySet<string> },
  maxRecords: number,
): LogRecord[] {
  if (filter.commandIds.size === 0 && filter.traceIds.size === 0) {
    return logs.slice(-maxRecords);
  }

  const matching = logs.filter((log) => logMatches(log, filter));
  if (matching.length >= maxRecords) {
    return matching.slice(-maxRecords);
  }
  const contextLimit = Math.min(50, maxRecords - matching.length);
  const context = logs.filter((log) => !logMatches(log, filter)).slice(-contextLimit);
  return [...matching, ...context];
}

function logMatches(
  log: LogRecord,
  filter: { commandIds: ReadonlySet<string>; traceIds: ReadonlySet<string> },
): boolean {
  const attributeCommandId = stringAttribute(log.attributes, "commandId");
  const attributeTraceId = stringAttribute(log.attributes, "traceId");
  return (
    (log.commandId !== undefined && filter.commandIds.has(log.commandId)) ||
    (attributeCommandId !== undefined && filter.commandIds.has(attributeCommandId)) ||
    (log.traceId !== undefined && filter.traceIds.has(log.traceId)) ||
    (attributeTraceId !== undefined && filter.traceIds.has(attributeTraceId))
  );
}

function stringAttribute(
  attributes: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = attributes?.[key];
  return typeof value === "string" ? value : undefined;
}

function configSummary(
  deps: ObserverDiagnosticsDeps,
): NonNullable<DiagnosticSnapshot["configSummary"]> {
  const summary: NonNullable<DiagnosticSnapshot["configSummary"]> = {
    projectCount: deps.config.projects.length,
    diagnostics: (deps.configDiagnostics ?? []).map((diagnostic) => {
      const error: SafeError = {
        tag: "ConfigError",
        code: diagnostic.code,
        message: diagnostic.message,
      };
      if (diagnostic.projectId !== undefined) {
        error.projectId = diagnostic.projectId;
      }
      return error;
    }),
  };
  if (deps.configPath !== undefined) {
    summary.configPath = deps.configPath;
  }
  return summary;
}

function providerStatus(providers: Record<string, ProviderHealth>): "healthy" | "degraded" {
  return Object.values(providers).some(
    (health) => health.status === "degraded" || health.status === "unavailable",
  )
    ? "degraded"
    : "healthy";
}

function errorToSafeError(error: DiagnosticSnapshot["errors"][number]): SafeError {
  const safeError: SafeError = {
    tag: error.tag,
    code: error.code,
    message: error.message,
    diagnosticId: error.id,
  };
  if (error.commandId !== undefined) safeError.commandId = error.commandId;
  if (error.projectId !== undefined) safeError.projectId = error.projectId;
  if (error.worktreeId !== undefined) safeError.worktreeId = error.worktreeId;
  if (error.sessionId !== undefined) safeError.sessionId = error.sessionId;
  if (error.provider !== undefined) safeError.provider = error.provider;
  if (error.traceId !== undefined) safeError.traceId = error.traceId;
  return safeError;
}

type DoctorDiagnosticSnapshot = DiagnosticSnapshot & {
  configSummary: NonNullable<DiagnosticSnapshot["configSummary"]>;
  localState: NonNullable<DiagnosticSnapshot["localState"]>;
  retention: NonNullable<DiagnosticSnapshot["retention"]>;
};

function requireDoctorSnapshotState(snapshot: DiagnosticSnapshot): DoctorDiagnosticSnapshot {
  if (snapshot.configSummary === undefined) {
    throw missingDoctorStateError("configSummary");
  }
  if (snapshot.localState === undefined) {
    throw missingDoctorStateError("localState");
  }
  if (snapshot.retention === undefined) {
    throw missingDoctorStateError("retention");
  }
  return snapshot as DoctorDiagnosticSnapshot;
}

function requireDoctorRecentLogPaths(result: DiagnosticCollectionResult): string[] {
  if (result.recentLogPaths === undefined) {
    throw missingDoctorStateError("recentLogs");
  }
  return result.recentLogPaths;
}

function missingDoctorStateError(field: string): SafeError {
  return {
    tag: "DiagnosticCollectionError",
    code: "DIAGNOSTIC_REQUIRED_STATE_MISSING",
    message: `Diagnostic snapshot is missing required ${field}.`,
  };
}

async function collectProviderDoctorChecks(
  deps: ObserverDiagnosticsDeps,
  options: DoctorOptions,
): Promise<ProviderDoctorCheck[]> {
  if (deps.providers === undefined) {
    return [];
  }

  const checks: ProviderDoctorCheck[] = [];
  const context: ProviderDoctorContext = {
    projects:
      options?.projectId === undefined
        ? deps.config.projects
        : deps.config.projects.filter((project) => project.id === options.projectId),
  };
  if (options?.providerHookRuntime === undefined) {
    if (deps.configPath !== undefined) {
      context.stationConfigPath = deps.configPath;
    }
  } else {
    context.providerHookRuntime = options.providerHookRuntime;
    if (options.providerHookRuntime.stationConfigPath !== undefined) {
      context.stationConfigPath = options.providerHookRuntime.stationConfigPath;
    }
  }
  const providers = providerEntries(deps.providers);

  for (const { provider } of providers) {
    if (provider.doctorChecks === undefined) {
      continue;
    }
    const timeoutMs = deps.providerDoctorTimeoutMs ?? 5000;
    const result = await runRuntimeBoundaryWithTimeout(
      {
        operation: `observer.doctor.providerChecks.${provider.id}`,
        clock: deps.clock,
        timeoutMs,
        error: {
          tag: "ProviderDiagnosticError",
          code: "PROVIDER_DOCTOR_CHECK_FAILED",
          message: "Provider doctor checks failed.",
          provider: provider.id,
        },
        timeoutError: {
          tag: "TimeoutError",
          code: "PROVIDER_DOCTOR_CHECK_TIMEOUT",
          message: "Provider doctor checks timed out.",
          provider: provider.id,
        },
      },
      async ({ signal }) =>
        provider.doctorChecks?.({
          ...context,
          signal,
          timeoutMs,
        }) ?? [],
    );

    if (result.ok) {
      checks.push(...result.value);
    } else {
      checks.push({
        name: `${provider.id}-diagnostics`,
        status: "error",
        message: result.error.message,
        error: result.error,
      });
    }
  }

  return checks;
}

async function collectProviderHealth(
  deps: ObserverDiagnosticsDeps,
): Promise<Record<string, ProviderHealth>> {
  if (deps.providers === undefined) {
    return {};
  }

  const clock = deps.clock ?? systemClock;
  const health: Record<string, ProviderHealth> = {};
  for (const { provider, providerType } of providerEntries(deps.providers)) {
    const result = await runRuntimeBoundaryWithTimeout(
      {
        operation: `observer.doctor.providerHealth.${provider.id}`,
        clock,
        timeoutMs: deps.providerDoctorTimeoutMs ?? 5000,
        error: {
          tag: "ProviderDiagnosticError",
          code: "PROVIDER_HEALTH_CHECK_FAILED",
          message: "Provider health check failed.",
          provider: provider.id,
        },
        timeoutError: {
          tag: "TimeoutError",
          code: "PROVIDER_HEALTH_CHECK_TIMEOUT",
          message: "Provider health check timed out.",
          provider: provider.id,
        },
      },
      async () => provider.health(),
    );

    if (result.ok) {
      health[provider.id] = result.value;
    } else {
      health[provider.id] = {
        providerId: provider.id,
        providerType,
        status: "unavailable",
        lastCheckedAt: toIsoTimestamp(clock.now()),
        lastError: result.error,
      };
    }
  }

  return health;
}

type DoctorProviderEntry = {
  provider: WorktreeProvider | TerminalProvider | HarnessProvider | RepositoryProvider;
  providerType: ProviderHealth["providerType"];
};

function providerEntries(providers: ProviderRegistry): DoctorProviderEntry[] {
  return [
    { provider: providers.worktree, providerType: "worktree" },
    ...[...providers.terminals.values()].map((provider) => ({
      provider,
      providerType: "terminal" as const,
    })),
    ...[...providers.harnesses.values()].map((provider) => ({
      provider,
      providerType: "harness" as const,
    })),
    ...[...providers.repositories.values()].map((provider) => ({
      provider,
      providerType: "repository" as const,
    })),
  ];
}
