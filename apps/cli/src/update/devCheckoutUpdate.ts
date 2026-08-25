import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import {
  type ExternalCommandRunner,
  isSafeError,
  normalizeCancellationError,
  resolveExecutablePath,
  runExternalCommand,
  type StationBuildInfo,
  stationBuildInfo,
} from "@station/runtime";
import { z } from "zod";
import type {
  UpdateApplyReportBase,
  UpdateChannel,
  UpdateCommandArgv,
  UpdateOperationOptions,
  UpdatePlanBase,
} from "./updateChannel.js";
import { updateErrorFromUnknown } from "./updateError.js";

const channel = "dev-checkout" as const;
const PackageSchema = z.object({
  name: z.literal("station"),
  version: z.string().min(1),
});
const ExactPackageManagerVersionSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  );
const PreparationScriptsSchema = z.object({
  build: z.string().min(1),
  "station:link": z.string().min(1),
});
const LegacyTargetPackageSchema = PackageSchema.extend({
  packageManager: z
    .string()
    .regex(/^pnpm@/u)
    .transform((value) => value.slice("pnpm@".length))
    .pipe(ExactPackageManagerVersionSchema),
  scripts: PreparationScriptsSchema,
  workspaces: z.undefined().optional(),
}).transform(() => ({ kind: "legacy-pnpm" }) as const);
const RootBunTargetPackageSchema = PackageSchema.extend({
  packageManager: z
    .string()
    .regex(/^bun@/u)
    .transform((value) => value.slice("bun@".length))
    .pipe(ExactPackageManagerVersionSchema),
  scripts: PreparationScriptsSchema,
  workspaces: z
    .array(z.string())
    .refine((workspaces) => workspaces.includes("station"), "station must be a root workspace"),
}).transform(({ packageManager }) => ({
  kind: "root-bun" as const,
  requiredBunVersion: packageManager,
}));
const TargetPackageSchema = z.union([LegacyTargetPackageSchema, RootBunTargetPackageSchema]);
const LegacyStationPackageSchema = z.object({
  name: z.literal("@station/workspace"),
  scripts: z.object({
    "link:station": z.string().min(1),
    "repair:node-pty": z.string().min(1),
  }),
});
const RootBunStationPackageSchema = z.object({
  name: z.literal("@station/workspace"),
  scripts: z.object({
    "repair:node-pty": z.string().min(1),
  }),
});

type DevCheckoutTarget = z.infer<typeof TargetPackageSchema>;

export type DevCheckoutDetection = {
  channel: typeof channel;
  currentVersion: string;
  currentRevision: string;
  buildIdentity: string;
  repoRoot: string;
  cliEntryPath: string;
  runtimePath: string;
  gitPath: string;
  pnpmPath?: string;
  bunPath: string;
};

export type DevCheckoutUpdatePlan = UpdatePlanBase &
  DevCheckoutDetection & {
    channel: typeof channel;
    branch: string;
    upstreamRemote: string;
    upstreamRef: string;
    targetRevision: string;
  };

export type DevCheckoutUpdateReport = UpdateApplyReportBase & {
  channel: typeof channel;
  status: "updated";
  previousRevision: string;
  installedRevision: string;
};

export type DevCheckoutUpdateChannelDeps = {
  cliEntryPath: string;
  runtimePath?: string;
  pathEnv?: string;
  buildInfo?: () => StationBuildInfo;
  commandRunner?: ExternalCommandRunner;
};

/**
 * ADAPTER
 *
 * Translates a clean upstream-tracking checkout into a pinned fast-forward whose fetched target
 * selects and preflights the matching legacy-pnpm or root-Bun preparation boundary.
 */
