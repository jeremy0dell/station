import type { StationConfig } from "@station/config";
import type { ObserverHealth, ObserverStopReceipt, SafeError } from "@station/contracts";
import { parsePositiveIntegerOption } from "../args.js";
import {
  getObserverStatus,
  type ObserverProcessDeps,
  type ObserverStatus,
  restartObserver,
  startObserver,
  stopObserver,
} from "../observerProcess.js";
import {
  createLocalObserverReap,
  type ObserverReapDeps,
  type ReapOutcome,
  type ReapTarget,
  runObserverReap,
} from "../observerReap.js";
import { type ObserverPaths, resolveObserverPaths } from "../paths.js";

export type ObserverCommandResult =
  | ObserverStatus
  | ObserverStopReceipt
  | ReapOutcome
  | {
      status: "foreground-exited";
      code: number;
      paths: ObserverPaths;
    };

export type ObserverCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
  reapDeps?: ObserverReapDeps;
};

export async function runObserverCommand(
  args: string[],
  options: ObserverCommandOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ObserverCommandResult> {
  const parsed = parseObserverArgs(args, options.timeoutMs);
  const action = parsed.action;
  const paths = resolveObserverPaths(options.config);
  const runtimeOptions = {
    ...options,
    paths,
    ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
  };

  switch (action) {
    case "reap":
      return runObserverReap(
        paths.socketPath,
        { force: parsed.force },
        createLocalObserverReap(options.reapDeps),
      );
    case "status":
      return getObserverStatus(runtimeOptions, deps);
    case "start":
      return startObserver(runtimeOptions, deps);
    case "stop":
      return stopObserver(runtimeOptions, deps);
    case "restart":
      return restartObserver(runtimeOptions, deps);
    case "run": {
      const { runCliObserverMain } = await import("../observerMain.js");
      const code = await runCliObserverMain([
        "--socket",
        paths.socketPath,
        "--state-dir",
        paths.stateDir,
        ...(options.configPath === undefined ? [] : ["--config", options.configPath]),
      ]);
      return {
        status: "foreground-exited",
        code,
        paths,
      };
    }
    default:
      throw new Error(`Unknown observer command: ${action}`);
  }
}

export function parseObserverCommandAction(args: string[]): string {
  return parseObserverArgs(args, undefined).action;
}

export function observerCommandRequestsFull(args: string[]): boolean {
  return parseObserverArgs(args, undefined).full;
}

function parseObserverArgs(
  args: string[],
  timeoutMs: number | undefined,
): { action: string; timeoutMs?: number; force: boolean; full: boolean } {
  const parsed = takeTimeoutOption(args, timeoutMs);
  const force = parsed.args.includes("--force") || parsed.args.includes("--yes");
  const full = parsed.args.includes("--full");
  const rest = parsed.args.filter(
    (arg) => arg !== "--force" && arg !== "--yes" && arg !== "--full",
  );

  const flag = rest.find((arg) => arg.startsWith("--"));
  if (flag !== undefined) {
    throw new Error(`Unknown observer option: ${flag}`);
  }
  if (rest.length > 1) {
    throw new Error(`Unknown observer option: ${rest[1] ?? ""}`);
  }

  const action = rest[0] ?? "status";
  if (full && action !== "status") {
    throw new Error("--full is supported only for observer status.");
  }
  const result: { action: string; timeoutMs?: number; force: boolean; full: boolean } = {
    action,
    force,
    full,
  };
  if (parsed.timeoutMs !== undefined) result.timeoutMs = parsed.timeoutMs;
  return result;
}

function takeTimeoutOption(
  args: string[],
  fallback: number | undefined,
): { args: string[]; timeoutMs?: number } {
  const index = args.indexOf("--timeout-ms");
  if (index === -1) {
    return fallback === undefined ? { args } : { args, timeoutMs: fallback };
  }
  const value = args[index + 1];
  if (value === undefined) {
    throw new Error("--timeout-ms requires a value.");
  }
  return {
    args: [...args.slice(0, index), ...args.slice(index + 2)],
    timeoutMs: parsePositiveIntegerOption(value, "--timeout-ms"),
  };
}

export function observerCommandSummary(
  result: ObserverCommandResult,
  options: { fullStatus?: boolean } = {},
): unknown {
  if ("plan" in result) {
    const { plan, applied } = result;
    return {
      action: "reap",
      socketPath: plan.socketPath,
      keeper: plan.keeper ?? null,
      duplicates: plan.duplicates,
      targets: plan.targets.map((target: ReapTarget) => target.pid),
      automaticEligibility: plan.targets.map((target: ReapTarget) => ({
        pid: target.pid,
        ...target.automaticEligibility,
      })),
      refusals: plan.refusals,
      applied,
      ...(applied || result.aborted !== undefined
        ? { killed: result.killed, exited: result.exited, survived: result.survived }
        : {}),
      ...(result.keeperPreservation === undefined
        ? {}
        : { keeperPreservation: result.keeperPreservation }),
      ...(result.claimReleased === undefined ? {} : { claimReleased: result.claimReleased }),
      ...(result.aborted === undefined ? {} : { aborted: result.aborted }),
    };
  }
  if ("health" in result) {
    if (options.fullStatus !== true) {
      const health = result.health;
      return {
        status: result.status,
        socketPath: result.paths.socketPath,
        health: {
          status: health.status,
          ...(health.pid === undefined ? {} : { pid: health.pid }),
          ...(health.startedAt === undefined ? {} : { startedAt: health.startedAt }),
          ...(health.version === undefined ? {} : { version: health.version }),
          ...(health.uptimeMs === undefined ? {} : { uptimeMs: health.uptimeMs }),
        },
      };
    }
    return {
      status: result.status,
      socketPath: result.paths.socketPath,
      health: result.health satisfies ObserverHealth,
    };
  }
  if ("paths" in result) {
    if (options.fullStatus !== true) {
      const summary: { status: string; socketPath: string; error?: SafeError } = {
        status: result.status,
        socketPath: result.paths.socketPath,
      };
      if ("error" in result && result.error !== undefined) summary.error = result.error;
      return summary;
    }
    return result;
  }
  return result satisfies ObserverStopReceipt;
}
