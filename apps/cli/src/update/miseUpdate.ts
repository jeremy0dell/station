import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { type UpdateArtifact, updateCommandArgvMatch } from "@station/contracts";
import {
  type ExternalCommandRunner,
  isSafeError,
  normalizeCancellationError,
  resolveExecutablePath,
  runExternalCommand,
} from "@station/runtime";
import { z } from "zod";
import {
  applyPackageManagerPlan,
  invalidManagerPlan,
  type PackageManagerPlanBase,
  type PackageManagerUpdateReport,
  sameUpdateCommand,
} from "./packageManagerUpdate.js";
import type { UpdateChannel, UpdateOperationOptions } from "./updateChannel.js";
import { updateErrorFromUnknown } from "./updateError.js";

const channel = "mise" as const;

const MiseInstallSchema = z.object({
  version: z.string().min(1),
  install_path: z.string().min(1),
});
const MiseListSchema = z.record(z.string().min(1), z.array(MiseInstallSchema));
const MiseOutdatedEntrySchema = z.object({
  current: z.string().min(1),
  latest: z.string().min(1),
});
const MiseOutdatedSchema = z.record(z.string().min(1), MiseOutdatedEntrySchema);

export type MiseDetection = {
  channel: typeof channel;
  currentVersion: string;
  misePath: string;
  tool: string;
  installPath: string;
  runtimePath: string;
};

export type MiseUpdatePlan = PackageManagerPlanBase &
  MiseDetection & {
    channel: typeof channel;
  };

export type MiseUpdateReport = PackageManagerUpdateReport & {
  channel: typeof channel;
};

export type MiseUpdateChannelDeps = {
  runtimePath: string;
  pathEnv?: string;
  commandRunner?: ExternalCommandRunner;
};

/**
 * ADAPTER
 *
 * Translates mise's active tool installation into its configured-range upgrade command.
 * Installed-target proof validates inherited exact argv from the active tool without `mise outdated`.
 */
export function createMiseUpdateChannel(
  deps: MiseUpdateChannelDeps,
): UpdateChannel<MiseDetection, MiseUpdatePlan, MiseUpdateReport> {
  return {
    id: channel,
    detect: (options = {}) => detectMise(deps, options),
    async plan(detection, options = {}) {
      await requireSameDetection(detection, deps, options);
      const targetVersion = await miseTargetVersion(detection, deps.commandRunner, options);
      return {
        ...detection,
        status: targetVersion === detection.currentVersion ? "current" : "update-available",
        targetVersion,
        currentCli: [detection.misePath, "exec", "--", "stn"],
        managerCommand: [detection.misePath, "upgrade", detection.tool],
        successorCli: [detection.misePath, "exec", "--", "stn"],
      };
    },
    async proveInstalledTarget(target: UpdateArtifact, options = {}) {
      const detection = await detectMise(deps, options);
      if (
        detection === undefined ||
        target.revision !== undefined ||
        detection.currentVersion !== target.version
      ) {
        return undefined;
      }
      const managerCommand = [detection.misePath, "upgrade", detection.tool] as const;
      if (
        options.inheritedManagerCommand !== undefined &&
        !updateCommandArgvMatch(options.inheritedManagerCommand, managerCommand)
      ) {
        return undefined;
      }
      return {
        channel,
        status: "current",
        currentVersion: target.version,
        targetVersion: target.version,
        currentCli: [detection.misePath, "exec", "--", "stn"],
        managerCommand: options.inheritedManagerCommand ?? managerCommand,
      };
    },
    async apply(plan, options = {}) {
      return applyPackageManagerPlan(plan, options, {
        commandRunner: deps.commandRunner,
        revalidate: async () => {
          await requireSameDetection(plan, deps, options);
          const targetVersion = await miseTargetVersion(plan, deps.commandRunner, options);
          const successorCli = [plan.misePath, "exec", "--", "stn"] as const;
          if (
            targetVersion !== plan.targetVersion ||
            !sameUpdateCommand(plan.managerCommand, [plan.misePath, "upgrade", plan.tool]) ||
            !sameUpdateCommand(plan.currentCli, successorCli) ||
            !sameUpdateCommand(plan.successorCli, successorCli)
          ) {
            throw invalidManagerPlan();
          }
        },
        postcheck: async () => {
          const installed = await detectMise(deps, options, plan.tool);
          if (
            installed === undefined ||
            installed.tool !== plan.tool ||
            installed.currentVersion !== plan.targetVersion
          ) {
            throw stalePlan("mise did not leave the planned Station tool active.");
          }
        },
      }) as Promise<MiseUpdateReport>;
    },
  };
}