export function createDevCheckoutUpdateChannel(
  deps: DevCheckoutUpdateChannelDeps,
): UpdateChannel<DevCheckoutDetection, DevCheckoutUpdatePlan, DevCheckoutUpdateReport> {
  const recoveryCommandsByFailure = new WeakMap<object, readonly UpdateCommandArgv[]>();

  return {
    id: channel,
    detect: (options = {}) => detectDevCheckout(deps, options),
    async plan(detection, options = {}) {
      await requireSameDetection(detection, deps, options);
      await requireCleanCheckout(detection, deps.commandRunner, options);
      const branch = await gitLine(
        detection,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        deps.commandRunner,
        options,
        "The development checkout must be on an attached branch.",
      );
      const upstreamRemote = await gitLine(
        detection,
        ["config", "--get", `branch.${branch}.remote`],
        deps.commandRunner,
        options,
        "The development branch must have an upstream remote.",
      );
      const upstreamRef = await gitLine(
        detection,
        ["config", "--get", `branch.${branch}.merge`],
        deps.commandRunner,
        options,
        "The development branch must have an upstream ref.",
      );
      if (!upstreamRef.startsWith("refs/heads/")) {
        throw planFailure("The development branch upstream is not a branch ref.");
      }
      const targetRevision = await remoteRevision(
        detection,
        upstreamRemote,
        upstreamRef,
        deps.commandRunner,
        options,
      );
      return {
        ...detection,
        status: targetRevision === detection.currentRevision ? "current" : "update-available",
        targetVersion: detection.currentVersion,
        currentCli: [detection.runtimePath, detection.cliEntryPath],
        targetRevision,
        branch,
        upstreamRemote,
        upstreamRef,
      };
    },
    async apply(plan, options = {}) {
      if (
        plan.status !== "update-available" ||
        plan.targetVersion !== plan.currentVersion ||
        !sameCommand(plan.currentCli, [plan.runtimePath, plan.cliEntryPath])
      ) {
        throw invalidPlan();
      }
      await requireSameDetection(plan, deps, options);
      await requireCleanCheckout(plan, deps.commandRunner, options);
      const branch = await gitLine(
        plan,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        deps.commandRunner,
        options,
        "The development checkout must remain on its planned branch.",
      );
      const upstreamRemote = await gitLine(
        plan,
        ["config", "--get", `branch.${branch}.remote`],
        deps.commandRunner,
        options,
        "The development branch must retain its planned upstream remote.",
      );
      const upstreamRef = await gitLine(
        plan,
        ["config", "--get", `branch.${branch}.merge`],
        deps.commandRunner,
        options,
        "The development branch must retain its planned upstream ref.",
      );
      if (
        branch !== plan.branch ||
        upstreamRemote !== plan.upstreamRemote ||
        upstreamRef !== plan.upstreamRef
      ) {
        throw stalePlan("The development branch or upstream changed after planning.");
      }
      if (
        (await remoteRevision(
          plan,
          plan.upstreamRemote,
          plan.upstreamRef,
          deps.commandRunner,
          options,
        )) !== plan.targetRevision
      ) {
        throw stalePlan("The development branch upstream changed after planning.");
      }

      await runGit(
        plan,
        ["fetch", "--no-tags", plan.upstreamRemote, plan.upstreamRef],
        deps.commandRunner,
        options,
      );
      const fetched = await gitLine(
        plan,
        ["rev-parse", "FETCH_HEAD"],
        deps.commandRunner,
        options,
        "Git did not expose the fetched Station revision.",
      );
      if (fetched !== plan.targetRevision) {
        throw stalePlan("Git fetched a different Station revision than the planned target.");
      }
      await requireFastForward(plan, deps.commandRunner, options);
      const target = await inspectTargetPackage(plan, deps.commandRunner, options);
      if (target.kind === "root-bun") {
        await requireTargetBunRuntime(plan, target.requiredBunVersion, deps.commandRunner, options);
      } else if (plan.pnpmPath === undefined) {
        throw planFailure(
          "The legacy-pnpm target requires pnpm, but no pnpm executable is available.",
        );
      }
      await runGit(plan, ["merge", "--ff-only", plan.targetRevision], deps.commandRunner, options);

      const preparationCommands = devCheckoutPreparationCommands(plan, target);
      try {
        for (const command of preparationCommands) {
          await runExternalCommand(
            commandInput(command.executable, command.args, command.cwd, options),
            deps.commandRunner,
          );
        }
      } catch (error) {
        const cancellation = normalizeCancellationError(error);
        if (cancellation !== undefined) throw cancellation;
        const failure = updateErrorFromUnknown(error, {
          code: "UPDATE_DEV_CHECKOUT_PREPARE_FAILED",
          message:
            "The development checkout advanced but its dependencies, build, or links could not be prepared.",
          hint: "Run the reported preparation commands before retrying Station.",
        });
        recoveryCommandsByFailure.set(
          failure,
          preparationCommands.map(({ recoveryCommand }) => recoveryCommand),
        );
        throw failure;
      }

      const installedVersion = (
        await runExternalCommand(
          commandInput(plan.runtimePath, [plan.cliEntryPath, "--version"], plan.repoRoot, options),
          deps.commandRunner,
        )
      ).stdout.trim();
      if (installedVersion.length === 0) {
        throw stalePlan("The rebuilt Station CLI did not report a version.");
      }
      const installedRevision = await gitLine(
        plan,
        ["rev-parse", "HEAD"],
        deps.commandRunner,
        options,
        "The rebuilt checkout revision could not be verified.",
      );
      if (installedRevision !== plan.targetRevision) {
        throw stalePlan("The development checkout moved again during its rebuild.");
      }
      return {
        channel,
        status: "updated",
        previousVersion: plan.currentVersion,
        installedVersion,
        previousRevision: plan.currentRevision,
        installedRevision,
        successorCli: [plan.runtimePath, plan.cliEntryPath],
        warnings: [],
      };
    },
    applyRecoveryCommands(plan, error) {
      if (
        !isSafeError(error) ||
        error.tag !== "UpdateError" ||
        error.code !== "UPDATE_DEV_CHECKOUT_PREPARE_FAILED"
      ) {
        return undefined;
      }
      return (
        recoveryCommandsByFailure.get(error) ??
        (plan.pnpmPath === undefined
          ? undefined
          : legacyPreparationCommands(plan, plan.pnpmPath).map(
              ({ recoveryCommand }) => recoveryCommand,
            ))
      );
    },
  };
}

