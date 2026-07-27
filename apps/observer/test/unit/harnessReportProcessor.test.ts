import type { HarnessEventReport, HarnessEventReportReceipt } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import type { HarnessEventReportIngestion } from "../../src/hooks/ingestion";
import type { ObserverCore } from "../../src/reconcile/core";
import type { ObserverEventBus } from "../../src/runtime/eventBus";
import {
  type HarnessReportProcessorDeps,
  processHarnessIngressReport,
} from "../../src/runtime/harnessReportProcessor";
import type { StationLogger } from "../../src/stationLogger";
import { emptyStationSnapshot } from "../support/testObserver";

const now = "2026-05-21T12:00:00.000Z";

type LogRecord = {
  message: string;
  attributes: Record<string, unknown> | undefined;
};

describe("harness report processor logging", () => {
  it("logs provider correlation issues separately from active-owner rejection", async () => {
    const records: LogRecord[] = [];
    const snapshot = emptyStationSnapshot(now);
    const logger: StationLogger = {
      info: (message, attributes) => {
        records.push({ message, attributes });
        return Promise.resolve();
      },
      warn: () => Promise.resolve(),
      error: () => Promise.resolve(),
    };
    const harnessEventReportIngestion: HarnessEventReportIngestion = {
      ingest: (report): Promise<HarnessEventReportReceipt> =>
        Promise.resolve({
          schemaVersion: STATION_SCHEMA_VERSION,
          reportId: report.reportId,
          provider: report.provider,
          eventType: report.eventType,
          accepted: true,
          status: "accepted",
          receivedAt: now,
          projected: false,
          scheduledReconcile: false,
          deduped: false,
        }),
    };
    const core: ObserverCore = {
      reconcile: () => Promise.resolve(snapshot),
      commitProviderHealthProbe: () => Promise.resolve(undefined),
      getSnapshot: () => snapshot,
      projectHarnessEventStatus: () =>
        Promise.resolve({
          projected: false,
          snapshot,
          events: [],
        }),
      clearTurnReadiness: () => undefined,
      updateConfig: () => undefined,
      getProjects: () => [],
      getHealth: () => ({
        status: "healthy",
        startedAt: now,
        providerHealth: {},
      }),
    };
    const eventBus: ObserverEventBus = {
      publish: () => undefined,
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true as const, value: undefined as never }),
        }),
      }),
    };
    const deps: HarnessReportProcessorDeps = {
      harnessEventReportIngestion,
      core,
      eventBus,
      clock: { now: () => new Date(now) },
      logger,
    };

    await processHarnessIngressReport(
      deps,
      report({
        reportId: "report_inherited_identity",
        nativeSessionId: "native_background",
        cwd: "/tmp/codex-home/.codex/memories",
        correlationIssue: "station_identity_cwd_mismatch",
      }),
    );
    await processHarnessIngressReport(
      deps,
      report({
        reportId: "report_active_owner_rejection",
        nativeSessionId: "native_foreign",
        sessionId: "ses_web_task",
        cwd: "/tmp/station/web/task",
      }),
    );

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      message: "Harness event report processed.",
      attributes: {
        reportId: "report_inherited_identity",
        projected: false,
        correlationIssue: "station_identity_cwd_mismatch",
      },
    });
    expect(records[1]).toMatchObject({
      message: "Harness event report processed.",
      attributes: {
        reportId: "report_active_owner_rejection",
        projected: false,
      },
    });
    expect(records[1]?.attributes).not.toHaveProperty("correlationIssue");
  });
});

