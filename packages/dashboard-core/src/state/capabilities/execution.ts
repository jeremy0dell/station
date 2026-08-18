import type { SafeError } from "@station/contracts";
import type { ClientNotice } from "../../services/types.js";
import type { SessionActivationCapabilities } from "./activation.js";
import type { DashboardDismissalCapabilities } from "./dismissal.js";
import type { ManagedSessionCapabilities } from "./managedSessions.js";
import type { DashboardShellCapabilities } from "./shell.js";
import type { WorktreeRemovalCapabilities } from "./worktreeRemoval.js";

/** The renderer-selected capability groups required by every dashboard runtime. */
export type DashboardCapabilities = {
  activation: SessionActivationCapabilities;
  managedSessions: ManagedSessionCapabilities;
  worktreeRemoval: WorktreeRemovalCapabilities;
  shell: DashboardShellCapabilities;
  dismissal: DashboardDismissalCapabilities;
};

/** Dashboard-local optimistic state exposed while an injected capability executes. */
export type DashboardOptimisticPolicy = "none" | "pending-start" | "pending-create";

/** Whether a successful execution removes its local row or lets canonical projection replace it. */
export type DashboardExecutionSuccessDisposition = "remove-immediately" | "wait-for-canonical";

/** Whether a failed execution disappears or remains visible for the failed-row TTL. */
export type DashboardExecutionFailureDisposition = "remove-immediately" | "retain-failed";

/** Typed completion; successful work may carry a non-retryable warning for partial visibility. */
export type DashboardExecutionResult =
  | { kind: "success"; notice?: ClientNotice }
  | { kind: "notice"; notice: ClientNotice }
  | {
      kind: "failure";
      error: SafeError;
      disposition: DashboardExecutionFailureDisposition;
    };

/**
 * Execution lifecycle returned synchronously by an injected dashboard capability.
 *
 * The runtime applies `optimistic` before registering `completion` in its private
 * effect scope, then settles local state only while that scope remains open without
 * exposing the dashboard store to the capability implementation.
 */
export type DashboardExecutionHandle = {
  optimistic: DashboardOptimisticPolicy;
  successDisposition: DashboardExecutionSuccessDisposition;
  completion: Promise<DashboardExecutionResult>;
};

/** Build a no-row execution handle for a synchronous or asynchronous result. */
export function dashboardExecution(
  completion: Promise<DashboardExecutionResult> | DashboardExecutionResult,
  options: {
    optimistic?: DashboardOptimisticPolicy;
    successDisposition?: DashboardExecutionSuccessDisposition;
  } = {},
): DashboardExecutionHandle {
  return {
    optimistic: options.optimistic ?? "none",
    successDisposition: options.successDisposition ?? "remove-immediately",
    completion: Promise.resolve(completion),
  };
}