type DevCheckoutPreparationCommand = {
  executable: string;
  args: string[];
  cwd: string;
  recoveryCommand: UpdateCommandArgv;
};

function devCheckoutPreparationCommands(
  plan: DevCheckoutUpdatePlan,
  target: DevCheckoutTarget,
): DevCheckoutPreparationCommand[] {
  switch (target.kind) {
    case "legacy-pnpm":
      if (plan.pnpmPath === undefined) {
        throw planFailure(
          "The legacy-pnpm target requires pnpm, but no pnpm executable is available.",
        );
      }
      return legacyPreparationCommands(plan, plan.pnpmPath);
    case "root-bun":
      return rootBunPreparationCommands(plan);
  }
}

function legacyPreparationCommands(
  plan: DevCheckoutUpdatePlan,
  pnpmPath: string,
): DevCheckoutPreparationCommand[] {
  const stationRoot = resolve(plan.repoRoot, "station");
  // Bun installation prunes the manual @station links, and recreating them requires fresh root dist output.
  return [
    {
      executable: pnpmPath,
      args: ["install", "--frozen-lockfile"],
      cwd: plan.repoRoot,
      recoveryCommand: [pnpmPath, "--dir", plan.repoRoot, "install", "--frozen-lockfile"],
    },
    {
      executable: plan.bunPath,
      args: ["install", "--frozen-lockfile"],
      cwd: stationRoot,
      recoveryCommand: [plan.bunPath, "--cwd", stationRoot, "install", "--frozen-lockfile"],
    },
    {
      executable: pnpmPath,
      args: ["build"],
      cwd: plan.repoRoot,
      recoveryCommand: [pnpmPath, "--dir", plan.repoRoot, "build"],
    },
    {
      executable: plan.bunPath,
      args: ["run", "link:station"],
      cwd: stationRoot,
      recoveryCommand: [plan.bunPath, "run", "--cwd", stationRoot, "link:station"],
    },
    {
      executable: plan.bunPath,
      args: ["run", "repair:node-pty"],
      cwd: stationRoot,
      recoveryCommand: [plan.bunPath, "run", "--cwd", stationRoot, "repair:node-pty"],
    },
    {
      executable: pnpmPath,
      args: ["station:link"],
      cwd: plan.repoRoot,
      recoveryCommand: [pnpmPath, "--dir", plan.repoRoot, "station:link"],
    },
  ];
}

