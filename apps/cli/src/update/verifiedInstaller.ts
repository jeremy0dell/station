import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExternalCommandRunner, runExternalCommand } from "@station/runtime";
import { updateErrorFromUnknown } from "./updateError.js";

const downloadedFileMaxBytes = 1024 * 1024;

export async function acquireVerifiedInstaller(options: {
  updateTempDir: string;
  installerUrl: string;
  checksumsUrl: string;
  targetTag: string;
  maxOutputChars: number;
  unsetEnv: readonly string[];
  commandRunner: ExternalCommandRunner | undefined;
  signal: AbortSignal | undefined;
}): Promise<string> {
  const installerPath = join(options.updateTempDir, "install.sh");
  const checksumsPath = join(options.updateTempDir, "SHA256SUMS");

  try {
    await downloadReleaseFile(
      options.installerUrl,
      installerPath,
      options.commandRunner,
      options.signal,
      options.unsetEnv,
      options.maxOutputChars,
    );
    await downloadReleaseFile(
      options.checksumsUrl,
      checksumsPath,
      options.commandRunner,
      options.signal,
      options.unsetEnv,
      options.maxOutputChars,
    );
  } catch (error) {
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_INSTALLER_VERIFICATION_FAILED",
      message: `Could not download the verified installer for ${options.targetTag}.`,
    });
  }

  await verifyDownloadedInstaller(installerPath, checksumsPath, options.targetTag);
  try {
    await runExternalCommand(
      {
        command: "/bin/sh",
        args: ["-n", installerPath],
        timeoutMs: 10_000,
        maxOutputChars: options.maxOutputChars,
        unsetEnv: options.unsetEnv,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      options.commandRunner,
    );
  } catch (error) {
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_INSTALLER_VERIFICATION_FAILED",
      message: `The installer for ${options.targetTag} failed shell validation.`,
    });
  }
  return installerPath;
}

async function downloadReleaseFile(
  url: string,
  outputPath: string,
  commandRunner: ExternalCommandRunner | undefined,
  signal: AbortSignal | undefined,
  unsetEnv: readonly string[],
  maxOutputChars: number,
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
      maxOutputChars,
      unsetEnv,
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
