import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type ExternalCommandRunner,
  normalizeCancellationError,
  type RuntimeSafeError,
  runExternalCommand,
  type StationBuildInfo,
  stationBuildInfo,
} from "@station/runtime";
import { z } from "zod";
import {
  createGithubNativeReleaseDiscovery,
  isCanonicalNativeRelease,
  type NativeBinaryRelease,
  type NativeBinaryTarget,
  type NativeReleaseDiscovery,
  releaseVersion,
} from "./githubRelease.js";
import {
  type InstallerInstallation,
  InstallerInstallationSchema,
  inspectInstallerInstallation,
  installerExpectationText,
  postcheckInstallerInstallation,
  requireUnchangedInstallerInstallation,
  sameInstallerInstallation,
} from "./installerInstallation.js";
import type { UpdateChannel, UpdateOperationOptions } from "./updateChannel.js";
import {
  appendUpdateErrorHint,
  type UpdateErrorFallback,
  updateErrorFromUnknown,
} from "./updateError.js";
import { acquireVerifiedInstaller } from "./verifiedInstaller.js";

const channel = "installer-binary" as const;
const installerTimeoutMs = 5 * 60_000;
const childOutputMaxChars = 64 * 1024;
const strippedInstallerEnvironment = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "STATION_INSTALL_RELEASE_ID",
] as const;

export type InstallerBinaryDetection = InstallerInstallation & {
  channel: typeof channel;
  currentVersion: string;
  currentTag: string;
  platform: NativeBinaryTarget;
};

type InstallerBinaryPlanBase = InstallerBinaryDetection & {
  current: NativeBinaryRelease;
  target: NativeBinaryRelease;
};

export type InstallerBinaryUpdatePlan =
  | (InstallerBinaryPlanBase & { status: "current" })
  | (InstallerBinaryPlanBase & { status: "update-available" });

export type InstallerBinaryUpdateReport = {
  status: "installed";
  channel: typeof channel;
  previousVersion: string;
  installedVersion: string;
  executablePath: string;
  warnings: RuntimeSafeError[];
};

export type InstallerBinaryUpdateChannel = UpdateChannel<
  InstallerBinaryDetection,
  InstallerBinaryUpdatePlan,
  InstallerBinaryUpdateReport
>;

export type InstallerBinaryUpdateChannelDeps = {
  buildInfo?: () => StationBuildInfo;
  executablePath?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  releaseDiscovery?: NativeReleaseDiscovery;
  commandRunner?: ExternalCommandRunner;
  tempRoot?: string;
  removeTempDir?: (path: string) => Promise<void>;
};

const InstallerBinaryDetectionSchema = InstallerInstallationSchema.extend({
  channel: z.literal(channel),
  currentVersion: z.string().min(1),
  currentTag: z.string().min(2),
  platform: z.enum(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]),
}).strict();
const InstallerBinaryUpdatePlanSchema = InstallerBinaryDetectionSchema.extend({
  status: z.literal("update-available"),
  current: z.unknown(),
  target: z.unknown(),
}).strict();

/**
 * Creates the installer-owned binary channel. Detection requires the ownership receipt,
 * and apply delegates mutation only after the installer locks and rechecks every planned identity.
 *
 * @knipignore Follow-up #514 will compose this channel into the public update command.
 */