function rootBunPreparationCommands(plan: DevCheckoutUpdatePlan): DevCheckoutPreparationCommand[] {
  const stationRoot = resolve(plan.repoRoot, "station");
  return [
    {
      executable: plan.bunPath,
      args: ["install", "--frozen-lockfile"],
      cwd: plan.repoRoot,
      recoveryCommand: [plan.bunPath, "install", "--cwd", plan.repoRoot, "--frozen-lockfile"],
    },
    {
      executable: plan.bunPath,
      args: ["run", "build"],
      cwd: plan.repoRoot,
      recoveryCommand: [plan.bunPath, "run", "--cwd", plan.repoRoot, "build"],
    },
    {
      executable: plan.bunPath,
      args: ["run", "repair:node-pty"],
      cwd: stationRoot,
      recoveryCommand: [plan.bunPath, "run", "--cwd", stationRoot, "repair:node-pty"],
    },
    {
      executable: plan.bunPath,
      args: ["run", "station:link"],
      cwd: plan.repoRoot,
      recoveryCommand: [plan.bunPath, "run", "--cwd", plan.repoRoot, "station:link"],
    },
  ];
}

async function detectDevCheckout(
  deps: DevCheckoutUpdateChannelDeps,
  options: UpdateOperationOptions,
): Promise<DevCheckoutDetection | undefined> {
  const info = (deps.buildInfo ?? stationBuildInfo)();
  if (info.compiled) return undefined;
  const executableOptions = deps.pathEnv === undefined ? {} : { pathEnv: deps.pathEnv };
  const gitPath = await resolveExecutablePath("git", executableOptions);
  const pnpmPath = await resolveExecutablePath("pnpm", executableOptions);
  const bunPath = await resolveExecutablePath("bun", executableOptions);
  if (gitPath === undefined || bunPath === undefined) return undefined;
  try {
    const cliEntryPath = await realpath(deps.cliEntryPath);
    const runtimePath = await realpath(deps.runtimePath ?? process.execPath);
    const rootResult = await runExternalCommand(
      commandInput(
        gitPath,
        ["-C", dirname(cliEntryPath), "rev-parse", "--show-toplevel"],
        undefined,
        options,
      ),
      deps.commandRunner,
    );
    const repoRoot = oneLine(rootResult.stdout, "Git checkout root");
    if (!isAbsolute(repoRoot) || !cliEntryPath.startsWith(`${repoRoot}${sep}`)) return undefined;
    const manifest = PackageSchema.parse(
      JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")),
    );
    const detection = {
      channel,
      currentVersion: manifest.version,
      currentRevision: "",
      buildIdentity: info.buildIdentity,
      repoRoot,
      cliEntryPath,
      runtimePath,
      gitPath,
      bunPath,
      ...(pnpmPath === undefined ? {} : { pnpmPath }),
    } satisfies DevCheckoutDetection;
    detection.currentRevision = await gitLine(
      detection,
      ["rev-parse", "HEAD"],
      deps.commandRunner,
      options,
      "The development checkout revision could not be read.",
    );
    return detection;
  } catch (error) {
    const cancellation = normalizeCancellationError(error);
    if (cancellation !== undefined) throw cancellation;
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_CHANNEL_DETECT_FAILED",
      message: "Development checkout ownership could not be inspected.",
    });
  }
}

