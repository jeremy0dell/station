import type { StationConfig } from "@station/config";
import type { StationSnapshot } from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import { runRuntimeBoundaryWithTimeout } from "@station/runtime";
import {
  type ObserverProcessDeps,
  type ObserverStatus,
  observerStatusErrorMessage,
  startObserver,
} from "../observerProcess.js";
import { resolveObserverPaths } from "../paths.js";

export type SnapshotCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
};

export async function runSnapshotCommand(
  args: string[],
  options: SnapshotCommandOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<StationSnapshot> {
  const parsed = parseSnapshotArgs(args);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const paths = resolveObserverPaths(options.config);
  const status = await startObserver({ ...options, paths, timeoutMs }, deps);
  assertRunning(status);
  const client =
    deps.clientFactory?.(paths.socketPath) ??
    createObserverClient({ socketPath: paths.socketPath, timeoutMs });
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: "cli.snapshot.get",
      timeoutMs,
      error: {
        tag: "SnapshotCommandError",
        code: "SNAPSHOT_RPC_FAILED",
        message: "Snapshot command could not load the observer snapshot.",
      },
      timeoutError: {
        tag: "TimeoutError",
        code: "SNAPSHOT_RPC_TIMEOUT",
        message: "Snapshot command timed out while contacting the observer.",
      },
    },
    async () => client.getSnapshot(parsed.includeDebug ? { includeDebug: true } : undefined),
  );
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function parseSnapshotArgs(args: string[]): { includeDebug: boolean } {
  const unknown = args.find((arg) => arg !== "--json" && arg !== "--include-debug");
  if (unknown !== undefined) {
    throw new Error(`Unknown snapshot option: ${unknown}`);
  }
  return { includeDebug: args.includes("--include-debug") };
}

function assertRunning(
  status: ObserverStatus,
): asserts status is Extract<ObserverStatus, { status: "running" }> {
  if (status.status !== "running") {
    throw new Error(observerStatusErrorMessage(status));
  }
}
