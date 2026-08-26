import type { StationConfig } from "@station/config";
import type { StationSnapshot } from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import { runRuntimeBoundaryWithTimeout } from "@station/runtime";
import {
  assertObserverRunning,
  getObserverStatus,
  type ObserverProcessDeps,
  type ObserverProcessOptions,
  startObserver,
} from "../observerProcess.js";
import { resolveObserverPaths } from "../paths.js";

export type SnapshotCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
};

export type ObserverSnapshotLoadOptions = SnapshotCommandOptions & {
  includeDebug?: boolean;
  requireRunning?: boolean;
};

/**
 * ADAPTER
 *
 * Parses raw snapshot argv once and delegates to the typed pinned Observer loader while
 * preserving normal startup and read-only refusal semantics.
 */
export async function runSnapshotCommand(
  args: string[],
  options: SnapshotCommandOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<StationSnapshot> {
  const parsed = parseSnapshotArgs(args);
  const loadOptions: ObserverSnapshotLoadOptions = {
    includeDebug: parsed.includeDebug,
    requireRunning: parsed.requireRunning,
  };
  if (options.config !== undefined) loadOptions.config = options.config;
  if (options.configPath !== undefined) loadOptions.configPath = options.configPath;
  if (options.timeoutMs !== undefined) loadOptions.timeoutMs = options.timeoutMs;
  return loadObserverSnapshot(loadOptions, deps);
}

export async function loadObserverSnapshot(
  options: ObserverSnapshotLoadOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<StationSnapshot> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const paths = resolveObserverPaths(options.config);
  const processOptions: ObserverProcessOptions = { paths, timeoutMs };
  if (options.config !== undefined) processOptions.config = options.config;
  if (options.configPath !== undefined) processOptions.configPath = options.configPath;
  const status =
    options.requireRunning === true
      ? await getObserverStatus(processOptions, deps)
      : await startObserver(processOptions, deps);
  assertObserverRunning(status);
  const client =
    deps.clientFactory?.(paths.socketPath) ??
    createObserverClient({
      socketPath: paths.socketPath,
      timeoutMs,
      ...(status.health.version === undefined
        ? {}
        : { expectedBuildVersion: status.health.version }),
    });
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
    async () =>
      client.getSnapshot(options.includeDebug === true ? { includeDebug: true } : undefined),
  );
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function parseSnapshotArgs(args: string[]): { includeDebug: boolean; requireRunning: boolean } {
  const unknown = args.find(
    (arg) => arg !== "--json" && arg !== "--include-debug" && arg !== "--require-running",
  );
  if (unknown !== undefined) {
    throw new Error(`Unknown snapshot option: ${unknown}`);
  }
  return {
    includeDebug: args.includes("--include-debug"),
    requireRunning: args.includes("--require-running"),
  };
}
