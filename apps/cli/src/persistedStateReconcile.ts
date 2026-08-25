import type { ObserverHealth, ReconcileReceipt, SafeError } from "@station/contracts";
import { parseStationObserverBuildVersion, runRuntimeBoundaryWithTimeout } from "@station/runtime";

/** Complete build-bearing identity for the Observer allowed to reconcile persisted state. */
export interface CurrentObserverIdentity {
  readonly pid: number;
  readonly startedAt: string;
  readonly version: string;
  readonly socketPath: string;
}

/** Caller intent for one identity-pinned persisted-state reconcile. */
export type PersistedStateReconcileInput = Readonly<{
  observerIdentity: CurrentObserverIdentity;
  reason?: string;
  timeoutMs?: number;
}>;
/**
 * DRIVEN PORT
 *
 * Creates reconcile-only authority pinned to one current Observer identity and timeout.
 */
export type PersistedStateReconcilePort = (
  request: Readonly<{ observerIdentity: CurrentObserverIdentity; timeoutMs: number }>,
) => Readonly<{ reconcile: (reason?: string) => Promise<ReconcileReceipt> }>;

export function requireCurrentObserverIdentity(
  health: Pick<ObserverHealth, "pid" | "startedAt" | "version" | "socketPath">,
  socketPath: string,
): CurrentObserverIdentity {
  if (
    health.pid === undefined ||
    health.startedAt === undefined ||
    health.version === undefined ||
    parseStationObserverBuildVersion(health.version).buildIdentity === undefined ||
    health.socketPath !== socketPath
  ) {
    throw reconcileIdentityError();
  }
  return { pid: health.pid, startedAt: health.startedAt, version: health.version, socketPath };
}

/**
 * USE CASE
 *
 * Reconciles persisted state through one exact current Observer without lifecycle authority.
 */
export async function reconcilePersistedState(
  input: PersistedStateReconcileInput,
  connect: PersistedStateReconcilePort,
): Promise<ReconcileReceipt> {
  const { observerIdentity, reason, timeoutMs = 30_000 } = input;
  const buildIdentity = parseStationObserverBuildVersion(observerIdentity.version).buildIdentity;
  if (!observerIdentity.socketPath || !buildIdentity) throw reconcileIdentityError();
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: "cli.reconcile.run",
      timeoutMs,
      error: {
        tag: "ReconcileCommandError",
        code: "RECONCILE_RPC_FAILED",
        message: "Reconcile command could not contact the observer.",
      },
      timeoutError: {
        tag: "TimeoutError",
        code: "RECONCILE_RPC_TIMEOUT",
        message: "Reconcile command timed out while contacting the observer.",
      },
    },
    async () => connect({ observerIdentity, timeoutMs }).reconcile(reason),
  );
  if (!result.ok) throw result.error;
  return result.value;
}

const reconcileIdentityError = (): SafeError => ({
  tag: "ReconcileCommandError",
  code: "RECONCILE_OBSERVER_IDENTITY_REQUIRED",
  message: "Persisted-state reconcile requires complete current Observer identity.",
  hint: "Retry after the Observer reports its PID, start time, build identity, and configured socket.",
});
