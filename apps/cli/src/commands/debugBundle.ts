import type { StationConfig } from "@station/config";
import type { DebugBundleManifest, DiagnosticCollectionOptions } from "@station/contracts";
import { DiagnosticCollectionOptionsSchema } from "@station/contracts";
import { writeDebugBundle } from "@station/observability";
import { createObserverClient } from "@station/protocol";
import { runRuntimeBoundary, runRuntimeBoundaryWithTimeout } from "@station/runtime";
import { parseRequiredOptionValue } from "../args.js";
import {
  type ObserverProcessDeps,
  type ObserverStatus,
  observerStatusErrorMessage,
  startObserver,
} from "../observerProcess.js";
import { resolveObserverPaths } from "../paths.js";

export type DebugBundleCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
};

export type DebugBundleCommandResult = {
  bundlePath: string;
  manifest: DebugBundleManifest;
};

const diagnosticCollectionTimeoutMs = 30_000;

export async function runDebugBundleCommand(
  args: string[],
  options: DebugBundleCommandOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<DebugBundleCommandResult> {
  const collectionOptions = parseDebugBundleOptions(args);
  const paths = resolveObserverPaths(options.config);
  const status = await startObserver({ ...options, paths }, deps);
  assertRunning(status);
  const client = (deps.clientFactory ?? defaultClientFactory)(paths.socketPath);
  const collected = await runRuntimeBoundaryWithTimeout(
    {
      operation: "cli.debugBundle.collectDiagnostics",
      timeoutMs: options.timeoutMs ?? diagnosticCollectionTimeoutMs,
      error: {
        tag: "DebugBundleError",
        code: "DEBUG_BUNDLE_COLLECT_FAILED",
        message: "Debug bundle diagnostics collection failed.",
      },
      timeoutError: {
        tag: "TimeoutError",
        code: "DEBUG_BUNDLE_COLLECT_TIMEOUT",
        message: "Debug bundle diagnostics collection timed out.",
      },
    },
    async () => client.collectDiagnostics(collectionOptions),
  );
  if (!collected.ok) {
    throw collected.error;
  }
  const written = await runRuntimeBoundary(
    {
      operation: "cli.debugBundle.write",
      error: {
        tag: "DebugBundleError",
        code: "DEBUG_BUNDLE_WRITE_FAILED",
        message: "Debug bundle could not be written.",
      },
    },
    async () =>
      writeDebugBundle({
        diagnosticsDir: paths.diagnosticsDir,
        snapshot: collected.value,
      }),
  );
  if (!written.ok) {
    throw written.error;
  }
  const manifest = written.value;
  return {
    bundlePath: manifest.bundlePath,
    manifest,
  };
}

function parseDebugBundleOptions(args: string[]): DiagnosticCollectionOptions {
  const result: {
    since?: string;
    projectId?: string;
    commandId?: string;
    traceId?: string;
    latestFailure?: true;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--project") {
      result.projectId = parseRequiredOptionValue(next, "--project");
      index += 1;
      continue;
    }
    if (arg === "--command") {
      result.commandId = parseRequiredOptionValue(next, "--command");
      index += 1;
      continue;
    }
    if (arg === "--trace") {
      result.traceId = parseRequiredOptionValue(next, "--trace");
      index += 1;
      continue;
    }
    if (arg === "--latest-failure") {
      result.latestFailure = true;
      continue;
    }
    if (arg === "--last") {
      result.since = sinceFromDuration(parseRequiredOptionValue(next, "--last"));
      index += 1;
      continue;
    }
    if (arg === "--since") {
      result.since = parseRequiredOptionValue(next, "--since");
      index += 1;
      continue;
    }
    if (arg !== undefined) {
      throw new Error(`Unknown debug bundle option: ${arg}`);
    }
  }
  const options = Object.keys(result).length === 0 ? undefined : result;
  const parsed = DiagnosticCollectionOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new Error(`Invalid debug bundle options: ${parsed.error.message}`);
  }
  return parsed.data;
}

function sinceFromDuration(input: string): string {
  const match = input.match(/^(\d+)(s|m|h|d)$/);
  if (match === null) {
    throw new Error("Expected --last duration like 30m, 2h, or 1d.");
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const unitMs =
    unit === "s"
      ? 1000
      : unit === "m"
        ? 60 * 1000
        : unit === "h"
          ? 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;
  return new Date(Date.now() - amount * unitMs).toISOString();
}

function assertRunning(
  status: ObserverStatus,
): asserts status is Extract<ObserverStatus, { status: "running" }> {
  if (status.status !== "running") {
    throw new Error(observerStatusErrorMessage(status));
  }
}

function defaultClientFactory(socketPath: string) {
  return createObserverClient({ socketPath, timeoutMs: diagnosticCollectionTimeoutMs });
}
