import { createHash } from "node:crypto";
import { type BigIntStats, createReadStream } from "node:fs";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type ExternalCommandRunner,
  isSafeError,
  type RuntimeSafeError,
  runExternalCommand,
} from "@station/runtime";
import { z } from "zod";
import { updateErrorFromUnknown } from "./updateError.js";

const receiptName = ".station-install-receipt";
const receiptContent = "station-installer-binary-v1\n";
const expectedInstallationFormat = "station-installer-expected-v2";

const InstallationFileIdentitySchema = z
  .object({
    device: z.string().regex(/^(?:0|[1-9]\d*)$/u),
    inode: z.string().regex(/^(?:0|[1-9]\d*)$/u),
  })
  .strict();
const InstallationBinaryIdentitySchema = InstallationFileIdentitySchema.extend({
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
export const InstallerInstallationSchema = z
  .object({
    installDir: z.string().startsWith("/"),
    executablePath: z.string().startsWith("/"),
    binaryIdentity: InstallationBinaryIdentitySchema,
    ingressIdentity: InstallationBinaryIdentitySchema,
    popupIdentity: InstallationFileIdentitySchema,
    receiptIdentity: InstallationFileIdentitySchema,
  })
  .strict();

type InstallationFileIdentity = z.infer<typeof InstallationFileIdentitySchema>;
export type InstallerInstallation = z.infer<typeof InstallerInstallationSchema>;

export async function inspectInstallerInstallation(
  candidatePath: string,
): Promise<InstallerInstallation | undefined> {
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
      binaryIdentity(ingressPath),
      launcherIdentity(popupPath),
    ]);
    if (ingress === undefined || popup === undefined) return undefined;

    let receipt: BigIntStats;
    try {
      receipt = await lstat(receiptPath, { bigint: true });
    } catch {
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
      ingressIdentity: {
        ...statIdentity(ingress),
        sha256: await sha256File(ingressPath),
      },
      popupIdentity: statIdentity(popup),
      receiptIdentity: statIdentity(receipt),
    };
  } catch (error) {
    if (isSafeError(error) && error.code === "UPDATE_INSTALLATION_INVALID") throw error;
    return undefined;
  }
}

export async function requireUnchangedInstallerInstallation(
  expected: InstallerInstallation,
): Promise<void> {
  let current: InstallerInstallation | undefined;
  try {
    current = await inspectInstallerInstallation(expected.executablePath);
  } catch {
    throw planStale();
  }
  if (current === undefined || !sameInstallerInstallation(expected, current)) throw planStale();
}

export function sameInstallerInstallation(
  left: InstallerInstallation,
  right: InstallerInstallation,
): boolean {
  return (
    left.executablePath === right.executablePath &&
    left.installDir === right.installDir &&
    sameInstallationIdentity(left, right)
  );
}

export async function postcheckInstallerInstallation(options: {
  previous: InstallerInstallation;
  targetTag: string;
  targetVersion: string;
  maxOutputChars: number;
  unsetEnv: readonly string[];
  commandRunner: ExternalCommandRunner | undefined;
  signal: AbortSignal | undefined;
}): Promise<void> {
  try {
    const current = await inspectInstallerInstallation(options.previous.executablePath);
    if (current === undefined || !isInstallerReplacement(options.previous, current)) {
      throw new Error("The installed Station layout does not match the planned replacement.");
    }
    const version = await runExternalCommand(
      {
        command: options.previous.executablePath,
        args: ["--version"],
        timeoutMs: 10_000,
        maxOutputChars: options.maxOutputChars,
        unsetEnv: options.unsetEnv,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      options.commandRunner,
    );
    if (version.stdout.trim() !== options.targetVersion) {
      throw new Error(
        `Installed Station reported '${version.stdout.trim()}' instead of '${options.targetVersion}'.`,
      );
    }
  } catch (error) {
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_POSTCHECK_FAILED",
      message: `Station ${options.targetTag} was installed but could not be verified.`,
      hint: `Inspect '${options.previous.executablePath} --version' and the Station installer locks before retrying.`,
    });
  }
}

function isInstallerReplacement(
  previous: InstallerInstallation,
  current: InstallerInstallation,
): boolean {
  return (
    current.executablePath === previous.executablePath &&
    current.installDir === previous.installDir &&
    !sameFileIdentity(current.binaryIdentity, previous.binaryIdentity) &&
    current.binaryIdentity.sha256 !== previous.binaryIdentity.sha256 &&
    !sameFileIdentity(current.ingressIdentity, previous.ingressIdentity) &&
    current.ingressIdentity.sha256 !== previous.ingressIdentity.sha256 &&
    sameFileIdentity(current.popupIdentity, previous.popupIdentity) &&
    sameFileIdentity(current.receiptIdentity, previous.receiptIdentity)
  );
}

export function installerExpectationText(installation: InstallerInstallation): string {
  return [
    `format=${expectedInstallationFormat}`,
    `binary_sha256=${installation.binaryIdentity.sha256}`,
    `binary_device=${installation.binaryIdentity.device}`,
    `binary_inode=${installation.binaryIdentity.inode}`,
    `ingress_device=${installation.ingressIdentity.device}`,
    `ingress_inode=${installation.ingressIdentity.inode}`,
    `ingress_sha256=${installation.ingressIdentity.sha256}`,
    `popup_device=${installation.popupIdentity.device}`,
    `popup_inode=${installation.popupIdentity.inode}`,
    `receipt_device=${installation.receiptIdentity.device}`,
    `receipt_inode=${installation.receiptIdentity.inode}`,
    "",
  ].join("\n");
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

async function binaryIdentity(path: string) {
  try {
    const binary = await lstat(path, { bigint: true });
    if (!binary.isFile() || binary.isSymbolicLink() || (binary.mode & 0o111n) === 0n) {
      return undefined;
    }
    return binary;
  } catch {
    return undefined;
  }
}

function sameInstallationIdentity(
  left: InstallerInstallation,
  right: InstallerInstallation,
): boolean {
  return (
    sameFileIdentity(left.binaryIdentity, right.binaryIdentity) &&
    left.binaryIdentity.sha256 === right.binaryIdentity.sha256 &&
    sameFileIdentity(left.ingressIdentity, right.ingressIdentity) &&
    left.ingressIdentity.sha256 === right.ingressIdentity.sha256 &&
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

function planStale(): RuntimeSafeError {
  return updateErrorFromUnknown(undefined, {
    code: "UPDATE_PLAN_STALE",
    message: "The Station installation changed after the update was planned.",
    hint: "Plan the update again from the currently installed stn binary.",
  });
}

function installationInvalid(message: string): RuntimeSafeError {
  return updateErrorFromUnknown(undefined, {
    code: "UPDATE_INSTALLATION_INVALID",
    message,
    hint: "Repair the installer receipt manually or reinstall the exact current tag.",
  });
}
