import { createHash } from "node:crypto";
import { type BigIntStats, createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type ExternalCommandRunner,
  isSafeError,
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
import type { UpdateChannel, UpdateOperationOptions } from "./updateChannel.js";
import {
  appendUpdateErrorHint,
  type UpdateErrorFallback,
  updateErrorFromUnknown,
} from "./updateError.js";

const channel = "installer-binary" as const;
const receiptName = ".station-install-receipt";
const receiptContent = "station-installer-binary-v1\n";
const expectedInstallationFormat = "station-installer-expected-v1";
const downloadedFileMaxBytes = 1024 * 1024;
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

export type InstallationFileIdentity = {
  device: string;
  inode: string;
};

export type InstallationBinaryIdentity = InstallationFileIdentity & {
  sha256: string;
};

export type InstallerBinaryDetection = {
  channel: typeof channel;
  currentVersion: string;
  currentTag: string;
  platform: NativeBinaryTarget;
  installDir: string;
  executablePath: string;
  binaryIdentity: InstallationBinaryIdentity;
  ingressIdentity: InstallationFileIdentity;
  popupIdentity: InstallationFileIdentity;
  receiptIdentity: InstallationFileIdentity;
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

type OwnedInstallationLayout = {
  executablePath: string;
  installDir: string;
  binaryIdentity: InstallationBinaryIdentity;
  ingressIdentity: InstallationFileIdentity;
  popupIdentity: InstallationFileIdentity;
  receiptIdentity: InstallationFileIdentity;
};

const FileIdentitySchema = z
  .object({
    device: z.string().regex(/^(?:0|[1-9]\d*)$/u),
    inode: z.string().regex(/^(?:0|[1-9]\d*)$/u),
  })
  .strict();
const BinaryIdentitySchema = FileIdentitySchema.extend({
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
const InstallerBinaryDetectionSchema = z
  .object({
    channel: z.literal(channel),
    currentVersion: z.string().min(1),
    currentTag: z.string().min(2),
    platform: z.enum(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]),
    installDir: z.string().startsWith("/"),
    executablePath: z.string().startsWith("/"),
    binaryIdentity: BinaryIdentitySchema,
    ingressIdentity: FileIdentitySchema,
    popupIdentity: FileIdentitySchema,
    receiptIdentity: FileIdentitySchema,
  })
  .strict();
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

      const beforeVersion = await inspectOwnedInstallation(executablePath);
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

      const afterVersion = await inspectOwnedInstallation(executablePath);
      if (afterVersion === undefined || !sameOwnedLayout(beforeVersion, afterVersion)) {
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
      await requireUnchangedInstallation(detection);

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
  await requireUnchangedInstallation(plan);
  const installerPath = join(updateTempDir, "install.sh");
  const checksumsPath = join(updateTempDir, "SHA256SUMS");
  const expectedInstallationPath = join(updateTempDir, "expected-installation");

  try {
    await downloadReleaseFile(
      plan.target.assets.installer.url,
      installerPath,
      commandRunner,
      options.signal,
    );
    await downloadReleaseFile(
      plan.target.assets.checksums.url,
      checksumsPath,
      commandRunner,
      options.signal,
    );
  } catch (error) {
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_INSTALLER_VERIFICATION_FAILED",
      message: `Could not download the verified installer for ${plan.target.tag}.`,
    });
  }

  await verifyDownloadedInstaller(installerPath, checksumsPath, plan.target.tag);
  try {
    await runExternalCommand(
      {
        command: "/bin/sh",
        args: ["-n", installerPath],
        timeoutMs: 10_000,
        maxOutputChars: childOutputMaxChars,
        unsetEnv: strippedInstallerEnvironment,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      commandRunner,
    );
  } catch (error) {
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_INSTALLER_VERIFICATION_FAILED",
      message: `The installer for ${plan.target.tag} failed shell validation.`,
    });
  }

  await requireUnchangedInstallation(plan);
  await writeFile(expectedInstallationPath, expectedInstallationText(plan), {
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

  if (installerFailure === undefined) {
    await postcheckInstallation(plan, commandRunner, options.signal);
    return installedReport(plan, []);
  }

  try {
    await postcheckInstallation(plan, commandRunner, options.signal);
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

async function inspectOwnedInstallation(
  candidatePath: string,
): Promise<OwnedInstallationLayout | undefined> {
  let executablePath: string;
  try {
    executablePath = await realpath(candidatePath);
  } catch {
    return undefined;
  }
  if (basename(executablePath) !== "stn") return undefined;

  try {
    const executable = await lstat(executablePath, { bigint: true });
    if (!executable.isFile() || executable.isSymbolicLink() || (executable.mode & 0o111n) === 0n) {
      return undefined;
    }
    const installDir = dirname(executablePath);
    const ingressPath = join(installDir, "stn-ingress");
    const popupPath = join(installDir, "stn-tmux-popup");
    const receiptPath = join(installDir, receiptName);
    const [ingress, popup] = await Promise.all([
      launcherIdentity(ingressPath),
      launcherIdentity(popupPath),
    ]);
    if (ingress === undefined || popup === undefined) return undefined;

    let receipt: BigIntStats;
    try {
      receipt = await lstat(receiptPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return undefined;
    }
    if (
      !receipt.isFile() ||
      receipt.isSymbolicLink() ||
      (receipt.mode & 0o7777n) !== 0o600n ||
      (await readFile(receiptPath, "utf8")) !== receiptContent
    ) {
      throw installationInvalid(
        `Station installer receipt '${receiptPath}' is malformed or unsafe.`,
      );
    }

    return {
      executablePath,
      installDir,
      binaryIdentity: {
        device: String(executable.dev),
        inode: String(executable.ino),
        sha256: await sha256File(executablePath),
      },
      ingressIdentity: statIdentity(ingress),
      popupIdentity: statIdentity(popup),
      receiptIdentity: statIdentity(receipt),
    };
  } catch (error) {
    if (isSafeError(error) && error.code === "UPDATE_INSTALLATION_INVALID") throw error;
    return undefined;
  }
}

async function launcherIdentity(path: string) {
  try {
    const launcher = await lstat(path, { bigint: true });
    if (!launcher.isSymbolicLink() || (await readlink(path)) !== "stn") return undefined;
    return launcher;
  } catch {
    return undefined;
  }
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
  await requireUnchangedInstallation(updatePlan);
  return updatePlan;
}

async function requireUnchangedInstallation(detection: InstallerBinaryDetection): Promise<void> {
  let current: OwnedInstallationLayout | undefined;
  try {
    current = await inspectOwnedInstallation(detection.executablePath);
  } catch {
    throw planStale();
  }
  if (current === undefined || !sameDetectionLayout(detection, current)) throw planStale();
}

async function downloadReleaseFile(
  url: string,
  outputPath: string,
  commandRunner: ExternalCommandRunner | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  await runExternalCommand(
    {
      command: "curl",
      args: [
        "--disable",
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--tlsv1.2",
        "--max-filesize",
        String(downloadedFileMaxBytes),
        "--output",
        outputPath,
        url,
      ],
      timeoutMs: 30_000,
      maxOutputChars: childOutputMaxChars,
      unsetEnv: strippedInstallerEnvironment,
      ...(signal === undefined ? {} : { signal }),
    },
    commandRunner,
  );
  await requireBoundedRegularFile(outputPath);
}

async function requireBoundedRegularFile(path: string): Promise<void> {
  const file = await lstat(path);
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.size <= 0 ||
    file.size > downloadedFileMaxBytes
  ) {
    throw new Error(`Downloaded release file '${path}' is not a bounded regular file.`);
  }
}

async function verifyDownloadedInstaller(
  installerPath: string,
  checksumsPath: string,
  targetTag: string,
): Promise<void> {
  try {
    await Promise.all([
      requireBoundedRegularFile(installerPath),
      requireBoundedRegularFile(checksumsPath),
    ]);
    const [installer, checksums] = await Promise.all([
      readFile(installerPath),
      readFile(checksumsPath, "utf8"),
    ]);
    const installerChecksumLines = checksums
      .split(/\r?\n/u)
      .filter((line) => /(?:^|[ \t])\*?install\.sh$/u.test(line));
    if (installerChecksumLines.length !== 1) {
      throw new Error("SHA256SUMS must contain exactly one checksum for install.sh.");
    }
    const checksumMatch = /^([0-9A-Fa-f]{64})[ \t]+\*?install\.sh$/u.exec(
      installerChecksumLines[0] ?? "",
    );
    if (checksumMatch?.[1] === undefined) {
      throw new Error("SHA256SUMS contains an invalid checksum for install.sh.");
    }
    const actualHash = createHash("sha256").update(installer).digest("hex");
    if (actualHash !== checksumMatch[1].toLowerCase()) {
      throw new Error("The install.sh checksum does not match SHA256SUMS.");
    }
    const stampLines = installer
      .toString("utf8")
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("embedded_version="));
    if (stampLines.length !== 1 || stampLines[0] !== `embedded_version="${targetTag}"`) {
      throw new Error("The installer version stamp does not match the target release.");
    }
  } catch (error) {
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_INSTALLER_VERIFICATION_FAILED",
      message: `The installer for ${targetTag} could not be verified.`,
    });
  }
}

async function postcheckInstallation(
  plan: Extract<InstallerBinaryUpdatePlan, { status: "update-available" }>,
  commandRunner: ExternalCommandRunner | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    const layout = await inspectOwnedInstallation(plan.executablePath);
    if (
      layout === undefined ||
      layout.executablePath !== plan.executablePath ||
      layout.installDir !== plan.installDir ||
      sameFileIdentity(layout.binaryIdentity, plan.binaryIdentity) ||
      layout.binaryIdentity.sha256 === plan.binaryIdentity.sha256 ||
      !sameFileIdentity(layout.ingressIdentity, plan.ingressIdentity) ||
      !sameFileIdentity(layout.popupIdentity, plan.popupIdentity) ||
      !sameFileIdentity(layout.receiptIdentity, plan.receiptIdentity)
    ) {
      throw new Error("The installed Station layout does not match the planned replacement.");
    }
    const version = await runExternalCommand(
      {
        command: plan.executablePath,
        args: ["--version"],
        timeoutMs: 10_000,
        maxOutputChars: childOutputMaxChars,
        unsetEnv: strippedInstallerEnvironment,
        ...(signal === undefined ? {} : { signal }),
      },
      commandRunner,
    );
    if (version.stdout.trim() !== plan.target.version) {
      throw new Error(
        `Installed Station reported '${version.stdout.trim()}' instead of '${plan.target.version}'.`,
      );
    }
  } catch (error) {
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_POSTCHECK_FAILED",
      message: `Station ${plan.target.tag} was installed but could not be verified.`,
      hint: `Inspect '${plan.executablePath} --version' and the Station installer locks before retrying.`,
    });
  }
}

