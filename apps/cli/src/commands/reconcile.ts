import type { StationConfig } from "@station/config";
import type { ReconcileReceipt } from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import { runRuntimeBoundaryWithTimeout } from "@station/runtime";
import {
  type ObserverProcessDeps,
  type ObserverStatus,
  observerStatusErrorMessage,
  startObserver,
} from "../observerProcess.js";
import { resolveObserverPaths } from "../paths.js";

export type ReconcileCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
};

export async function runReconcileCommand(
  args: string[],
  options: ReconcileCommandOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ReconcileReceipt> {
  const parsed = parseReconcileArgs(args);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const paths = resolveObserverPaths(options.config);
  const status = await startObserver({ ...options, paths, timeoutMs }, deps);
  assertRunning(status);
  const client =
    deps.clientFactory?.(paths.socketPath) ??
    createObserverClient({ socketPath: paths.socketPath, timeoutMs });
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
    async () => client.reconcile(parsed.reason),
  );
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function parseReconcileArgs(args: string[]): { reason?: string } {
  if (args.length === 0) {
    return {};
  }
  if (args[0] !== "--reason") {
    throw new Error(`Unknown reconcile option: ${args[0] ?? ""}`);
  }

  const reason = args[1];
  if (reason === undefined) {
    throw new Error("--reason requires a value.");
  }
  if (args.length > 2) {
    throw new Error(`Unknown reconcile option: ${args[2] ?? ""}`);
  }

  return { reason };
}

function assertRunning(
  status: ObserverStatus,
): asserts status is Extract<ObserverStatus, { status: "running" }> {
  if (status.status !== "running") {
    throw new Error(observerStatusErrorMessage(status));
  }
}
