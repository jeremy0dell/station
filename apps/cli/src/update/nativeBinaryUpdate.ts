import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type ExternalCommandRunner,
  type RuntimeSafeError,
  runExternalCommand,
  type StationBuildInfo,
  safeErrorFromUnknown,
  stationBuildInfo,
} from "@station/runtime";
import {
  createGithubNativeReleaseDiscovery,
  isCanonicalNativeRelease,
  type NativeBinaryRelease,
  type NativeBinaryTarget,
  type NativeReleaseDiscovery,
  releaseVersion,
} from "./githubRelease.js";

const channel = "native-binary" as const;
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

export type NativeExecutableIdentity = {
  device: string;
  inode: string;
};

export type NativeBinaryUpdatePlan =
  | {
      status: "current";
      channel: typeof channel;
      current: NativeBinaryRelease;
      target: NativeBinaryRelease;
      platform: NativeBinaryTarget;
      installDir: string;
      executablePath: string;
    }
  | {
      status: "update-available";
      channel: typeof channel;
      current: NativeBinaryRelease;
      target: NativeBinaryRelease;
      platform: NativeBinaryTarget;
      installDir: string;
      executablePath: string;
      executableIdentity: NativeExecutableIdentity;
    };

export type NativeBinaryUpdateReport = {
  status: "installed";
  channel: typeof channel;
  previousVersion: string;
  installedVersion: string;
  executablePath: string;
};

/**
 * DRIVEN PORT
 *
 * Gives the future update coordinator a typed capability for planning and applying one
 * verified native-binary replacement without owning process crossover.
 */
export interface NativeBinaryUpdateEngine {
  plan(options?: { signal?: AbortSignal }): Promise<NativeBinaryUpdatePlan>;
  apply(
    plan: Extract<NativeBinaryUpdatePlan, { status: "update-available" }>,
    options?: { signal?: AbortSignal },
  ): Promise<NativeBinaryUpdateReport>;
}

export type NativeBinaryUpdateEngineDeps = {
  buildInfo?: () => StationBuildInfo;
  executablePath?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  releaseDiscovery?: NativeReleaseDiscovery;
  commandRunner?: ExternalCommandRunner;
  tempRoot?: string;
};

type InstalledLayout = {
  executablePath: string;
  installDir: string;
  identity: NativeExecutableIdentity;
};

/**
 * ADAPTER
 *
 * Translates compiled-install identity, GitHub release metadata, and the verified release
 * installer into an atomic native-binary replacement report.
 *
 * @knipignore The final update coordinator tracked under issue #511 will compose this factory.
 */
