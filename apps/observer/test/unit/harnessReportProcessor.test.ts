import type { HarnessEventReport, HarnessEventReportReceipt } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { describe, expect, it } from "vitest";
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

function report(input: {
  reportId: string;
  nativeSessionId: string;
  sessionId?: string;
  cwd: string;
  correlationIssue?: "station_identity_cwd_mismatch";
}): HarnessEventReport {
  const result: HarnessEventReport = {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: "codex",
    kind: "harness",
    eventType: "PreToolUse",
    observedAt: now,
    status: {
      value: "working",
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
