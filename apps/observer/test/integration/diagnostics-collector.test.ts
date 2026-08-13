import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import type { LogRecord, ProviderHealth } from "@station/contracts";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  type CommandJournal,
  collectDiagnosticSnapshot,
  type EventJournal,
  ProviderRegistry,
  runDoctor,
} from "../../src/internal";
import {
  FakeDiagnosticEvidenceSource,
  memoryRecentLogEvidence,
} from "../support/diagnosticEvidenceSources.js";
import { createTestObserverCore } from "../support/testObserver";

const now = "2026-05-20T12:00:00.000Z";

describe("observer diagnostics collector", () => {
  it("collects doctor and diagnostic snapshot data from substitutable local evidence", async () => {
    const clock = { now: () => new Date(now) };
    const providers = diagnosticProviders();
    const { sqlite, persistence, core } = createTestObserverCore({ config, providers, clock });
    const evidenceSource = new FakeDiagnosticEvidenceSource();
    const journals = diagnosticJournals(persistence);

    try {
      await providers.healthCache.refreshAll();
      await core.reconcile("diagnostics-test");
      const deps = {
        config,
        core,
        ...journals,
        persistenceHealth: persistence,
        providers,
        evidenceSource,
        clock,
      };

      await expect(collectDiagnosticSnapshot(deps)).resolves.toMatchObject({
        schemaVersion: "0.11.0",
        observerHealth: {
          stateDir: "memory://state",
          socketPath: "memory://observer-socket",
        },
        providerHealth: {
          "fake-worktree": { status: "healthy" },
        },
        localState: { stateDir: "memory://state" },
        hookSpool: { path: "urn:station:hook-spool", pending: 1 },
        retention: { maxDays: 14 },
      });
      await expect(runDoctor(deps)).resolves.toMatchObject({
        status: "healthy",
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "fake-provider-check", status: "ok" }),
        ]),
        logs: {
          paths: ["queue://observer-log", "queue://hook-log"],
          recent: [expect.objectContaining({ message: "Memory diagnostic evidence." })],
        },
        debugBundle: {
          available: true,
          diagnosticsDir: "memory://diagnostics",
        },
      });
      expect(journals.commandJournal).not.toBe(journals.eventJournal);
      expect(evidenceSource.scanLocalStateCalls).toHaveLength(2);
      expect(evidenceSource.readRecentLogsCalls).toEqual([500, 50]);
      expect(evidenceSource.summarizeHookSpoolCalls).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  it("does not request recent logs when collection excludes them", async () => {
    const clock = { now: () => new Date(now) };
    const providers = diagnosticProviders();
    const { sqlite, persistence, core } = createTestObserverCore({ config, providers, clock });
    const evidenceSource = new FakeDiagnosticEvidenceSource();

    try {
      await collectDiagnosticSnapshot(
        {
          config,
          core,
          ...diagnosticJournals(persistence),
          persistenceHealth: persistence,
          providers,
          evidenceSource,
          clock,
        },
        { includeLogs: false },
      );

      expect(evidenceSource.readRecentLogsCalls).toEqual([]);
      expect(evidenceSource.scanLocalStateCalls).toHaveLength(1);
      expect(evidenceSource.summarizeHookSpoolCalls).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("derives current health from checks while retaining command error evidence", async () => {
    const clock = { now: () => new Date(now) };
    const providers = diagnosticProviders();
    const { sqlite, persistence, core } = createTestObserverCore({ config, providers, clock });
    const deps = {
      config,
      core,
      ...diagnosticJournals(persistence),
      persistenceHealth: persistence,
      providers,
      evidenceSource: new FakeDiagnosticEvidenceSource(),
      clock,
    };

    try {
      await providers.healthCache.refreshAll();
      await core.reconcile("diagnostics-recovery-test");
      expect((await runDoctor(deps)).status).toBe("healthy");

      await persistence.recordCommandAccepted({
        commandId: "cmd_historical_failure",
        command: { type: "observer.reconcile", payload: { reason: "historical-failure" } },
        createdAt: now,
        traceId: "trc_historical_failure",
        spanId: "spn_historical_failure",
      });
      await persistence.markCommandFailed({
        commandId: "cmd_historical_failure",
        safeError: {
          tag: "ProjectConfigError",
          code: "PROJECT_ROOT_NOT_GIT",
          message: "Project root is not a Git repository.",
          commandId: "cmd_historical_failure",
          traceId: "trc_historical_failure",
        },
        envelope: {
          id: "err_historical_failure",
          tag: "ProjectConfigError",
          code: "PROJECT_ROOT_NOT_GIT",
          message: "Project root is not a Git repository.",
          severity: "error",
          commandId: "cmd_historical_failure",
          traceId: "trc_historical_failure",
          spanId: "spn_historical_failure",
          redacted: true,
          createdAt: now,
        },
        finishedAt: now,
      });

      const report = await runDoctor(deps);
      expect(report.checks.every((check) => check.status === "ok")).toBe(true);
      expect(report.status).toBe("healthy");
      expect(report.recentErrors).toContainEqual({
        tag: "ProjectConfigError",
        code: "PROJECT_ROOT_NOT_GIT",
        message: "Project root is not a Git repository.",
        diagnosticId: "err_historical_failure",
        commandId: "cmd_historical_failure",
        traceId: "trc_historical_failure",
      });
    } finally {
      sqlite.close();
    }
  });

  it("filters command-specific diagnostics and prioritizes matching logs", async () => {
    const clock = { now: () => new Date(now) };
    const providers = diagnosticProviders();
    const { sqlite, persistence, core } = createTestObserverCore({ config, providers, clock });
    await persistence.recordCommandAccepted({
      commandId: "cmd_match",
      command: { type: "observer.reconcile", payload: { reason: "match" } },
      createdAt: now,
      traceId: "trc_match",
      spanId: "spn_match",
    });
    await persistence.markCommandFailed({
      commandId: "cmd_match",
      safeError: {
        tag: "WorktreeProviderError",
        code: "WORKTRUNK_BRANCH_EXISTS",
        message: "Branch exists.",
        provider: "worktrunk",
        commandId: "cmd_match",
        traceId: "trc_match",
      },
      envelope: {
        id: "err_match",
        tag: "WorktreeProviderError",
        code: "WORKTRUNK_BRANCH_EXISTS",
        message: "Branch exists.",
        severity: "error",
        commandId: "cmd_match",
        traceId: "trc_match",
        spanId: "spn_match",
        provider: "worktrunk",
        redacted: true,
        createdAt: now,
      },
      finishedAt: now,
    });
    const records: LogRecord[] = [
      {
        timestamp: now,
        level: "error",
        component: "observer",
        message: "Other command failed.",
        attributes: { commandId: "cmd_other", traceId: "trc_other" },
      },
      {
        timestamp: now,
        level: "error",
        component: "observer",
        message: "Matching command failed.",
        attributes: { commandId: "cmd_match", traceId: "trc_match" },
      },
    ];
    const evidenceSource = new FakeDiagnosticEvidenceSource({
      recentLogs: memoryRecentLogEvidence(records),
    });

    try {
      const snapshot = await collectDiagnosticSnapshot(
        {
          config,
          core,
          ...diagnosticJournals(persistence),
          persistenceHealth: persistence,
          providers,
          evidenceSource,
          clock,
        },
        { commandId: "cmd_match" },
      );

      expect(snapshot.commands.map((command) => command.id)).toEqual(["cmd_match"]);
      expect(snapshot.errors.map((error) => error.id)).toEqual(["err_match"]);
      expect(snapshot.logs[0]?.attributes).toMatchObject({ commandId: "cmd_match" });
    } finally {
      sqlite.close();
    }
  });

  it("includes uncorrelated hook report events only in unfiltered diagnostics", async () => {
    const clock = { now: () => new Date(now) };
    const providers = diagnosticProviders();
    const { sqlite, persistence, core } = createTestObserverCore({ config, providers, clock });
    await persistence.recordCommandAccepted({
      commandId: "cmd_match",
      command: { type: "observer.reconcile", payload: { reason: "match" } },
      createdAt: now,
      traceId: "trc_match",
      spanId: "spn_match",
    });
    await persistence.recordEvent(
      {
        type: "harness.eventReported",
        at: now,
        reportId: "hook_report_1",
        provider: "codex",
        eventType: "PreToolUse",
      },
      { source: "hook", createdAt: now },
    );
    const deps = {
      config,
      core,
      ...diagnosticJournals(persistence),
      persistenceHealth: persistence,
      providers,
      evidenceSource: new FakeDiagnosticEvidenceSource(),
      clock,
    };

    try {
      const unfiltered = await collectDiagnosticSnapshot(deps);
      const commandFiltered = await collectDiagnosticSnapshot(deps, { commandId: "cmd_match" });

      expect(unfiltered.events).toContainEqual(
        expect.objectContaining({
          type: "harness.eventReported",
          provider: "codex",
          eventType: "PreToolUse",
        }),
      );
      expect(commandFiltered.events).not.toContainEqual(
        expect.objectContaining({ type: "harness.eventReported" }),
      );
    } finally {
      sqlite.close();
    }
  });

  it("cannot upgrade degraded core, provider, or persistence health from empty local evidence", async () => {
    const clock = { now: () => new Date(now) };
    const providers = new ProviderRegistry({
      worktree: new DegradedWorktreeProvider({ now }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const { sqlite, persistence, core } = createTestObserverCore({ config, providers, clock });
    const localState = new FakeDiagnosticEvidenceSource().localStateResult;
    localState.usage = {
      ...localState.usage,
      totalBytes: 0,
      entries: [],
    };
    const evidenceSource = new FakeDiagnosticEvidenceSource({
      localState,
      recentLogs: memoryRecentLogEvidence([]),
      hookSpool: undefined,
    });
    const sqliteFailure = {
      ...persistence.health(),
      open: false,
      status: "unavailable" as const,
      lastError: {
        tag: "SqliteError",
        code: "SQLITE_UNAVAILABLE",
        message: "SQLite is unavailable.",
      },
    };

    try {
      await core.reconcile("degraded-diagnostics");
      const report = await runDoctor({
        config,
        core,
        ...diagnosticJournals(persistence),
        persistenceHealth: { health: () => sqliteFailure },
        providers,
        evidenceSource,
        clock,
      });

      expect(report.status).toBe("degraded");
      expect(report.sqlite?.status).toBe("unavailable");
      expect(report.providers["fake-worktree"]?.status).toBe("unavailable");
      expect(report.localState.totalBytes).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("propagates local-evidence failures instead of synthesizing a healthy snapshot", async () => {
    const clock = { now: () => new Date(now) };
    const providers = diagnosticProviders();
    const { sqlite, persistence, core } = createTestObserverCore({ config, providers, clock });
    const evidenceSource = new FakeDiagnosticEvidenceSource();
    evidenceSource.scanLocalStateFailure = {
      tag: "DiagnosticEvidenceError",
      code: "LOCAL_DIAGNOSTIC_EVIDENCE_FAILED",
      message: "Local diagnostic evidence collection failed.",
    };

    try {
      await expect(
        collectDiagnosticSnapshot({
          config,
          core,
          ...diagnosticJournals(persistence),
          persistenceHealth: persistence,
          providers,
          evidenceSource,
          clock,
        }),
      ).rejects.toMatchObject({
        code: "LOCAL_DIAGNOSTIC_EVIDENCE_FAILED",
      });
      expect(evidenceSource.readRecentLogsCalls).toEqual([]);
      expect(evidenceSource.summarizeHookSpoolCalls).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});

function diagnosticProviders(): ProviderRegistry {
  return new ProviderRegistry({
    worktree: new ProviderDiagnosticWorktreeProvider({ now }),
    terminal: new FakeTerminalProvider({ now }),
    harnesses: [new FakeHarnessProvider({ now })],
  });
}

function diagnosticJournals(persistence: CommandJournal & EventJournal): {
  commandJournal: CommandJournal;
  eventJournal: EventJournal;
} {
  return {
    commandJournal: {
      recordCommandAccepted: (input) => persistence.recordCommandAccepted(input),
      markCommandStarted: (commandId, startedAt) =>
        persistence.markCommandStarted(commandId, startedAt),
      markCommandSucceeded: (commandId, finishedAt) =>
        persistence.markCommandSucceeded(commandId, finishedAt),
      markCommandFailed: (input) => persistence.markCommandFailed(input),
      getCommand: (commandId) => persistence.getCommand(commandId),
      listCommands: () => persistence.listCommands(),
      listCommandErrors: (commandId) => persistence.listCommandErrors(commandId),
    },
    eventJournal: {
      recordEvent: (event, options) => persistence.recordEvent(event, options),
      listEvents: (filter) => persistence.listEvents(filter),
    },
  };
}

class ProviderDiagnosticWorktreeProvider extends FakeWorktreeProvider {
  async doctorChecks() {
    return [
      {
        name: "fake-provider-check",
        status: "ok" as const,
        message: "Fake provider diagnostics are healthy.",
      },
    ];
  }
}

class DegradedWorktreeProvider extends FakeWorktreeProvider {
  override async health(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      providerType: "worktree",
      status: "unavailable",
      lastCheckedAt: now,
      lastError: {
        tag: "WorktreeProviderError",
        code: "FAKE_WORKTREE_UNAVAILABLE",
        message: "Fake worktree provider is unavailable.",
        provider: this.id,
      },
    };
  }
}

const config: StationConfig = {
  schemaVersion: 1,
  workspace: DEFAULT_WORKSPACE_CONFIG,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "fake-harness",
    layout: "agent-shell",
  },
  projects: [],
};