export function createNativeBinaryUpdateEngine(
  deps: NativeBinaryUpdateEngineDeps = {},
): NativeBinaryUpdateEngine {
  const buildInfo = deps.buildInfo ?? stationBuildInfo;
  const executablePath = deps.executablePath ?? process.execPath;
  const platform = deps.platform ?? process.platform;
  const architecture = deps.architecture ?? process.arch;
  const releaseDiscovery =
    deps.releaseDiscovery ??
    createGithubNativeReleaseDiscovery(
      deps.commandRunner === undefined ? {} : { commandRunner: deps.commandRunner },
    );
  const commandRunner = deps.commandRunner;
  const tempRoot = deps.tempRoot ?? tmpdir();

  return {
    async plan(options = {}) {
      const info = buildInfo();
      if (!info.compiled) {
        throw unsupportedInstall("Source checkouts cannot be updated through the binary channel.");
      }
      const targetPlatform = nativeTarget(platform, architecture);
      const layout = await installedLayout(executablePath, "UPDATE_CHANNEL_UNSUPPORTED");
      const currentTag = `v${info.version}`;
      if (releaseVersion(currentTag) !== info.version) {
        throw releaseInvalid(
          `Installed Station version '${currentTag}' is not valid release SemVer.`,
        );
      }
      const releases = await releaseDiscovery.resolve({
        currentTag,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (releases.current.tag !== currentTag || !isCanonicalNativeRelease(releases.current)) {
        throw releaseInvalid(`Installed Station version '${currentTag}' is not a valid release.`);
      }
      if (!isCanonicalNativeRelease(releases.latest)) {
        throw releaseInvalid("The selected Station update release is invalid.");
      }

      if (
        releases.current.releaseId === releases.latest.releaseId ||
        comparePublication(releases.current, releases.latest) > 0
      ) {
        return {
          status: "current",
          channel,
          current: releases.current,
          target: releases.current,
          platform: targetPlatform,
          installDir: layout.installDir,
          executablePath: layout.executablePath,
        };
      }

      return {
        status: "update-available",
        channel,
        current: releases.current,
        target: releases.latest,
        platform: targetPlatform,
        installDir: layout.installDir,
        executablePath: layout.executablePath,
        executableIdentity: layout.identity,
      };
    },

    async apply(plan, options = {}) {
      if (!isCanonicalNativeRelease(plan.target)) {
        throw releaseInvalid("The Station update plan contains an invalid target release.");
      }
      await requireUnchangedLayout(plan);

      let updateTempDir: string | undefined;
      try {
        try {
          updateTempDir = await mkdtemp(join(tempRoot, "station-update-"));
          await chmod(updateTempDir, 0o700);
        } catch (error) {
          throw updateFailure(error, {
            code: "UPDATE_INSTALLER_VERIFICATION_FAILED",
            message: "Could not create a private Station update staging directory.",
          });
        }
        const installerPath = join(updateTempDir, "install.sh");
        const checksumsPath = join(updateTempDir, "SHA256SUMS");

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
          throw updateFailure(error, {
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
          throw updateFailure(error, {
            code: "UPDATE_INSTALLER_VERIFICATION_FAILED",
            message: `The installer for ${plan.target.tag} failed shell validation.`,
          });
        }

        // The old inode pins the exact installation that was planned; any replacement invalidates consent.
        await requireUnchangedLayout(plan);
        try {
          await runExternalCommand(
            {
              command: "/bin/sh",
              args: [installerPath, "--version", plan.target.tag, "--install-dir", plan.installDir],
              timeoutMs: installerTimeoutMs,
              maxOutputChars: childOutputMaxChars,
              unsetEnv: strippedInstallerEnvironment,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            },
            commandRunner,
          );
        } catch (error) {
          throw updateFailure(error, {
            code: "UPDATE_INSTALL_FAILED",
            message: `Station ${plan.target.tag} could not be installed.`,
          });
        }

        await postcheckInstallation(plan, commandRunner, options.signal);
        return {
          status: "installed",
          channel,
          previousVersion: plan.current.version,
          installedVersion: plan.target.version,
          executablePath: plan.executablePath,
        };
      } finally {
        if (updateTempDir !== undefined) {
          await rm(updateTempDir, { recursive: true, force: true });
        }
      }
    },
  };
}

async function installedLayout(
  candidatePath: string,
  failureCode: "UPDATE_CHANNEL_UNSUPPORTED" | "UPDATE_PLAN_STALE",
): Promise<InstalledLayout> {
  try {
    const executablePath = await realpath(candidatePath);
    if (basename(executablePath) !== "stn") {
      throw new Error("Station executable is not named stn.");
    }
    const executable = await lstat(executablePath, { bigint: true });
    if (!executable.isFile() || executable.isSymbolicLink() || (executable.mode & 0o111n) === 0n) {
      throw new Error("Station executable is not a physical executable file.");
    }
    const installDir = dirname(executablePath);
    await Promise.all([
      requireLauncher(join(installDir, "stn-ingress")),
      requireLauncher(join(installDir, "stn-tmux-popup")),
    ]);
    return {
      executablePath,
      installDir,
      identity: { device: String(executable.dev), inode: String(executable.ino) },
    };
  } catch (error) {
    throw updateFailure(error, {
      code: failureCode,
      message:
        failureCode === "UPDATE_PLAN_STALE"
          ? "The Station installation changed after the update was planned."
          : "This Station installation is not supported by the native-binary update channel.",
      hint:
        failureCode === "UPDATE_PLAN_STALE"
          ? "Plan the update again from the currently installed stn binary."
          : "Use the installation method that owns this Station executable.",
    });
  }
}

async function requireLauncher(path: string): Promise<void> {
  const launcher = await lstat(path);
  if (!launcher.isSymbolicLink() || (await readlink(path)) !== "stn") {
    throw new Error(`${path} is not a relative symlink to stn.`);
  }
}

async function requireUnchangedLayout(
  plan: Extract<NativeBinaryUpdatePlan, { status: "update-available" }>,
): Promise<void> {
  const current = await installedLayout(plan.executablePath, "UPDATE_PLAN_STALE");
  if (
    current.executablePath !== plan.executablePath ||
    current.installDir !== plan.installDir ||
    current.identity.device !== plan.executableIdentity.device ||
    current.identity.inode !== plan.executableIdentity.inode
  ) {
    throw updateFailure(undefined, {
      code: "UPDATE_PLAN_STALE",
      message: "The Station installation changed after the update was planned.",
      hint: "Plan the update again from the currently installed stn binary.",
    });
  }
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
    const expectedHashes = checksums
      .split(/\r?\n/u)
      .map((line) => /^([0-9A-Fa-f]{64})[ \t]+\*?(.+)$/u.exec(line))
      .filter((match) => match?.[2] === "install.sh")
      .map((match) => match?.[1]?.toLowerCase());
    if (expectedHashes.length !== 1 || expectedHashes[0] === undefined) {
      throw new Error("SHA256SUMS must contain exactly one valid checksum for install.sh.");
    }
    const actualHash = createHash("sha256").update(installer).digest("hex");
    if (actualHash !== expectedHashes[0]) {
      throw new Error("The install.sh checksum does not match SHA256SUMS.");
    }
    const installerText = installer.toString("utf8");
    const stampLines = installerText
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("embedded_version="));
    if (stampLines.length !== 1 || stampLines[0] !== `embedded_version="${targetTag}"`) {
      throw new Error("The installer version stamp does not match the target release.");
    }
  } catch (error) {
    throw updateFailure(error, {
      code: "UPDATE_INSTALLER_VERIFICATION_FAILED",
      message: `The installer for ${targetTag} could not be verified.`,
    });
  }
}

async function postcheckInstallation(
  plan: Extract<NativeBinaryUpdatePlan, { status: "update-available" }>,
  commandRunner: ExternalCommandRunner | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    const layout = await installedLayout(plan.executablePath, "UPDATE_PLAN_STALE");
    if (layout.executablePath !== plan.executablePath || layout.installDir !== plan.installDir) {
      throw new Error("The installed Station executable moved during installation.");
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
    throw updateFailure(error, {
      code: "UPDATE_POSTCHECK_FAILED",
      message: `Station ${plan.target.tag} was installed but could not be verified.`,
      hint: `Inspect '${plan.executablePath} --version' and the Station installer locks before retrying.`,
    });
  }
}

function nativeTarget(platform: NodeJS.Platform, architecture: string): NativeBinaryTarget {
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
      throw unsupportedInstall(
        `Station native updates do not support ${platform}/${architecture}.`,
      );
  }
}

