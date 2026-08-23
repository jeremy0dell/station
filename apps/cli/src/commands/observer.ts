import type { StationConfig } from "@station/config";
import type { ObserverHealth, ObserverStopReceipt } from "@station/contracts";
import { stationObserverBuildVersion } from "@station/runtime";
import { parsePositiveIntegerOption } from "../args.js";
import {
  type ExactObserverBuildStatus,
  ensureExactObserverBuild,
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
  type ObserverReapOutcome,
  type ObserverReapTarget,
  runObserverReap,
} from "../observerReap.js";
import { type ObserverPaths, resolveObserverPaths } from "../paths.js";

export type ObserverCommandResult =
  | ObserverStatus
  | ExactObserverBuildStatus
  | ObserverStopReceipt
  | ObserverReapOutcome
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

type ParsedObserverArgs = {
  action: string;
  timeoutMs?: number;
  force: boolean;
  expectedSocket?: string;
  expectedBuildSelector?: string;
};

/**
 * COMPOSITION ROOT
 *
 * Selects Observer process lifecycle and duplicate-inspection adapters for one CLI action. Internal
 * update mutation commitments must match this process's configured socket and immutable build.
 */
export async function runObserverCommand(
  args: string[],
  options: ObserverCommandOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ObserverCommandResult> {
  const parsed = parseObserverArgs(args, options.timeoutMs);
  const action = parsed.action;
  const paths = resolveObserverPaths(options.config);
  assertInternalUpdateCommitment(parsed, paths, deps);
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
    case "ensure-exact-build":
      return ensureExactObserverBuild(runtimeOptions, deps);
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

function parseObserverArgs(args: string[], timeoutMs: number | undefined): ParsedObserverArgs {
  const parsed = takeTimeoutOption(args, timeoutMs);
  const expectedSocket = takeInternalUpdateOption(parsed.args, "--internal-update-expected-socket");
  const expectedBuild = takeInternalUpdateOption(
    expectedSocket.args,
    "--internal-update-expected-build-selector",
  );
  const force = expectedBuild.args.includes("--force") || expectedBuild.args.includes("--yes");
  const rest = expectedBuild.args.filter((arg) => arg !== "--force" && arg !== "--yes");

  const flag = rest.find((arg) => arg.startsWith("--"));
  if (flag !== undefined) {
    throw new Error(`Unknown observer option: ${flag}`);
  }
  if (rest.length > 1) {
    throw new Error(`Unknown observer option: ${rest[1] ?? ""}`);
  }

  const result: ParsedObserverArgs = {
    action: rest[0] ?? "status",
    force,
  };
  if (parsed.timeoutMs !== undefined) result.timeoutMs = parsed.timeoutMs;
  if (expectedSocket.value !== undefined) result.expectedSocket = expectedSocket.value;
  if (expectedBuild.value !== undefined) {
    result.expectedBuildSelector = expectedBuild.value;
  }
  return result;
}

function takeInternalUpdateOption(
  args: string[],
  option: string,
): { args: string[]; value?: string } {
  const index = args.indexOf(option);
  if (index === -1) return { args };
  const value = args[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`${option} requires a value.`);
  }
  return { args: [...args.slice(0, index), ...args.slice(index + 2)], value };
}

function assertInternalUpdateCommitment(
  parsed: {
    action: string;
    expectedSocket?: string;
    expectedBuildSelector?: string;
  },
  paths: ObserverPaths,
  deps: ObserverProcessDeps,
): void {
  if (parsed.expectedSocket === undefined && parsed.expectedBuildSelector === undefined) return;
  if (parsed.action !== "start" && parsed.action !== "restart") {
    throw new Error("Internal update commitments are valid only for Observer start or restart.");
  }
  if (parsed.expectedSocket !== paths.socketPath) {
    throw new Error("The configured Observer socket changed after update convergence planning.");
  }
  const buildSelector = deps.buildVersion ?? stationObserverBuildVersion();
  if (parsed.expectedBuildSelector !== buildSelector) {
    throw new Error("The executing Observer build differs from the selected update target.");
  }
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
      targets: plan.targets.map((target: ObserverReapTarget) => target.pid),
      automaticEligibility: plan.targets.map((target: ObserverReapTarget) => ({
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
    return {
      status: result.status,
      socketPath: result.paths.socketPath,
      health: result.health satisfies ObserverHealth,
      ...("lifecycle" in result ? { lifecycle: result.lifecycle } : {}),
    };
  }
  if ("paths" in result) {
    return result;
  }
  return result satisfies ObserverStopReceipt;
}