async function requireSameDetection(
  expected: DevCheckoutDetection,
  deps: DevCheckoutUpdateChannelDeps,
  options: UpdateOperationOptions,
): Promise<void> {
  const current = await detectDevCheckout(deps, options);
  if (
    current === undefined ||
    current.currentVersion !== expected.currentVersion ||
    current.currentRevision !== expected.currentRevision ||
    current.buildIdentity !== expected.buildIdentity ||
    current.repoRoot !== expected.repoRoot ||
    current.cliEntryPath !== expected.cliEntryPath ||
    current.runtimePath !== expected.runtimePath ||
    current.gitPath !== expected.gitPath ||
    current.pnpmPath !== expected.pnpmPath ||
    current.bunPath !== expected.bunPath
  ) {
    throw stalePlan("The development checkout changed after planning.");
  }
}

async function requireCleanCheckout(
  detection: DevCheckoutDetection,
  commandRunner: ExternalCommandRunner | undefined,
  options: UpdateOperationOptions,
): Promise<void> {
  const status = await runGit(
    detection,
    ["status", "--porcelain=v2", "--untracked-files=normal"],
    commandRunner,
    options,
  );
  if (status.stdout.length > 0) {
    throw planFailure("The development checkout has uncommitted or untracked changes.");
  }
}

async function requireFastForward(
  plan: DevCheckoutUpdatePlan,
  commandRunner: ExternalCommandRunner | undefined,
  options: UpdateOperationOptions,
): Promise<void> {
  try {
    await runGit(
      plan,
      ["merge-base", "--is-ancestor", plan.currentRevision, plan.targetRevision],
      commandRunner,
      options,
    );
  } catch (error) {
    const cancellation = normalizeCancellationError(error);
    if (cancellation !== undefined) throw cancellation;
    throw planFailure("The development branch cannot fast-forward to its upstream target.");
  }
}

async function inspectTargetPackage(
  plan: DevCheckoutUpdatePlan,
  commandRunner: ExternalCommandRunner | undefined,
  options: UpdateOperationOptions,
): Promise<DevCheckoutTarget> {
  try {
    const result = await runGit(
      plan,
      ["show", `${plan.targetRevision}:package.json`],
      commandRunner,
      options,
    );
    const target = TargetPackageSchema.parse(JSON.parse(result.stdout));
    const stationResult = await runGit(
      plan,
      ["show", `${plan.targetRevision}:station/package.json`],
      commandRunner,
      options,
    );
    if (target.kind === "root-bun") {
      RootBunStationPackageSchema.parse(JSON.parse(stationResult.stdout));
    } else {
      LegacyStationPackageSchema.parse(JSON.parse(stationResult.stdout));
    }
    return target;
  } catch (error) {
    const cancellation = normalizeCancellationError(error);
    if (cancellation !== undefined) throw cancellation;
    throw updateErrorFromUnknown(
      error,
      {
        code: "UPDATE_PLAN_FAILED",
        message:
          "The target Station revision is not a supported legacy-pnpm or exact root-Bun checkout.",
        hint: "Inspect the fetched target package.json and rerun stn update; the checkout was not advanced.",
      },
      false,
    );
  }
}