async function detectMise(
  deps: MiseUpdateChannelDeps,
  options: UpdateOperationOptions,
  expectedTool?: string,
): Promise<MiseDetection | undefined> {
  const misePath = await resolveExecutablePath(
    "mise",
    deps.pathEnv === undefined ? {} : { pathEnv: deps.pathEnv },
  );
  if (misePath === undefined) return undefined;
  try {
    const result = await runMise(
      misePath,
      ["ls", "--current", "--json"],
      deps.commandRunner,
      options,
    );
    const runningRuntimePath =
      expectedTool === undefined ? await realpath(deps.runtimePath) : undefined;
    const installs = MiseListSchema.parse(JSON.parse(result.stdout));
    for (const [tool, entries] of Object.entries(installs)) {
      if (expectedTool !== undefined && tool !== expectedTool) continue;
      for (const entry of entries) {
        let candidate: string;
        try {
          candidate = await realpath(resolve(entry.install_path, "bin", "stn"));
        } catch {
          continue;
        }
        if (runningRuntimePath !== undefined && candidate !== runningRuntimePath) continue;
        return {
          channel,
          currentVersion: entry.version,
          misePath,
          tool,
          installPath: entry.install_path,
          runtimePath: candidate,
        };
      }
    }
    return undefined;
  } catch (error) {
    const cancellation = normalizeCancellationError(error);
    if (cancellation !== undefined) throw cancellation;
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_CHANNEL_DETECT_FAILED",
      message: "mise installation ownership could not be inspected.",
    });
  }
}

async function miseTargetVersion(
  detection: MiseDetection,
  commandRunner: ExternalCommandRunner | undefined,
  options: UpdateOperationOptions,
): Promise<string> {
  try {
    const result = await runMise(
      detection.misePath,
      ["outdated", detection.tool, "--json"],
      commandRunner,
      options,
    );
    const outdated = MiseOutdatedSchema.parse(JSON.parse(result.stdout));
    const entry = outdated[detection.tool];
    if (entry === undefined) return detection.currentVersion;
    if (entry.current !== detection.currentVersion) {
      throw stalePlan("mise's active Station version changed while planning.");
    }
    return entry.latest;
  } catch (error) {
    const cancellation = normalizeCancellationError(error);
    if (cancellation !== undefined) throw cancellation;
    if (isSafeError(error) && error.tag === "UpdateError") {
      throw error;
    }
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_PLAN_FAILED",
      message: "mise could not resolve the configured Station upgrade target.",
    });
  }
}

async function requireSameDetection(
  expected: MiseDetection,
  deps: MiseUpdateChannelDeps,
  options: UpdateOperationOptions,
): Promise<void> {
  const current = await detectMise(deps, options);
  if (
    current === undefined ||
    current.currentVersion !== expected.currentVersion ||
    current.misePath !== expected.misePath ||
    current.tool !== expected.tool ||
    current.installPath !== expected.installPath ||
    current.runtimePath !== expected.runtimePath
  ) {
    throw stalePlan("The mise-owned Station installation changed after planning.");
  }
}

function runMise(
  misePath: string,
  args: string[],
  commandRunner: ExternalCommandRunner | undefined,
  options: UpdateOperationOptions,
) {
  return runExternalCommand(
    {
      command: misePath,
      args,
      timeoutMs: 30_000,
      maxOutputChars: 64 * 1024,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    commandRunner,
  );
}

function stalePlan(message: string) {
  return updateErrorFromUnknown(undefined, {
    code: "UPDATE_PLAN_STALE",
    message,
    hint: "Run stn update again to build a fresh plan.",
  });
}