function comparePublication(left: NativeBinaryRelease, right: NativeBinaryRelease): number {
  const timestampDifference = Date.parse(left.publishedAt) - Date.parse(right.publishedAt);
  return timestampDifference === 0 ? left.releaseId - right.releaseId : timestampDifference;
}

function unsupportedInstall(message: string): RuntimeSafeError {
  return {
    tag: "UpdateError",
    code: "UPDATE_CHANNEL_UNSUPPORTED",
    message,
    hint: "Use the installation method that owns this Station executable.",
  };
}

function releaseInvalid(message: string): RuntimeSafeError {
  return {
    tag: "UpdateError",
    code: "UPDATE_RELEASE_INVALID",
    message,
    hint: "Wait for a complete Station release or install an exact known-good release manually.",
  };
}

function updateFailure(
  error: unknown,
  fallback: { code: string; message: string; hint?: string },
): RuntimeSafeError {
  const cause = safeErrorFromUnknown(error, {
    tag: "UpdateError",
    code: fallback.code,
    message: fallback.message,
    ...(fallback.hint === undefined ? {} : { hint: fallback.hint }),
  });
  return {
    tag: "UpdateError",
    code: fallback.code,
    message: fallback.message,
    ...(cause.hint === undefined && fallback.hint === undefined
      ? {}
      : { hint: cause.hint ?? fallback.hint }),
    ...(cause.diagnosticDetails === undefined
      ? {}
      : { diagnosticDetails: cause.diagnosticDetails }),
  };
}

export type { NativeBinaryRelease, NativeBinaryTarget, NativeReleaseDiscovery };
