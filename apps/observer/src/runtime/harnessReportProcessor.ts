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
  /** Requests canonical convergence when immediate projection cannot establish visible state. */
  requestReconcile: (reason: string) => void;
  /** Requests quiet-period convergence after immediate projection establishes visible state. */
  requestProjectedReconcile: (reason: string) => void;
  refreshProviderHealth?: (providerId: string) => Promise<void>;
  logger?: StationLogger;
};

function reportDecisionFields(report: HarnessEventReport): Record<string, unknown> {
  const fields: Record<string, unknown> = {
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
  if (report.diagnostics?.correlationIssue !== undefined) {
    fields.correlationIssue = report.diagnostics.correlationIssue;
  }
  return fields;
}

/**
 * USE CASE
 *
 * Persists one normalized report, projects authorized live status, publishes derived events,
 * revalidates contradictory provider health, and requests canonical convergence.
 */
export async function processHarnessIngressReport(
  deps: HarnessReportProcessorDeps,
  rawReport: HarnessEventReport,
): Promise<HarnessEventReportReceipt> {
  // Resolve cwd-only correlation before ingest so the persisted observation
  // carries the worktreeId too, not just this projection pass.
  const snapshot = deps.core.getSnapshot();
  const report = withSessionCorrelationFromSnapshot(
    withWorktreeCorrelationFromCwd(rawReport, snapshot),
    snapshot,
  );
  const receipt = await deps.harnessEventReportIngestion.ingest(report);
  if (!receipt.accepted || receipt.deduped === true) {
    await deps.logger?.info("Harness event report skipped.", {
      ...reportDecisionFields(report),
      accepted: receipt.accepted,
      deduped: receipt.deduped === true,
    });
    return receipt;
  }
  const reconcileReason = `harness-report:${report.provider}:${report.eventType}`;
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
    const projectedReceipt = HarnessEventReportReceiptSchema.parse({
      ...receipt,
      error: projection.error,
    });
    deps.requestReconcile(reconcileReason);
    return projectedReceipt;
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
  const refreshProviderHealth = deps.refreshProviderHealth;
  const shouldRevalidateProviderHealth =
    projection.value.projected &&
    report.status?.value === "starting" &&
    projection.value.snapshot.providerHealth[report.provider]?.status === "unavailable" &&
    refreshProviderHealth !== undefined;
  if (shouldRevalidateProviderHealth) {
    void refreshProviderHealth(report.provider).catch((error) =>
      deps.logger
        ?.error("Provider health revalidation after harness startup failed.", {
          provider: report.provider,
          reportId: report.reportId,
          error,
        })
        .catch(() => undefined),
    );
  }
  if (projection.value.projected) {
    deps.requestProjectedReconcile(reconcileReason);
  } else {
    deps.requestReconcile(reconcileReason);
  }
  return receipt;
}
