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
import type { UpdateObserverMutationInspectionPort } from "../update/recoveryPreflightAdapters.js";
import {
  observerMutationPrivateEvidenceMatches,
  readUpdateObserverMutationCommitment,
  type UpdateObserverMutationCommitment,
} from "../update/updateObserverMutationCommitment.js";

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
  updateMutationInspection?: UpdateObserverMutationInspectionPort;
  readUpdateMutationCommitment?: () => UpdateObserverMutationCommitment;
};

type ParsedObserverArgs = {
  action: string;
  timeoutMs?: number;
  force: boolean;
  internalUpdateCommitment: boolean;
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
  const updateGuard = await authorizeInternalUpdateMutation(parsed, paths, options, deps);
  const runtimeOptions: Parameters<typeof startObserver>[0] = { paths };
  if (options.config !== undefined) runtimeOptions.config = options.config;
  if (options.configPath !== undefined) runtimeOptions.configPath = options.configPath;
  if (parsed.timeoutMs !== undefined) runtimeOptions.timeoutMs = parsed.timeoutMs;
  if (updateGuard !== undefined) {
    runtimeOptions.updateLifecycleGuard = updateGuard.lifecycle;
    runtimeOptions.beforeUpdateLifecycleMutation = updateGuard.revalidate;
  }

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
  const internalUpdateCommitment = parsed.args.includes("--internal-update-commitment");
  const withoutInternal = parsed.args.filter((arg) => arg !== "--internal-update-commitment");
  const force = withoutInternal.includes("--force") || withoutInternal.includes("--yes");
  const rest = withoutInternal.filter((arg) => arg !== "--force" && arg !== "--yes");

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
    internalUpdateCommitment,
  };
  if (parsed.timeoutMs !== undefined) result.timeoutMs = parsed.timeoutMs;
  return result;
}

async function authorizeInternalUpdateMutation(
  parsed: ParsedObserverArgs,
  paths: ObserverPaths,
  options: ObserverCommandOptions,
  deps: ObserverProcessDeps,
): Promise<
  | {
      lifecycle: NonNullable<
        NonNullable<Parameters<typeof startObserver>[0]>["updateLifecycleGuard"]
      >;
      revalidate: () => Promise<void>;
    }
  | undefined
> {
  if (!parsed.internalUpdateCommitment) return undefined;
  if (parsed.action !== "start" && parsed.action !== "restart") {
    throw new Error("Internal update commitments are valid only for Observer start or restart.");
  }
  const readCommitment =
    options.readUpdateMutationCommitment ?? readUpdateObserverMutationCommitment;
  const commitment = readCommitment();
  if (commitment.action !== parsed.action || commitment.socketPath !== paths.socketPath) {
    throw new Error("The configured Observer socket changed after update convergence planning.");
  }
  const buildSelector = deps.buildVersion ?? stationObserverBuildVersion();
  if (commitment.targetBuildSelector !== buildSelector) {
    throw new Error("The executing Observer build differs from the selected update target.");
  }
  const inspect = options.updateMutationInspection;
  if (inspect === undefined) {
    throw new Error("Observer update mutation inspection is unavailable.");
  }
  const revalidate = async () => {
    const actual = await inspect({
      target: commitment.target,
      targetBuildSelector: commitment.targetBuildSelector,
    });
    if (
      !observerMutationPrivateEvidenceMatches(
        commitment,
        actual.evidence.status,
        actual.privateEvidence,
      )
    ) {
      throw new Error("Observer ownership or selected recovery handles changed before mutation.");
    }
  };
  await revalidate();
  return {
    lifecycle:
      commitment.owner.status === "absent"
        ? { status: "absent" }
        : {
            status: "incumbent",
            pid: commitment.owner.pid,
            version: commitment.owner.buildSelector,
            socketPath: commitment.owner.socketPath,
          },
    revalidate,
  };
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
