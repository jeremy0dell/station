import type { ReconcileReceipt, StationEvent } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import { type RuntimeClock, runRuntimeBoundary } from "@station/runtime";
import type { WorktreeMetadataRefreshService } from "../metadata/refresh.js";
import type { ObserverCore } from "../reconcile/core.js";
import { agentStateChangedEventsFromReconcile } from "./agentEvents.js";
import type { ObserverEventBus } from "./eventBus.js";
import { elapsedMs, logReconcileProfile, type ReconcileProfile } from "./reconcileProfiling.js";

export type ReconcileGuard = { reconciling: boolean };

export type ReconcileExecutorDeps = {
  core: ObserverCore;
  eventBus: ObserverEventBus;
  metadataRefresh?: WorktreeMetadataRefreshService;
  logger?: JsonlLogger;
  clock: RuntimeClock;
  drainSpoolAndQueue: () => Promise<void>;
};

/**
 * USE CASE
 *
 * Replays pending ingress before scanning providers and then publishes the resulting Observer projection.
 */
export async function runReconcile(
  deps: ReconcileExecutorDeps,
  guard: ReconcileGuard,
  reason = "manual",
): Promise<ReconcileReceipt> {
  const profileStartedAt = Date.now();
  let drainMs = 0;
  let coreReconcileMs = 0;
  let publishMs = 0;
  let metadataRefreshScheduled = false;
  if (!guard.reconciling) {
    guard.reconciling = true;
    const drainStartedAt = Date.now();
    try {
      // The provider scan must observe every durable replay completed by this reconcile.
      await deps.drainSpoolAndQueue();
    } finally {
      drainMs = elapsedMs(drainStartedAt);
      guard.reconciling = false;
    }
  }

  const previousSnapshot = deps.core.getSnapshot();
  const coreReconcileStartedAt = Date.now();
  const result = await runRuntimeBoundary(
    {
      operation: "observer.reconcile",
      clock: deps.clock,
      error: {
        tag: "ObserverReconcileError",
        code: "OBSERVER_RECONCILE_FAILED",
        message: "Observer reconciliation failed.",
      },
    },
    () => deps.core.reconcile(reason),
  );
  coreReconcileMs = elapsedMs(coreReconcileStartedAt);

  if (!result.ok) {
    throw result.error;
  }

  const publishStartedAt = Date.now();
  const event: StationEvent = {
    type: "observer.reconciled",
    at: result.value.generatedAt,
    changed: 0,
  };
  for (const agentEvent of agentStateChangedEventsFromReconcile(previousSnapshot, result.value)) {
    deps.eventBus.publish(agentEvent);
  }
  deps.eventBus.publish(event);
  publishMs = elapsedMs(publishStartedAt);
  if (deps.metadataRefresh !== undefined) {
    metadataRefreshScheduled = true;
    void deps.metadataRefresh.refresh(result.value).catch(async (error: unknown) => {
      await deps.logger?.error("Worktree metadata refresh failed.", { error });
    });
  }
  const profile: ReconcileProfile = {
    reason,
    totalMs: elapsedMs(profileStartedAt),
    drainMs,
    coreReconcileMs,
    publishMs,
    metadataRefreshScheduled,
    rows: result.value.rows.length,
    projectsScanned: result.value.projects.length,
  };
  await logReconcileProfile(deps.logger, profile);
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reason,
    reconciledAt: result.value.generatedAt,
    snapshot: result.value,
  };
}