export function createInstallerBinaryUpdateChannel(
  deps: InstallerBinaryUpdateChannelDeps = {},
): InstallerBinaryUpdateChannel {
  const buildInfo = deps.buildInfo ?? stationBuildInfo;
  const executablePath = deps.executablePath ?? process.execPath;
  const platform = deps.platform ?? process.platform;
  const architecture = deps.architecture ?? process.arch;
  const commandRunner = deps.commandRunner;
  const releaseDiscovery =
    deps.releaseDiscovery ??
    createGithubNativeReleaseDiscovery(commandRunner === undefined ? {} : { commandRunner });
  const tempRoot = deps.tempRoot ?? tmpdir();
  const removeTempDir =
    deps.removeTempDir ?? ((path: string) => rm(path, { recursive: true, force: true }));

  return {
    async detect(options = {}) {
      const info = buildInfo();
      const targetPlatform = nativeTarget(platform, architecture);
      if (!info.compiled || targetPlatform === undefined) return undefined;

      let currentTag: string;
      try {
        currentTag = `v${info.version}`;
        if (releaseVersion(currentTag) !== info.version) return undefined;
      } catch {
        return undefined;
      }

      const beforeVersion = await inspectInstallerInstallation(executablePath);
      if (beforeVersion === undefined) return undefined;
      let version: string;
      try {
        version = (
          await runExternalCommand(
            {
              command: beforeVersion.executablePath,
              args: ["--version"],
              timeoutMs: 10_000,
              maxOutputChars: childOutputMaxChars,
              unsetEnv: strippedInstallerEnvironment,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            },
            commandRunner,
          )
        ).stdout.trim();
      } catch (error) {
        const cancellation = normalizeCancellationError(error);
        if (cancellation !== undefined) throw cancellation;
        return undefined;
      }
      if (version !== info.version) return undefined;

      const afterVersion = await inspectInstallerInstallation(executablePath);
      if (afterVersion === undefined || !sameInstallerInstallation(beforeVersion, afterVersion)) {
        return undefined;
      }
      return {
        channel,
        currentVersion: info.version,
        currentTag,
        platform: targetPlatform,
        ...afterVersion,
      };
    },

    async plan(detection, options = {}) {
      await validateDetectionSemantics(detection, {
        buildInfo,
        executablePath,
        platform,
        architecture,
      });
      await requireUnchangedInstallerInstallation(detection);

      const releases = await releaseDiscovery.resolve({
        currentTag: detection.currentTag,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (
        releases.current.tag !== detection.currentTag ||
        releases.current.version !== detection.currentVersion ||
        !isCanonicalNativeRelease(releases.current)
      ) {
        throw releaseInvalid(
          `Installed Station version '${detection.currentTag}' is not a valid release.`,
        );
      }
      if (!isCanonicalNativeRelease(releases.latest)) {
        throw releaseInvalid("The selected Station update release is invalid.");
      }

      if (
        releases.current.releaseId === releases.latest.releaseId ||
        comparePublication(releases.current, releases.latest) >= 0
      ) {
        return {
          ...detection,
          status: "current",
          current: releases.current,
          target: releases.current,
        };
      }

      return {
        ...detection,
        status: "update-available",
        current: releases.current,
        target: releases.latest,
      };
    },

    async apply(plan, options = {}) {
      const validatedPlan = await validateApplyPlan(plan, {
        buildInfo,
        executablePath,
        platform,
        architecture,
      });

      let updateTempDir: string | undefined;
      let outcome:
        | { ok: true; report: InstallerBinaryUpdateReport }
        | { ok: false; error: RuntimeSafeError };
      try {
        updateTempDir = await createPrivateTempDir(tempRoot);
        outcome = {
          ok: true,
          report: await applyVerifiedInstaller(
            validatedPlan,
            updateTempDir,
            commandRunner,
            options,
          ),
        };
      } catch (error) {
        outcome = {
          ok: false,
          error: updateErrorFromUnknown(error, {
            code: "UPDATE_FAILED",
            message: "Station could not apply the installer-binary update.",
          }),
        };
      }

      let cleanupWarning: RuntimeSafeError | undefined;
      if (updateTempDir !== undefined) {
        try {
          await removeTempDir(updateTempDir);
        } catch (error) {
          cleanupWarning = updateErrorFromUnknown(error, {
            code: "UPDATE_CLEANUP_FAILED",
            message: "Station was unable to remove its private update staging directory.",
            hint: "Remove the residual private update directory manually.",
          });
        }
      }

      if (outcome.ok) {
        if (cleanupWarning !== undefined) outcome.report.warnings.push(cleanupWarning);
        return outcome.report;
      }
      if (cleanupWarning !== undefined) {
        throw appendUpdateErrorHint(
          outcome.error,
          "Update staging cleanup also failed; remove the residual private directory manually.",
        );
      }
      throw outcome.error;
    },
  };
}

async function applyVerifiedInstaller(
  plan: Extract<InstallerBinaryUpdatePlan, { status: "update-available" }>,
  updateTempDir: string,
  commandRunner: ExternalCommandRunner | undefined,
  options: UpdateOperationOptions,
): Promise<InstallerBinaryUpdateReport> {
  await requireUnchangedInstallerInstallation(plan);
  const expectedInstallationPath = join(updateTempDir, "expected-installation");
  const installerPath = await acquireVerifiedInstaller({
    updateTempDir,
    installerUrl: plan.target.assets.installer.url,
    checksumsUrl: plan.target.assets.checksums.url,
    targetTag: plan.target.tag,
    maxOutputChars: childOutputMaxChars,
    unsetEnv: strippedInstallerEnvironment,
    commandRunner,
    signal: options.signal,
  });

  await requireUnchangedInstallerInstallation(plan);
  await writeFile(expectedInstallationPath, installerExpectationText(plan), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  let installerFailure: RuntimeSafeError | undefined;
  try {
    await runExternalCommand(
      {
        command: "/bin/sh",
        args: [
          installerPath,
          "--version",
          plan.target.tag,
          "--install-dir",
          plan.installDir,
          "--expected-installation",
          expectedInstallationPath,
        ],
        timeoutMs: installerTimeoutMs,
        maxOutputChars: childOutputMaxChars,
        unsetEnv: strippedInstallerEnvironment,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      commandRunner,
    );
  } catch (error) {
    const cancellation = normalizeCancellationError(error);
    if (cancellation !== undefined) throw cancellation;
    installerFailure = updateErrorFromUnknown(error, {
      code: "UPDATE_INSTALL_FAILED",
      message: `Station ${plan.target.tag} could not be installed.`,
    });
  }

  const postcheck = () =>
    postcheckInstallerInstallation({
      previous: plan,
      targetTag: plan.target.tag,
      targetVersion: plan.target.version,
      maxOutputChars: childOutputMaxChars,
      unsetEnv: strippedInstallerEnvironment,
      commandRunner,
      signal: options.signal,
    });

  if (installerFailure === undefined) {
    await postcheck();
    return installedReport(plan, []);
  }

  try {
    await postcheck();
  } catch (error) {
    const cancellation = normalizeCancellationError(error);
    if (cancellation !== undefined) throw cancellation;
    const postcheckFailure = updateErrorFromUnknown(error, {
      code: "UPDATE_POSTCHECK_FAILED",
      message: `Station ${plan.target.tag} could not be verified after installer failure.`,
    });
    throw combineInstallAndPostcheckFailures(installerFailure, postcheckFailure, plan);
  }

  const warning = updateErrorFromUnknown(
    installerFailure,
    {
      code: "UPDATE_INSTALL_REPORTED_FAILURE",
      message: `The installer reported failure after Station ${plan.target.tag} committed successfully.`,
      hint: `The installed binary at '${plan.executablePath}' passed the complete postcheck.`,
    },
    false,
  );
  return installedReport(plan, [warning]);
}

async function validateDetectionSemantics(
  detection: InstallerBinaryDetection,
  runtime: {
    buildInfo: () => StationBuildInfo;
    executablePath: string;
    platform: NodeJS.Platform;
    architecture: string;
  },
  validateShape = true,
): Promise<void> {
  if (validateShape && !InstallerBinaryDetectionSchema.safeParse(detection).success) {
    throw planInvalid();
  }
  const info = runtime.buildInfo();
  const targetPlatform = nativeTarget(runtime.platform, runtime.architecture);
  let runningPath: string;
  try {
    runningPath = await realpath(runtime.executablePath);
  } catch {
    throw planInvalid();
  }
  if (
    !info.compiled ||
    detection.currentVersion !== info.version ||
    detection.currentTag !== `v${info.version}` ||
    targetPlatform === undefined ||
    detection.platform !== targetPlatform ||
    detection.executablePath !== runningPath ||
    detection.installDir !== dirname(runningPath) ||
    basename(runningPath) !== "stn"
  ) {
    throw planInvalid();
  }
  let version: string;
  try {
    version = releaseVersion(detection.currentTag);
  } catch {
    throw planInvalid();
  }
  if (version !== detection.currentVersion) throw planInvalid();
}

async function validateApplyPlan(
  plan: InstallerBinaryUpdatePlan,
  runtime: {
    buildInfo: () => StationBuildInfo;
    executablePath: string;
    platform: NodeJS.Platform;
    architecture: string;
  },
): Promise<Extract<InstallerBinaryUpdatePlan, { status: "update-available" }>> {
  const parsedPlan = InstallerBinaryUpdatePlanSchema.safeParse(plan);
  if (!parsedPlan.success) throw planInvalid();
  const updatePlan = plan as Extract<InstallerBinaryUpdatePlan, { status: "update-available" }>;
  await validateDetectionSemantics(updatePlan, runtime, false);
  if (
    !isCanonicalNativeRelease(updatePlan.current) ||
    !isCanonicalNativeRelease(updatePlan.target) ||
    updatePlan.current.tag !== updatePlan.currentTag ||
    updatePlan.current.version !== updatePlan.currentVersion ||
    comparePublication(updatePlan.current, updatePlan.target) >= 0
  ) {
    throw planInvalid();
  }
  await requireUnchangedInstallerInstallation(updatePlan);
  return updatePlan;
}

function installedReport(
  plan: Extract<InstallerBinaryUpdatePlan, { status: "update-available" }>,
  warnings: RuntimeSafeError[],
): InstallerBinaryUpdateReport {
  return {
    status: "installed",
    channel,
    previousVersion: plan.current.version,
    installedVersion: plan.target.version,
    executablePath: plan.executablePath,
    warnings,
  };
}

function combineInstallAndPostcheckFailures(
  installerFailure: RuntimeSafeError,
  postcheckFailure: RuntimeSafeError,
  plan: Extract<InstallerBinaryUpdatePlan, { status: "update-available" }>,
): RuntimeSafeError {
  const combined: RuntimeSafeError = {
    tag: "UpdateError",
    code: "UPDATE_INSTALL_FAILED",
    message: `Station ${plan.target.tag} could not be installed or verified.`,
    hint: `${installerFailure.message} ${postcheckFailure.message} Inspect '${plan.executablePath} --version' and the Station installer locks before retrying.`,
  };
  const diagnostics = [
    ...(installerFailure.diagnosticDetails ?? []),
    ...(postcheckFailure.diagnosticDetails ?? []),
  ];
  if (diagnostics.length > 0) combined.diagnosticDetails = diagnostics;
  return combined;
}

function nativeTarget(
  platform: NodeJS.Platform,
  architecture: string,
): NativeBinaryTarget | undefined {
  switch (`${platform}:${architecture}`) {
    case "darwin:arm64":
      return "darwin-arm64";
    case "darwin:x64":
      return "darwin-x64";
    case "linux:arm64":
      return "linux-arm64";
    case "linux:x64":
      return "linux-x64";
    default:
      return undefined;
  }
}

function comparePublication(left: NativeBinaryRelease, right: NativeBinaryRelease): number {
  const timestampDifference = Date.parse(left.publishedAt) - Date.parse(right.publishedAt);
  return timestampDifference === 0 ? left.releaseId - right.releaseId : timestampDifference;
}

async function createPrivateTempDir(root: string): Promise<string> {
  try {
    const path = await mkdtemp(join(root, "station-update-"));
    await chmod(path, 0o700);
    return path;
  } catch (error) {
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_INSTALLER_VERIFICATION_FAILED",
      message: "Could not create a private Station update staging directory.",
    });
  }
}

function planInvalid(): RuntimeSafeError {
  return updateFailure({
    code: "UPDATE_PLAN_INVALID",
    message: "The Station update plan is invalid or was altered after planning.",
    hint: "Discard the plan and detect the installer-owned installation again.",
  });
}

function releaseInvalid(message: string): RuntimeSafeError {
  return updateFailure({
    code: "UPDATE_RELEASE_INVALID",
    message,
    hint: "Wait for a complete Station release or install an exact known-good release manually.",
  });
}

function updateFailure(fallback: UpdateErrorFallback): RuntimeSafeError {
  return updateErrorFromUnknown(undefined, fallback);
}
