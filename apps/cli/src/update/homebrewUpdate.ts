import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  type ExternalCommandRunner,
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

const channel = "homebrew" as const;

const FormulaSchema = z.object({
  name: z.string().min(1),
  full_name: z.string().min(1),
  versions: z.object({ stable: z.string().min(1) }),
  installed: z.array(z.object({ version: z.string().min(1) })),
});
const CaskSchema = z.object({
  token: z.string().min(1),
  full_token: z.string().min(1).optional(),
  version: z.string().min(1),
  installed: z.array(z.string().min(1)),
});
const BrewInfoSchema = z.object({
  formulae: z.array(FormulaSchema),
  casks: z.array(CaskSchema),
});

export type HomebrewDetection = {
  channel: typeof channel;
  kind: "formula" | "cask";
  currentVersion: string;
  targetVersion: string;
  brewPath: string;
  packageName: string;
  executablePath: string;
  runtimePath: string;
};

export type HomebrewUpdatePlan = PackageManagerPlanBase &
  HomebrewDetection & {
    channel: typeof channel;
  };

export type HomebrewUpdateReport = PackageManagerUpdateReport & {
  channel: typeof channel;
};

export type HomebrewUpdateChannelDeps = {
  runtimePath: string;
  pathEnv?: string;
  commandRunner?: ExternalCommandRunner;
};

/**
 * ADAPTER
 *
 * Translates Homebrew Cellar or Caskroom ownership into a native brew update plan.
 */
export function createHomebrewUpdateChannel(
  deps: HomebrewUpdateChannelDeps,
): UpdateChannel<HomebrewDetection, HomebrewUpdatePlan, HomebrewUpdateReport> {
  return {
    id: channel,
    detect: (options = {}) => detectHomebrew(deps, options),
    async plan(detection, options = {}) {
      const current = await requireSameDetection(detection, deps, options);
      return {
        ...current,
        status: current.currentVersion === current.targetVersion ? "current" : "update-available",
        currentCli: [current.executablePath],
        successorCli: [current.executablePath],
        managerCommand: [
          current.brewPath,
          "upgrade",
          current.kind === "formula" ? "--formula" : "--cask",
          current.packageName,
        ],
      };
    },
    async apply(plan, options = {}) {
      return applyPackageManagerPlan(plan, options, {
        commandRunner: deps.commandRunner,
        commandEnv: { HOMEBREW_NO_AUTO_UPDATE: "1" },
        revalidate: async () => {
          const current = await requireSameDetection(plan, deps, options);
          if (
            current.targetVersion !== plan.targetVersion ||
            !sameUpdateCommand(plan.managerCommand, [
              plan.brewPath,
              "upgrade",
              plan.kind === "formula" ? "--formula" : "--cask",
              plan.packageName,
            ]) ||
            !sameUpdateCommand(plan.currentCli, [plan.executablePath]) ||
            !sameUpdateCommand(plan.successorCli, [plan.executablePath])
          ) {
            throw invalidManagerPlan();
          }
        },
        postcheck: async () => {
          const installed = await detectHomebrew(deps, options, false);
          if (
            installed === undefined ||
            installed.kind !== plan.kind ||
            installed.packageName !== plan.packageName ||
            installed.currentVersion !== plan.targetVersion
          ) {
            throw stalePlan("Homebrew did not leave the planned Station package active.");
          }
        },
      }) as Promise<HomebrewUpdateReport>;
    },
  };
}