async function requireTargetBunRuntime(
  plan: DevCheckoutUpdatePlan,
  requiredVersion: string,
  commandRunner: ExternalCommandRunner | undefined,
  options: UpdateOperationOptions,
): Promise<void> {
  let actualVersion: string;
  try {
    const result = await runExternalCommand(
      commandInput(plan.bunPath, ["--version"], plan.repoRoot, options),
      commandRunner,
    );
    actualVersion = ExactPackageManagerVersionSchema.parse(
      oneLine(result.stdout, "Bun version output"),
    );
  } catch (error) {
    const cancellation = normalizeCancellationError(error);
    if (cancellation !== undefined) throw cancellation;
    throw targetBunMismatch(requiredVersion, undefined, error);
  }
  if (actualVersion !== requiredVersion) {
    throw targetBunMismatch(requiredVersion, actualVersion);
  }
}

async function remoteRevision(
  detection: DevCheckoutDetection,
  remote: string,
  ref: string,
  commandRunner: ExternalCommandRunner | undefined,
  options: UpdateOperationOptions,
): Promise<string> {
  const result = await runGit(
    detection,
    ["ls-remote", "--exit-code", remote, ref],
    commandRunner,
    options,
  );
  const fields = result.stdout.trim().split(/\s+/u);
  const revision = fields[0];
  if (fields.length !== 2 || revision === undefined || !/^[0-9a-f]{40}$/u.test(revision)) {
    throw planFailure("Git returned an invalid upstream Station revision.");
  }
  return revision;
}

async function gitLine(
  detection: DevCheckoutDetection,
  args: string[],
  commandRunner: ExternalCommandRunner | undefined,
  options: UpdateOperationOptions,
  failureMessage: string,
): Promise<string> {
  try {
    return oneLine((await runGit(detection, args, commandRunner, options)).stdout, "Git output");
  } catch (error) {
    const cancellation = normalizeCancellationError(error);
    if (cancellation !== undefined) throw cancellation;
    throw planFailure(failureMessage);
  }
}

function runGit(
  detection: Pick<DevCheckoutDetection, "gitPath" | "repoRoot">,
  args: string[],
  commandRunner: ExternalCommandRunner | undefined,
  options: UpdateOperationOptions,
) {
  return runExternalCommand(
    commandInput(detection.gitPath, args, detection.repoRoot, options),
    commandRunner,
  );
}

function commandInput(
  command: string,
  args: string[],
  cwd: string | undefined,
  options: UpdateOperationOptions,
) {
  return {
    command,
    args,
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMs: 5 * 60_000,
    maxOutputChars: 64 * 1024,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function oneLine(output: string, label: string): string {
  const lines = output.trim().split(/\r?\n/u);
  if (lines.length !== 1 || lines[0] === undefined || lines[0].length === 0) {
    throw new Error(`${label} was not one non-empty line.`);
  }
  return lines[0];
}

function sameCommand(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalidPlan() {
  return updateErrorFromUnknown(undefined, {
    code: "UPDATE_PLAN_INVALID",
    message: "The development checkout update plan is invalid.",
    hint: "Run stn update again to build a fresh plan.",
  });
}

function planFailure(message: string) {
  return updateErrorFromUnknown(undefined, {
    code: "UPDATE_PLAN_FAILED",
    message,
    hint: "Commit, stash, or repair the checkout and rerun stn update.",
  });
}

function stalePlan(message: string) {
  return updateErrorFromUnknown(undefined, {
    code: "UPDATE_PLAN_STALE",
    message,
    hint: "Run stn update again to build a fresh plan.",
  });
}

function targetBunMismatch(requiredVersion: string, actualVersion?: string, error?: unknown) {
  const observed =
    actualVersion === undefined ? "could not be verified" : `reports ${actualVersion}`;
  return updateErrorFromUnknown(
    error,
    {
      code: "UPDATE_DEV_CHECKOUT_BUN_MISMATCH",
      message: `The target Station revision requires Bun ${requiredVersion}, but the planned Bun executable ${observed}.`,
      hint: `Activate exact Bun ${requiredVersion} on PATH, verify bun --version, and rerun stn update; the checkout was not advanced.`,
    },
    false,
  );
}
