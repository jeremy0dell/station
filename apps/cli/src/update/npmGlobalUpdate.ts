import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { UpdateArtifact } from "@station/contracts";
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

const channel = "npm-global" as const;
const outputMaxChars = 64 * 1024;

const PackageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  bin: z.union([z.string().min(1), z.record(z.string(), z.string().min(1))]),
});

export type NpmGlobalDetection = {
  channel: typeof channel;
  currentVersion: string;
  npmPath: string;
  packageName: string;
  packageRoot: string;
  executablePath: string;
  entryPath: string;
};

export type NpmGlobalUpdatePlan = PackageManagerPlanBase &
  NpmGlobalDetection & {
    channel: typeof channel;
  };

export type NpmGlobalUpdateReport = PackageManagerUpdateReport & {
  channel: typeof channel;
};

export type NpmGlobalUpdateChannelDeps = {
  runtimePath: string;
  pathEnv?: string;
  commandRunner?: ExternalCommandRunner;
};

/**
 * ADAPTER
 *
 * Translates npm's global package and bin ownership into a pinned package-manager update.
 * Installed-target proof reads the active package only and does not invoke `npm view`.
 */
export function createNpmGlobalUpdateChannel(
  deps: NpmGlobalUpdateChannelDeps,
): UpdateChannel<NpmGlobalDetection, NpmGlobalUpdatePlan, NpmGlobalUpdateReport> {
  return {
    id: channel,
    detect: (options = {}) => detectNpmGlobal(deps, options),
    async plan(detection, options = {}) {
      await requireSameDetection(detection, deps, options);
      const targetVersion = await npmLatestVersion(detection, deps.commandRunner, options);
      return {
        ...detection,
        status: targetVersion === detection.currentVersion ? "current" : "update-available",
        targetVersion,
        currentCli: [detection.executablePath],
        successorCli: [detection.executablePath],
        managerCommand: [
          detection.npmPath,
          "install",
          "--global",
          `${detection.packageName}@${targetVersion}`,
        ],
      };
    },
    async proveInstalledTarget(target: UpdateArtifact, options = {}) {
      const detection = await detectNpmGlobal(deps, options);
      if (
        detection === undefined ||
        target.revision !== undefined ||
        detection.currentVersion !== target.version
      ) {
        return undefined;
      }
      return {
        channel,
        status: "current",
        currentVersion: target.version,
        targetVersion: target.version,
        currentCli: [detection.executablePath],
      };
    },
    async apply(plan, options = {}) {
      return applyPackageManagerPlan(plan, options, {
        commandRunner: deps.commandRunner,
        revalidate: async () => {
          await requireSameDetection(plan, deps, options);
          const targetVersion = await npmLatestVersion(plan, deps.commandRunner, options);
          if (
            targetVersion !== plan.targetVersion ||
            !sameUpdateCommand(plan.managerCommand, [
              plan.npmPath,
              "install",
              "--global",
              `${plan.packageName}@${targetVersion}`,
            ]) ||
            !sameUpdateCommand(plan.currentCli, [plan.executablePath]) ||
            !sameUpdateCommand(plan.successorCli, [plan.executablePath])
          ) {
            throw invalidManagerPlan();
          }
        },
        postcheck: async () => {
          const installed = await detectNpmGlobal(deps, options, false);
          if (
            installed === undefined ||
            installed.packageName !== plan.packageName ||
            installed.currentVersion !== plan.targetVersion ||
            installed.entryPath !== plan.entryPath
          ) {
            throw stalePlan("npm did not leave the planned Station package active.");
          }
        },
      }) as Promise<NpmGlobalUpdateReport>;
    },
  };
}

