import type { StationLogger } from "../stationLogger.js";
import type { ReconcileSchedulerFlushProfile } from "./reconcileScheduler.js";

export type ReconcileProfile = {
  reason: string;
  totalMs: number;
  drainMs: number;
  coreReconcileMs: number;
  publishMs: number;
  metadataRefreshScheduled: boolean;
  rows: number;
  projectsScanned: number;
};

export const profileSlowReconcileMs = 1000;
export const profileLargeQueueCount = 25;

export function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

export async function logReconcileSchedulerProfile(
  logger: StationLogger | undefined,
  profile: ReconcileSchedulerFlushProfile,
): Promise<void> {
  if (
    profile.durationMs < profileSlowReconcileMs &&
    profile.queuedCount < profileLargeQueueCount &&
    profile.queuedWhileRunning === 0
  ) {
    return;
  }
  await logger?.info("Reconcile scheduler profile.", profile);
}

export async function logReconcileProfile(
  logger: StationLogger | undefined,
  profile: ReconcileProfile,
): Promise<void> {
  if (profile.totalMs < profileSlowReconcileMs) {
    return;
  }
  await logger?.info("Reconcile profile.", profile);
}
