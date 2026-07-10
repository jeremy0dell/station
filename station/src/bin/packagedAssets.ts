import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stationBuildInfo } from "@station/runtime";
import type {
  StationTerminalProcess,
  StationTerminalSpawnOptions,
} from "../terminal/types.js";
import {
  createLocalPtyTerminal,
  type PtyImplementation,
  resolvePtyImplementation,
} from "../terminal/pty/localPtyTerminal.js";

const DIRECTORY_MODE = 0o700;
const HELPER_MODE = 0o700;
const PI_MODE = 0o600;
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const OWNER_PREFIX = "owner-";

type AssetKind = "ctty" | "pi";

type AssetSpec = {
  kind: AssetKind;
  bytes: Uint8Array;
  fileName: string;
  mode: number;
};

/** @internal Deterministic seams for cache contention and execution-boundary tests. */
export type PackagedAssetDeps = {
  helperExitCode?: (path: string) => Promise<number>;
  lockTimeoutMs?: number;
  lockWaitMs?: number;
};

export type PreparedPtyRuntime = {
  implementation: PtyImplementation;
  createTerminal(options: StationTerminalSpawnOptions): StationTerminalProcess;
  dispose(): void;
};

/**
 * Materializes the compiled PTY helper once, verifies that its filesystem is
 * executable, and fixes the PTY selector for the lifetime of this process.
 */
export async function preparePackagedPtyRuntime(
  stateDir: string,
  cttyHelperAssetPath: string,
  deps: PackagedAssetDeps = {},
): Promise<PreparedPtyRuntime> {
  const implementation = resolvePtyImplementation(process.env.STATION_PTY_IMPL, "bun");
  if (implementation === "bridge") {
    throw new Error(
      "STATION_PTY_IMPL=bridge is unavailable in the compiled Station binary because the Node/node-pty bridge is source-only. Unset STATION_PTY_IMPL or set it to bun.",
    );
  }

  if (implementation === "bun-nocctty") {
    return {
      implementation,
      createTerminal: (options) => createLocalPtyTerminal(options, { implementation }),
      dispose: () => undefined,
    };
  }

  const bytes = await readEmbeddedAsset(cttyHelperAssetPath);
  const cttyDir = join(stateDir, "run", "assets", "ctty");
  await ensureAssetDirectories(stateDir, cttyDir);
  return withAssetLock(join(cttyDir, ".lifecycle.lock"), deps, async () => {
    // One lifecycle lock spans identities so pruning cannot race a new helper's first lease.
    const helperPath = await materializeAsset(
      stateDir,
      {
        kind: "ctty",
        bytes,
        fileName: "station-ctty-helper",
        mode: HELPER_MODE,
      },
      deps,
    );
    await probeCttyHelper(helperPath, deps.helperExitCode ?? spawnExitCode);
    const lease = await createHelperLease(helperPath);
    await pruneStaleHelpers(cttyDir, dirname(helperPath));

    return {
      implementation,
      createTerminal: (options) =>
        createLocalPtyTerminal(options, {
          implementation,
          cttyHelperPath: helperPath,
        }),
      dispose: lease.dispose,
    };
  });
}

/**
 * Extracts the bundled Pi extension to an immutable content-addressed path.
 * Pi may reload this path after launch, so A4 deliberately never prunes it.
 */
export async function preparePackagedPiExtension(
  stateDir: string,
  piExtensionAssetPath: string,
  deps: PackagedAssetDeps = {},
): Promise<string> {
  return materializeAsset(
    stateDir,
    {
      kind: "pi",
      bytes: await readEmbeddedAsset(piExtensionAssetPath),
      fileName: "station-pi-extension.mjs",
      mode: PI_MODE,
    },
    deps,
  );
}

async function readEmbeddedAsset(assetPath: string): Promise<Uint8Array> {
  return readFile(assetPath);
}

/** Atomic extraction keeps concurrent compiled processes from observing partial assets. */
async function materializeAsset(
  stateDir: string,
  spec: AssetSpec,
  deps: PackagedAssetDeps,
): Promise<string> {
  const hash = sha256(spec.bytes);
  const version = safePathComponent(stationBuildInfo().version);
  const identity =
    spec.kind === "ctty"
      ? `${version}-${process.platform}-${process.arch}-${hash}`
      : `${version}-${hash}`;
  const kindDir = join(stateDir, "run", "assets", spec.kind);
  const assetDir = join(kindDir, identity);
  const targetPath = join(assetDir, spec.fileName);
  const lockDir = `${assetDir}.lock`;

  await ensureAssetDirectories(stateDir, kindDir);
  await validateDirectoryIfPresent(assetDir);
  if (await isValidAsset(targetPath, spec)) {
    return targetPath;
  }

  await withAssetLock(lockDir, deps, async () => {
    await ensurePrivateDirectory(assetDir);
    if (await isValidAsset(targetPath, spec)) {
      return;
    }
    await rejectNonRegularTarget(targetPath);
    await writeAssetAtomically(targetPath, spec);
    if (!(await isValidAsset(targetPath, spec))) {
      throw new Error(`Packaged ${spec.kind} asset failed integrity verification at ${targetPath}.`);
    }
  });
  return targetPath;
}

