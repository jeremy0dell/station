import type { StationConfig } from "@station/config";
import type { ObserverHealth, ObserverStopReceipt } from "@station/contracts";
import { parsePositiveIntegerOption } from "../args.js";
import {
  getObserverStatus,
  type ObserverProcessDeps,
  type ObserverStatus,
  restartObserver,
  startObserver,
  stopObserver,
} from "../observerProcess.js";
import { type ObserverReapDeps, type ReapOutcome, runObserverReap } from "../observerReap.js";
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
      return runObserverReap(paths.socketPath, { force: parsed.force }, options.reapDeps ?? {});
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

function parseObserverArgs(
  args: string[],
  timeoutMs: number | undefined,
): { action: string; timeoutMs?: number; force: boolean } {
  const parsed = takeTimeoutOption(args, timeoutMs);
  const force = parsed.args.includes("--force") || parsed.args.includes("--yes");
  const rest = parsed.args.filter((arg) => arg !== "--force" && arg !== "--yes");

  const flag = rest.find((arg) => arg.startsWith("--"));
  if (flag !== undefined) {
    throw new Error(`Unknown observer option: ${flag}`);
  }
  if (rest.length > 1) {
    throw new Error(`Unknown observer option: ${rest[1] ?? ""}`);
  }

  const result: { action: string; timeoutMs?: number; force: boolean } = {
    action: rest[0] ?? "status",
    force,
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

export function observerCommandSummary(result: ObserverCommandResult): unknown {
  if ("plan" in result) {
    const { plan, applied } = result;
    return {
      action: "reap",
      socketPath: plan.socketPath,
      keeper: plan.keeper ?? null,
      duplicates: plan.duplicates,
      targets: plan.targets.map((t) => t.pid),
      refusals: plan.refusals,
      applied,
      ...(applied ? { killed: result.killed, survived: result.survived } : {}),
      ...(result.aborted === undefined ? {} : { aborted: result.aborted }),
    };
  }
  if ("health" in result) {
    return {
      status: result.status,
      socketPath: result.paths.socketPath,
      health: result.health satisfies ObserverHealth,
    };
  }
  if ("paths" in result) {
    return result;
  }
  return result satisfies ObserverStopReceipt;
}