async function detectNpmGlobal(
  deps: NpmGlobalUpdateChannelDeps,
  options: UpdateOperationOptions,
  requireRunningRuntime = true,
): Promise<NpmGlobalDetection | undefined> {
  const npmPath = await resolveExecutablePath(
    "npm",
    deps.pathEnv === undefined ? {} : { pathEnv: deps.pathEnv },
  );
  if (npmPath === undefined) return undefined;

  try {
    const [rootResult, prefixResult] = await Promise.all([
      runNpm(npmPath, ["root", "--global"], deps.commandRunner, options),
      runNpm(npmPath, ["prefix", "--global"], deps.commandRunner, options),
    ]);
    const packageRoot = oneLine(rootResult.stdout, "npm global package root");
    const prefix = oneLine(prefixResult.stdout, "npm global prefix");
    const executablePath = resolve(prefix, "bin", "stn");
    const runtimePath = await realpath(requireRunningRuntime ? deps.runtimePath : executablePath);
    const packages = await globalPackageDirectories(packageRoot);
    for (const packageDirectory of packages) {
      const parsed = await readPackage(packageDirectory);
      if (parsed === undefined) continue;
      const binPath = stationBinPath(parsed, packageDirectory);
      if (binPath === undefined) continue;
      let entryPath: string;
      try {
        entryPath = await realpath(binPath);
      } catch {
        continue;
      }
      if (entryPath !== runtimePath) continue;
      if ((await realpath(executablePath)) !== runtimePath) continue;
      return {
        channel,
        currentVersion: parsed.version,
        npmPath,
        packageName: parsed.name,
        packageRoot,
        executablePath,
        entryPath,
      };
    }
    return undefined;
  } catch (error) {
    const cancellation = normalizeCancellationError(error);
    if (cancellation !== undefined) throw cancellation;
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_CHANNEL_DETECT_FAILED",
      message: "npm global installation ownership could not be inspected.",
    });
  }
}

async function globalPackageDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const directories: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (!entry.name.startsWith("@")) {
      directories.push(path);
      continue;
    }
    const scoped = await readdir(path, { withFileTypes: true });
    for (const candidate of scoped) {
      if (candidate.isDirectory() || candidate.isSymbolicLink()) {
        directories.push(join(path, candidate.name));
      }
    }
  }
  return directories;
}

async function readPackage(path: string): Promise<z.infer<typeof PackageJsonSchema> | undefined> {
  try {
    return PackageJsonSchema.parse(JSON.parse(await readFile(join(path, "package.json"), "utf8")));
  } catch {
    return undefined;
  }
}

function stationBinPath(
  manifest: z.infer<typeof PackageJsonSchema>,
  packageDirectory: string,
): string | undefined {
  if (typeof manifest.bin === "string") {
    return basename(manifest.name) === "stn" ? resolve(packageDirectory, manifest.bin) : undefined;
  }
  const relative = manifest.bin.stn;
  return relative === undefined ? undefined : resolve(packageDirectory, relative);
}

async function npmLatestVersion(
  detection: NpmGlobalDetection,
  commandRunner: ExternalCommandRunner | undefined,
  options: UpdateOperationOptions,
): Promise<string> {
  try {
    const result = await runNpm(
      detection.npmPath,
      ["view", `${detection.packageName}@latest`, "version", "--json"],
      commandRunner,
      options,
    );
    return z.string().min(1).parse(JSON.parse(result.stdout));
  } catch (error) {
    const cancellation = normalizeCancellationError(error);
    if (cancellation !== undefined) throw cancellation;
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_PLAN_FAILED",
      message: "npm could not resolve the latest Station package version.",
    });
  }
}

async function requireSameDetection(
  expected: NpmGlobalDetection,
  deps: NpmGlobalUpdateChannelDeps,
  options: UpdateOperationOptions,
): Promise<void> {
  const current = await detectNpmGlobal(deps, options);
  if (
    current === undefined ||
    current.currentVersion !== expected.currentVersion ||
    current.packageName !== expected.packageName ||
    current.packageRoot !== expected.packageRoot ||
    current.executablePath !== expected.executablePath ||
    current.entryPath !== expected.entryPath
  ) {
    throw stalePlan("The npm-owned Station installation changed after planning.");
  }
}

function runNpm(
  npmPath: string,
  args: string[],
  commandRunner: ExternalCommandRunner | undefined,
  options: UpdateOperationOptions,
) {
  return runExternalCommand(
    {
      command: npmPath,
      args,
      timeoutMs: 30_000,
      maxOutputChars: outputMaxChars,
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