describe("harness report provider health revalidation", () => {
  it("re-probes unavailable health after an accepted starting report projects", async () => {
    const { deps, refreshProviderHealth } = healthRevalidationDeps({
      healthStatus: "unavailable",
    });

    await processHarnessIngressReport(
      deps,
      report({
        reportId: "report_start",
        nativeSessionId: "native_start",
        cwd: "/tmp/station/web",
        status: "starting",
      }),
    );

    expect(refreshProviderHealth).toHaveBeenCalledOnce();
    expect(refreshProviderHealth).toHaveBeenCalledWith("codex");
  });

  it.each([
    { name: "healthy health", healthStatus: "healthy" as const },
    { name: "unknown health", healthStatus: "unknown" as const },
    { name: "missing health", healthStatus: undefined },
    {
      name: "a non-starting report",
      healthStatus: "unavailable" as const,
      status: "working" as const,
    },
    { name: "an unprojected report", healthStatus: "unavailable" as const, projected: false },
    { name: "a deduplicated report", healthStatus: "unavailable" as const, deduped: true },
    { name: "a rejected report", healthStatus: "unavailable" as const, accepted: false },
  ])("does not re-probe for $name", async (testCase) => {
    const { deps, refreshProviderHealth } = healthRevalidationDeps(testCase);

    await processHarnessIngressReport(
      deps,
      report({
        reportId: `report_${testCase.name.replaceAll(" ", "_")}`,
        nativeSessionId: "native_non_trigger",
        cwd: "/tmp/station/web",
        status: testCase.status ?? "starting",
      }),
    );

    expect(refreshProviderHealth).not.toHaveBeenCalled();
  });
});

function healthRevalidationDeps(input: {
  healthStatus?: "healthy" | "unavailable" | "unknown";
  projected?: boolean;
  accepted?: boolean;
  deduped?: boolean;
}) {
  const snapshot = emptyStationSnapshot(now);
  if (input.healthStatus !== undefined) {
    snapshot.providerHealth.codex = {
      providerId: "codex",
      providerType: "harness",
      status: input.healthStatus,
      lastCheckedAt: now,
    };
  }
  const accepted = input.accepted ?? true;
  const refreshProviderHealth = vi.fn(async () => undefined);
  const harnessEventReportIngestion: HarnessEventReportIngestion = {
    ingest: (ingestedReport): Promise<HarnessEventReportReceipt> =>
      Promise.resolve({
        schemaVersion: STATION_SCHEMA_VERSION,
        reportId: ingestedReport.reportId,
        provider: ingestedReport.provider,
        eventType: ingestedReport.eventType,
        accepted,
        status: accepted ? "accepted" : "rejected",
        receivedAt: now,
        projected: false,
        scheduledReconcile: false,
        deduped: input.deduped ?? false,
      }),
  };
  const core: ObserverCore = {
    reconcile: () => Promise.resolve(snapshot),
    commitProviderHealthProbe: () => Promise.resolve(undefined),
    getSnapshot: () => snapshot,
    projectHarnessEventStatus: () =>
      Promise.resolve({
        projected: input.projected ?? true,
        snapshot,
        events: [],
      }),
    clearTurnReadiness: () => undefined,
    updateConfig: () => undefined,
    getProjects: () => [],
    getHealth: () => ({
      status: "healthy",
      startedAt: now,
      providerHealth: snapshot.providerHealth,
    }),
  };
  const eventBus: ObserverEventBus = {
    publish: () => undefined,
    subscribe: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined as never }),
      }),
    }),
  };
  const deps: HarnessReportProcessorDeps = {
    harnessEventReportIngestion,
    core,
    eventBus,
    clock: { now: () => new Date(now) },
    refreshProviderHealth,
  };
  return { deps, refreshProviderHealth };
}

function report(input: {
  reportId: string;
  nativeSessionId: string;
  sessionId?: string;
  cwd: string;
  correlationIssue?: "station_identity_cwd_mismatch";
  status?: "starting" | "working";
}): HarnessEventReport {
  const status = input.status ?? "working";
  const result: HarnessEventReport = {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: "codex",
    kind: "harness",
    eventType: status === "starting" ? "SessionStart" : "PreToolUse",
    observedAt: now,
    status: {
      value: status,
      confidence: "medium",
      reason: "Codex is about to use Bash.",
      source: "harness_event",
      updatedAt: now,
    },
    correlation: {
      nativeSessionId: input.nativeSessionId,
      cwd: input.cwd,
    },
  };
  if (input.sessionId !== undefined) {
    result.correlation = { ...result.correlation, sessionId: input.sessionId };
  }
  if (input.correlationIssue !== undefined) {
    result.diagnostics = { correlationIssue: input.correlationIssue };
  }
  return result;
}