async function ensureAssetDirectories(stateDir: string, kindDir: string): Promise<void> {
  await ensurePrivateDirectory(join(stateDir, "run"));
  await ensurePrivateDirectory(join(stateDir, "run", "assets"));
  await ensurePrivateDirectory(kindDir);
}

async function validateDirectoryIfPresent(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Packaged asset directory is not a regular directory: ${path}.`);
    }
    await chmod(path, DIRECTORY_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Packaged asset directory is not a regular directory: ${path}.`);
  }
  await chmod(path, DIRECTORY_MODE);
}

async function isValidAsset(path: string, spec: AssetSpec): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Refusing non-regular packaged asset path: ${path}.`);
  }
  if (stats.size !== spec.bytes.byteLength || (stats.mode & 0o777) !== spec.mode) {
    return false;
  }
  return sha256(await readFile(path)) === sha256(spec.bytes);
}

async function rejectNonRegularTarget(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Refusing non-regular packaged asset path: ${path}.`);
    }
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function writeAssetAtomically(targetPath: string, spec: AssetSpec): Promise<void> {
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", spec.mode);
    await handle.writeFile(spec.bytes);
    await handle.sync();
    await handle.chmod(spec.mode);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
  }
}

async function withAssetLock<T>(
  lockDir: string,
  deps: PackagedAssetDeps,
  action: () => Promise<T>,
): Promise<T> {
  const lockTimeoutMs = deps.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const lockWaitMs = deps.lockWaitMs ?? LOCK_WAIT_MS;
  const deadline = Date.now() + lockTimeoutMs;
  while (true) {
    try {
      await mkdir(lockDir, { mode: DIRECTORY_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      await validateDirectoryIfPresent(lockDir);
      if (!(await lockHasLiveOwner(lockDir))) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for packaged asset lock ${lockDir}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, lockWaitMs));
      continue;
    }

    await writeFile(join(lockDir, `${OWNER_PREFIX}${process.pid}`), "", {
      flag: "wx",
      mode: 0o600,
    });
    try {
      return await action();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  }
}

async function lockHasLiveOwner(lockDir: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(lockDir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  const owner = names.find((name) => name.startsWith(OWNER_PREFIX));
  if (owner === undefined) {
    // The lock owner writes its marker immediately after mkdir; let that short
    // creation window settle, but reclaim a process that died between the two.
    const stats = await lstat(lockDir).catch(() => undefined);
    return stats !== undefined && Date.now() - stats.mtimeMs < LOCK_TIMEOUT_MS;
  }
  const pid = Number(owner.slice(OWNER_PREFIX.length));
  return Number.isSafeInteger(pid) && pid > 0 && processIsAlive(pid);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function probeCttyHelper(
  path: string,
  helperExitCode: (path: string) => Promise<number>,
): Promise<void> {
  let exitCode: number;
  try {
    exitCode = await helperExitCode(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `The packaged controlling-terminal helper at ${path} cannot execute. Move [observer].state_dir to a filesystem mounted with execution enabled.`,
        { cause: error },
      );
    }
    throw new Error(`The packaged controlling-terminal helper at ${path} could not start.`, {
      cause: error,
    });
  }
  if (exitCode !== 64) {
    throw new Error(
      `The packaged controlling-terminal helper at ${path} failed its startup probe (expected exit 64, received ${exitCode}).`,
    );
  }
}

function spawnExitCode(command: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
}

async function createHelperLease(helperPath: string): Promise<{ dispose(): void }> {
  const leasesDir = join(dirname(helperPath), ".leases");
  await ensurePrivateDirectory(leasesDir);
  const leasePath = join(leasesDir, `${process.pid}-${randomUUID()}`);
  await writeFile(leasePath, "", { flag: "wx", mode: 0o600 });
  let disposed = false;
  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        rmSync(leasePath, { force: true });
      } catch {
        // A stale lease is safe: the next owner validates its PID before pruning.
      }
    },
  };
}

async function pruneStaleHelpers(cttyDir: string, currentDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(cttyDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.endsWith(".lock")) {
      continue;
    }
    const assetDir = join(cttyDir, entry.name);
    if (assetDir === currentDir || (await hasLiveLease(assetDir))) {
      continue;
    }
    await rm(assetDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function hasLiveLease(assetDir: string): Promise<boolean> {
  const leasesDir = join(assetDir, ".leases");
  let leases: string[];
  try {
    leases = await readdir(leasesDir);
  } catch {
    return false;
  }
  let live = false;
  for (const lease of leases) {
    const match = /^(\d+)-/.exec(lease);
    if (match === null || !processIsAlive(Number(match[1]))) {
      await rm(join(leasesDir, lease), { force: true }).catch(() => undefined);
    } else {
      live = true;
    }
  }
  return live;
}

function safePathComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._+-]/g, "_");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