async function detectHomebrew(
  deps: HomebrewUpdateChannelDeps,
  options: UpdateOperationOptions,
  requireRunningRuntime = true,
): Promise<HomebrewDetection | undefined> {
  const brewPath = await resolveExecutablePath(
    "brew",
    deps.pathEnv === undefined ? {} : { pathEnv: deps.pathEnv },
  );
  if (brewPath === undefined) return undefined;
  try {
    const prefixResult = await runBrew(brewPath, ["--prefix"], deps.commandRunner, options);
    const prefix = await realpath(oneLine(prefixResult.stdout, "Homebrew prefix"));
    const executablePath = resolve(prefix, "bin", "stn");
    const runtimePath = await realpath(requireRunningRuntime ? deps.runtimePath : executablePath);
    const ownership = homebrewOwnership(prefix, runtimePath);
    if (ownership === undefined) return undefined;
    const info = await brewInfo(brewPath, ownership.kind, ownership.name, deps, options);
    if ((await realpath(executablePath)) !== runtimePath) return undefined;
    if (ownership.kind === "formula") {
      const formula = info.formulae[0];
      if (
        formula === undefined ||
        info.formulae.length !== 1 ||
        info.casks.length !== 0 ||
        !formula.installed.some(({ version }) => version === ownership.version)
      ) {
        return undefined;
      }
      return {
        channel,
        kind: ownership.kind,
        currentVersion: ownership.version,
        targetVersion: formula.versions.stable,
        brewPath,
        packageName: formula.full_name,
        executablePath,
        runtimePath,
      };
    }
    const cask = info.casks[0];
    if (
      cask === undefined ||
      info.casks.length !== 1 ||
      info.formulae.length !== 0 ||
      !cask.installed.includes(ownership.version)
    ) {
      return undefined;
    }
    return {
      channel,
      kind: ownership.kind,
      currentVersion: ownership.version,
      targetVersion: cask.version,
      brewPath,
      packageName: cask.full_token ?? cask.token,
      executablePath,
      runtimePath,
    };
  } catch (error) {
    const cancellation = normalizeCancellationError(error);
    if (cancellation !== undefined) throw cancellation;
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_CHANNEL_DETECT_FAILED",
      message: "Homebrew installation ownership could not be inspected.",
    });
  }
}

function homebrewOwnership(prefix: string, runtimePath: string) {
  const path = relative(prefix, runtimePath);
  if (path.startsWith("..")) return undefined;
  const [root, name, version] = path.split("/");
  if (
    (root !== "Cellar" && root !== "Caskroom") ||
    name === undefined ||
    name.length === 0 ||
    version === undefined ||
    version.length === 0
  ) {
    return undefined;
  }
  return { kind: root === "Cellar" ? ("formula" as const) : ("cask" as const), name, version };
}

async function brewInfo(
  brewPath: string,
  kind: HomebrewDetection["kind"],
  name: string,
  deps: HomebrewUpdateChannelDeps,
  options: UpdateOperationOptions,
) {
  const result = await runBrew(
    brewPath,
    ["info", "--json=v2", kind === "formula" ? "--formula" : "--cask", name],
    deps.commandRunner,
    options,
  );
  return BrewInfoSchema.parse(JSON.parse(result.stdout));
}

async function requireSameDetection(
  expected: HomebrewDetection,
  deps: HomebrewUpdateChannelDeps,
  options: UpdateOperationOptions,
): Promise<HomebrewDetection> {
  const current = await detectHomebrew(deps, options);
  if (
    current === undefined ||
    current.kind !== expected.kind ||
    current.currentVersion !== expected.currentVersion ||
    current.brewPath !== expected.brewPath ||
    current.packageName !== expected.packageName ||
    current.executablePath !== expected.executablePath ||
    current.runtimePath !== expected.runtimePath
  ) {
    throw stalePlan("The Homebrew-owned Station installation changed after planning.");
  }
  return current;
}

function runBrew(
  brewPath: string,
  args: string[],
  commandRunner: ExternalCommandRunner | undefined,
  options: UpdateOperationOptions,
) {
  return runExternalCommand(
    {
      command: brewPath,
      args,
      env: { HOMEBREW_NO_AUTO_UPDATE: "1" },
      timeoutMs: 30_000,
      maxOutputChars: 64 * 1024,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    commandRunner,
  );
}

function oneLine(output: string, label: string): string {
  const lines = output.trim().split(/\r?\n/u);
  if (lines.length !== 1 || lines[0] === undefined || lines[0].length === 0) {
    throw new Error(`${label} was not one non-empty line.`);
  }
  return lines[0];
}

function stalePlan(message: string) {
  return updateErrorFromUnknown(undefined, {
    code: "UPDATE_PLAN_STALE",
    message,
    hint: "Run stn update again to build a fresh plan.",
  });
}
