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
  /** Last status that requested a reconcile for each native session with a withheld Station identity. */
  withheldIdentityRequests: Map<string, WithheldIdentityRequest>;
  refreshProviderHealth?: (providerId: string) => Promise<void>;
  logger?: StationLogger;
};

export type WithheldIdentityRequest = { statusKey: string; requestedAtMs: number };

// Well inside the 15-minute busy-status decay, so a repeated status still refreshes before it can expire.
const withheldIdentityRepeatIntervalMs = 2 * 60 * 1000;
const withheldIdentityPruneThreshold = 256;

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

// A report whose Station identity was withheld stays diagnostic-only, so a reconcile cannot
// project it; one only helps when the session's status changes, and repeats wait for the interval.
function shouldRequestReconcileForUnprojected(
  deps: HarnessReportProcessorDeps,
  report: HarnessEventReport,
): boolean {
  const nativeSessionId = report.correlation?.nativeSessionId;
  if (report.diagnostics?.correlationIssue === undefined || nativeSessionId === undefined) {
    return true;
  }
  const requests = deps.withheldIdentityRequests;
  const nowMs = deps.clock.now().getTime();
  const key = `${report.provider}:${nativeSessionId}`;
  const statusKey = `${report.status?.value}:${report.status?.attention}`;
  const previous = requests.get(key);
  if (
    previous?.statusKey === statusKey &&
    nowMs - previous.requestedAtMs < withheldIdentityRepeatIntervalMs
  ) {
    return false;
  }
  if (requests.size >= withheldIdentityPruneThreshold) {
    for (const [staleKey, request] of requests) {
      if (nowMs - request.requestedAtMs >= withheldIdentityRepeatIntervalMs) {
        requests.delete(staleKey);
      }
    }
  }
  requests.set(key, { statusKey, requestedAtMs: nowMs });
  return true;
}

/**
 * USE CASE
 *
 * Persists one normalized report, projects authorized live status, publishes derived events,
 * revalidates contradictory provider health, and requests canonical convergence. An unprojected
 * report with a withheld Station identity requests it only when its session's status changes or
 * the same status has not requested one for two minutes.
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
  } else if (shouldRequestReconcileForUnprojected(deps, report)) {
    deps.requestReconcile(reconcileReason);
  }
  return receipt;
}