function expectedInstallationText(detection: InstallerBinaryDetection): string {
  return [
    `format=${expectedInstallationFormat}`,
    `binary_sha256=${detection.binaryIdentity.sha256}`,
    `binary_device=${detection.binaryIdentity.device}`,
    `binary_inode=${detection.binaryIdentity.inode}`,
    `ingress_device=${detection.ingressIdentity.device}`,
    `ingress_inode=${detection.ingressIdentity.inode}`,
    `popup_device=${detection.popupIdentity.device}`,
    `popup_inode=${detection.popupIdentity.inode}`,
    `receipt_device=${detection.receiptIdentity.device}`,
    `receipt_inode=${detection.receiptIdentity.inode}`,
    "",
  ].join("\n");
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

function sameOwnedLayout(left: OwnedInstallationLayout, right: OwnedInstallationLayout): boolean {
  return (
    left.executablePath === right.executablePath &&
    left.installDir === right.installDir &&
    sameDetectionLayout(left, right)
  );
}

function sameDetectionLayout(
  left: Pick<
    InstallerBinaryDetection,
    "binaryIdentity" | "ingressIdentity" | "popupIdentity" | "receiptIdentity"
  >,
  right: OwnedInstallationLayout,
): boolean {
  return (
    sameFileIdentity(left.binaryIdentity, right.binaryIdentity) &&
    left.binaryIdentity.sha256 === right.binaryIdentity.sha256 &&
    sameFileIdentity(left.ingressIdentity, right.ingressIdentity) &&
    sameFileIdentity(left.popupIdentity, right.popupIdentity) &&
    sameFileIdentity(left.receiptIdentity, right.receiptIdentity)
  );
}

function sameFileIdentity(
  left: InstallationFileIdentity,
  right: InstallationFileIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function statIdentity(stat: { dev: bigint; ino: bigint }): InstallationFileIdentity {
  return { device: String(stat.dev), inode: String(stat.ino) };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
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

function planStale(): RuntimeSafeError {
  return updateFailure({
    code: "UPDATE_PLAN_STALE",
    message: "The Station installation changed after the update was planned.",
    hint: "Plan the update again from the currently installed stn binary.",
  });
}

function releaseInvalid(message: string): RuntimeSafeError {
  return updateFailure({
    code: "UPDATE_RELEASE_INVALID",
    message,
    hint: "Wait for a complete Station release or install an exact known-good release manually.",
  });
}

function installationInvalid(message: string): RuntimeSafeError {
  return updateFailure({
    code: "UPDATE_INSTALLATION_INVALID",
    message,
    hint: "Repair the installer receipt manually or reinstall the exact current tag.",
  });
}

function updateFailure(fallback: UpdateErrorFallback): RuntimeSafeError {
  return updateErrorFromUnknown(undefined, fallback);
}
