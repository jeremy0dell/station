import type { HarnessEventReport, HarnessEventReportReceipt } from "@station/contracts";
import { HarnessEventReportReceiptSchema } from "@station/contracts";
import { type RuntimeClock, runRuntimeBoundary } from "@station/runtime";
import type { HarnessEventReportIngestion } from "../hooks/ingestion.js";
import type { ObserverCore } from "../reconcile/core.js";
import {
  withSessionCorrelationFromSnapshot,
  withWorktreeCorrelationFromCwd,
} from "../reconcile/statusProjection.js";
import type { StationLogger } from "../stationLogger.js";
import type { ObserverEventBus } from "./eventBus.js";

export type HarnessReportProcessorDeps = {
  harnessEventReportIngestion: HarnessEventReportIngestion;
  core: ObserverCore;
  eventBus: ObserverEventBus;
  clock: RuntimeClock;
  logger?: StationLogger;
};

export type HarnessReportProcessResult = {
  receipt: HarnessEventReportReceipt;
  reconcileReason?: string;
};

function reportDecisionFields(report: HarnessEventReport): Record<string, unknown> {
  return {
    provider: report.provider,
    reportId: report.reportId,
    eventType: report.eventType,
    statusValue: report.status?.value,
    attention: report.status?.attention,
    correlation: {
      harnessRunId: report.correlation?.harnessRunId,
      nativeSessionId: report.correlation?.nativeSessionId,
      sessionId: report.correlation?.sessionId,
      worktreeId: report.correlation?.worktreeId,
      cwd: report.correlation?.cwd,
    },
  };
}

/**
 * USE CASE
 *
 * Accepts normalized harness evidence, projects accepted status, and schedules fresh graph truth.
 */
export async function processHarnessIngressReport(
  deps: HarnessReportProcessorDeps,
  rawReport: HarnessEventReport,
): Promise<HarnessReportProcessResult> {
  // Resolve cwd-only correlation before ingest so the persisted observation
  // carries the worktreeId too, not just this projection pass.
  const snapshot = deps.core.getSnapshot();
  const report = withSessionCorrelationFromSnapshot(
    withWorktreeCorrelationFromCwd(rawReport, snapshot),
    snapshot,
  );
  const receipt = await deps.harnessEventReportIngestion.ingest(report, {
    triggerReconcile: false,
  });
  if (!receipt.accepted || receipt.deduped === true) {
    await deps.logger?.info("Harness event report skipped.", {
      ...reportDecisionFields(report),
      accepted: receipt.accepted,
      deduped: receipt.deduped === true,
    });
    return { receipt };
  }
  const projection = await runRuntimeBoundary(
    {
      operation: "observer.harnessEventReport.projectStatus",
      clock: deps.clock,
      error: {
        tag: "StatusProjectionError",
        code: "STATUS_PROJECTION_FAILED",
        message: "Observer could not project the harness event status.",
        provider: report.provider,
      },
    },
    () => deps.core.projectHarnessEventStatus(report),
  );
  if (!projection.ok) {
    await deps.logger?.error("Harness event status projection failed.", {
      provider: report.provider,
      reportId: report.reportId,
      error: projection.error,
    });
    return {
      receipt: HarnessEventReportReceiptSchema.parse({
        ...receipt,
        projected: false,
        scheduledReconcile: true,
        error: projection.error,
      }),
      reconcileReason: `harness-report:${report.provider}:${report.eventType}`,
    };
  }
  // Census/debug trail: one line per report with the projection decision, so
  // unprojected (correlation-failed) reports are visible instead of vanishing.
  await deps.logger?.info("Harness event report processed.", {
    ...reportDecisionFields(report),
    projected: projection.value.projected,
    correlatedBy: projection.value.correlatedBy,
    worktreeId: projection.value.worktreeId,
    publishedEvents: projection.value.events.length,
  });
  for (const event of projection.value.events) {
    deps.eventBus.publish(event);
  }
  return {
    receipt: HarnessEventReportReceiptSchema.parse({
      ...receipt,
      projected: projection.value.projected,
      scheduledReconcile: true,
    }),
    reconcileReason: `harness-report:${report.provider}:${report.eventType}`,
  };
}
