import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type FileHandle, link, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ObserverProcessIdentity, ObserverProcessIdentitySchema } from "@station/contracts";

export type CreateObserverProcessIdentityOptions = {
  pid: number;
  version: string;
  socketPath: string;
};

function readOsStartTime(pid: number): string {
  const psPath = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
  const osStartTime = execFileSync(psPath, ["-ww", "-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
  }).trim();
  if (osStartTime.length === 0) {
    throw new Error(`Could not determine the OS start time for process ${pid}.`);
  }
  return osStartTime;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function identitiesMatch(
  actual: ObserverProcessIdentity,
  expected: ObserverProcessIdentity,
): boolean {
  return (
    actual.pid === expected.pid &&
    actual.osStartTime === expected.osStartTime &&
    actual.version === expected.version &&
    actual.socketPath === expected.socketPath
  );
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT";
}

function isExistingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null | undefined)?.code === "EEXIST";
}

async function restoreClaimedIdentity(claimedPath: string, path: string): Promise<void> {
  try {
    await link(claimedPath, path);
  } catch (error) {
    if (!isExistingFile(error)) {
      throw error;
    }
  }
  await unlink(claimedPath);
  await syncDirectory(dirname(path));
}

export function observerPidfilePath(socketPath: string): string {
  return `${socketPath}.pid`;
}

export function createObserverProcessIdentity(
  options: CreateObserverProcessIdentityOptions,
): ObserverProcessIdentity {
  return ObserverProcessIdentitySchema.parse({
    pid: options.pid,
    osStartTime: readOsStartTime(options.pid),
    version: options.version,
    socketPath: options.socketPath,
  });
}

export async function publishObserverProcessIdentity(
  identity: ObserverProcessIdentity,
): Promise<void> {
  const parsedIdentity = ObserverProcessIdentitySchema.parse(identity);
  const path = observerPidfilePath(parsedIdentity.socketPath);
  const directory = dirname(path);
  const temporaryPath = join(directory, `.observer.pid.${process.pid}.${randomUUID()}.tmp`);
  let temporaryFile: FileHandle | undefined;
  try {
    temporaryFile = await open(temporaryPath, "wx", 0o600);
    await temporaryFile.chmod(0o600);
    await temporaryFile.writeFile(`${JSON.stringify(parsedIdentity)}\n`, "utf8");
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    await temporaryFile?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function readObserverProcessIdentity(
  socketPath: string,
): Promise<ObserverProcessIdentity | undefined> {
  try {
    const serialized = await readFile(observerPidfilePath(socketPath), "utf8");
    return ObserverProcessIdentitySchema.parse(JSON.parse(serialized));
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function removeObserverProcessIdentity(
  expectedIdentity: ObserverProcessIdentity,
): Promise<boolean> {
  const path = observerPidfilePath(expectedIdentity.socketPath);
  const claimedPath = join(dirname(path), `.observer.pid.${process.pid}.${randomUUID()}.remove`);
  try {
    await rename(path, claimedPath);
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }

  let currentIdentity: ObserverProcessIdentity;
  try {
    currentIdentity = ObserverProcessIdentitySchema.parse(
      JSON.parse(await readFile(claimedPath, "utf8")),
    );
  } catch (error) {
    try {
      await restoreClaimedIdentity(claimedPath, path);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Observer process identity could not be parsed or restored.",
      );
    }
    throw error;
  }

  if (!identitiesMatch(currentIdentity, expectedIdentity)) {
    await restoreClaimedIdentity(claimedPath, path);
    return false;
  }

  try {
    await unlink(claimedPath);
  } catch (error) {
    await restoreClaimedIdentity(claimedPath, path).catch(() => undefined);
    throw error;
  }
  await syncDirectory(dirname(path));
  return true;
}
