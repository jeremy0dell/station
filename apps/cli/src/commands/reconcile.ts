import type { StationConfig } from "@station/config";
import type { ReconcileReceipt } from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import {
  assertObserverRunning,
  type ObserverProcessDeps,
  startObserver,
} from "../observerProcess.js";
import { resolveObserverPaths } from "../paths.js";
import {
  reconcilePersistedState,
  requireCurrentObserverIdentity,
} from "../persistedStateReconcile.js";

export type ReconcileCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
};

/**
 * COMPOSITION ROOT
 *
 * Proves one current Observer and binds only its reconcile method to the use case.
 */
export async function runReconcileCommand(
  args: string[],
  options: ReconcileCommandOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ReconcileReceipt> {
  const parsed = parseReconcileArgs(args);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const paths = resolveObserverPaths(options.config);
  const status = await startObserver({ ...options, paths, timeoutMs }, deps);
  assertObserverRunning(status);
  const observerIdentity = requireCurrentObserverIdentity(status.health, status.paths.socketPath);
  return reconcilePersistedState(
    {
      observerIdentity,
      timeoutMs,
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
    },
    (request) => {
      const { observerIdentity, timeoutMs: requestTimeoutMs } = request;
      const clientOptions = {
        expectedObserverIdentity: observerIdentity,
        timeoutMs: requestTimeoutMs,
      };
      const client =
        deps.clientFactory?.(observerIdentity.socketPath, clientOptions) ??
        createObserverClient({
          socketPath: observerIdentity.socketPath,
          ...clientOptions,
        });
      return { reconcile: (reason) => client.reconcile(reason) };
    },
  );
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
