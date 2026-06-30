import { stat } from "node:fs/promises";
import type { StationConfig } from "@station/config";
import type { DoctorCheck, DoctorOptions, DoctorReport } from "@station/contracts";
import { DoctorOptionsSchema } from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import { resolveExecutablePath, runRuntimeBoundaryWithTimeout } from "@station/runtime";
import { parseRequiredOptionValue } from "../args.js";
import {
  type ObserverProcessDeps,
  type ObserverStatus,
  observerStatusErrorMessage,
  startObserver,
} from "../observerProcess.js";
import { resolveObserverPaths } from "../paths.js";

export type DoctorCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
};

export async function runDoctorCommand(
  args: string[],
  options: DoctorCommandOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<DoctorReport> {
  const doctorOptions = parseDoctorOptions(args);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const paths = resolveObserverPaths(options.config);
  const observerOptions: Parameters<typeof startObserver>[0] = { paths, timeoutMs };
  if (options.config !== undefined) {
    observerOptions.config = options.config;
  }
  if (options.configPath !== undefined) {
    observerOptions.configPath = options.configPath;
  }
  const status = await startObserver(observerOptions, deps);
  assertRunning(status);
  const client =
    deps.clientFactory?.(paths.socketPath) ??
    createObserverClient({ socketPath: paths.socketPath, timeoutMs });
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: "cli.doctor.run",
      timeoutMs,
      error: {
        tag: "DoctorCommandError",
        code: "DOCTOR_RPC_FAILED",
        message: "Doctor command could not collect observer diagnostics.",
      },
      timeoutError: {
        tag: "TimeoutError",
        code: "DOCTOR_RPC_TIMEOUT",
        message: "Doctor command timed out while contacting the observer.",
      },
    },
    async () => client.runDoctor(doctorOptions),
  );
  if (!result.ok) {
    throw result.error;
  }
  const observerStartedAt = status.health.startedAt ?? result.value.observer.startedAt;
  // CLI-side checks run only against the real runtime; injected tests (clientFactory
  // / spawnObserver) skip them so their reports stay deterministic.
  const runCliChecks = shouldRunCliRuntimeChecks(deps);
  const cliChecks: DoctorCheck[] = [];
  if (runCliChecks && observerStartedAt !== undefined) {
    const freshnessCheck = await observerRuntimeFreshnessCheck(observerStartedAt);
    if (freshnessCheck !== undefined) cliChecks.push(freshnessCheck);
  }
  if (runCliChecks) {
    const rendererCheck = await rendererRuntimeCheck();
    if (rendererCheck !== undefined) cliChecks.push(rendererCheck);
  }
  let report = result.value;
  for (const check of cliChecks) {
    report = reportWithCliCheck(report, check);
  }
  return report;
}

/**
 * Bare `stn` renders the TUI by shelling out to `bun run` against the station
 * workspace, so a missing Bun leaves the primary terminal UI silently broken even
 * when the observer is healthy. Surface it as a degraded (warn) doctor finding.
 */
export async function rendererRuntimeCheck(
  resolve: (command: string) => Promise<string | undefined> = (command) =>
    resolveExecutablePath(command),
  dashboardCommandOverride: string | undefined = process.env.STATION_DASHBOARD_COMMAND,
): Promise<DoctorCheck | undefined> {
  // Mirror tui.ts: STATION_DASHBOARD_COMMAND replaces `bun run` with a custom
  // renderer command, so Bun is not required when that override is set.
  if (dashboardCommandOverride !== undefined) {
    return undefined;
  }
  const bunPath = await resolve("bun");
  if (bunPath !== undefined) {
    return undefined;
  }
  return {
    name: "renderer-runtime",
    status: "warn",
    message: "Bun is not installed; bare stn cannot render the STATION terminal UI.",
    error: {
      tag: "RendererRuntimeError",
      code: "BUN_RUNTIME_MISSING",
      message: "The station TUI renderer runs on Bun (bun run), which is not on PATH.",
      hint: "Install Bun (brew install bun), then run stn doctor.",
    },
  };
}

function parseDoctorOptions(args: string[]): DoctorOptions {
  const result: {
    projectId?: string;
    deep?: true;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--deep") {
      result.deep = true;
      continue;
    }
    if (arg === "--project") {
      result.projectId = parseRequiredOptionValue(args[index + 1], "--project");
      index += 1;
      continue;
    }
    if (arg !== undefined) {
      throw new Error(`Unknown doctor option: ${arg}`);
    }
  }
  const options = Object.keys(result).length === 0 ? undefined : result;
  const parsed = DoctorOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new Error(`Invalid doctor options: ${parsed.error.message}`);
  }
  return parsed.data;
}

export async function observerRuntimeFreshnessCheck(
  observerStartedAt: string,
): Promise<DoctorCheck | undefined> {
  const runtimeEntries = [
    new URL("../../dist/observerMain.js", import.meta.url),
    new URL("../main.js", import.meta.url),
    new URL("../main.ts", import.meta.url),
  ];
  const mtimes = await Promise.all(
    runtimeEntries.map(async (entry) => {
      try {
        return (await stat(entry)).mtimeMs;
      } catch {
        return undefined;
      }
    }),
  );
  let newestMtime = Number.NEGATIVE_INFINITY;
  for (const mtime of mtimes) {
    if (mtime !== undefined && mtime > newestMtime) {
      newestMtime = mtime;
    }
  }
  if (!Number.isFinite(newestMtime)) {
    return undefined;
  }

  const startedAtMs = Date.parse(observerStartedAt);
  if (!Number.isFinite(startedAtMs) || startedAtMs + 1000 >= newestMtime) {
    return undefined;
  }

  return {
    name: "observer-runtime-freshness",
    status: "warn",
    message:
      "Observer is running from an older local build than the current station runtime files.",
    error: {
      tag: "ObserverRuntimeFreshnessError",
      code: "OBSERVER_RUNTIME_STALE",
      message:
        "The running observer started before the current local station runtime files were built.",
      hint: "Restart the observer so hook parsing and reconcile logic use the current build.",
    },
  };
}

function shouldRunCliRuntimeChecks(deps: ObserverProcessDeps): boolean {
  return deps.clientFactory === undefined && deps.spawnObserver === undefined;
}

function reportWithCliCheck(report: DoctorReport, check: DoctorCheck): DoctorReport {
  const checks = report.checks.slice();
  checks.push(check);
  const next: DoctorReport = {
    schemaVersion: report.schemaVersion,
    generatedAt: report.generatedAt,
    status: doctorStatusWithCheck(report, check),
    checks,
    observer: report.observer,
    config: report.config,
    providers: report.providers,
    snapshot: report.snapshot,
    logs: report.logs,
    localState: report.localState,
    retention: report.retention,
    recentErrors: report.recentErrors,
    debugBundle: report.debugBundle,
  };
  if (report.sqlite !== undefined) {
    next.sqlite = report.sqlite;
  }
  if (report.hooks !== undefined) {
    next.hooks = report.hooks;
  }
  return next;
}

function doctorStatusWithCheck(report: DoctorReport, check: DoctorCheck): DoctorReport["status"] {
  if (check.status === "error") {
    return "unavailable";
  }
  if (report.status === "healthy") {
    return "degraded";
  }
  return report.status;
}

function assertRunning(
  status: ObserverStatus,
): asserts status is Extract<ObserverStatus, { status: "running" }> {
  if (status.status !== "running") {
    throw new Error(observerStatusErrorMessage(status));
  }
}
