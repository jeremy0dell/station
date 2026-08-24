import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SafeError } from "@station/contracts";
import { safeErrorFromUnknown } from "@station/runtime";
import { isSqliteBusyError, openSqlDatabase, type SqlDatabase } from "../sqlite/driver.js";
import type { ObserverReapExclusion } from "./observerReap.js";

const claimFileName = "observer.claim.sqlite";
const claimSidecarSuffixes = ["", "-journal", "-wal", "-shm"] as const;

export type ObserverBootClaimReleaseResult =
  | { status: "released" }
  | { status: "failed"; error: ObserverBootClaimError };

export type ObserverBootClaimError = Error & SafeError;

export type AcquiredObserverBootClaim = {
  status: "acquired";
  path: string;
  release(): ObserverBootClaimReleaseResult;
};

export type ObserverBootClaimResult =
  | AcquiredObserverBootClaim
  | { status: "contended"; path: string; error: ObserverBootClaimError }
  | { status: "failed"; path: string; error: ObserverBootClaimError };

type ObserverBootClaimDeps = {
  openDatabase?: (path: string) => SqlDatabase;
};

type ObserverBootClaimCleanupExclusionDeps = {
  acquire?: typeof acquireObserverBootClaim;
};

export function observerBootClaimPath(socketPath: string): string {
  return join(dirname(socketPath), claimFileName);
}

/**
 * ADAPTER
 *
 * Excludes cross-runtime startup, stale-evidence repair, and explicit reap
 * mutation through a SQLite transaction whose ownership comes from the OS
 * lock, never the persistent claim file.
 */
export async function acquireObserverBootClaim(
  options: { socketPath: string; timeoutMs: number },
  deps: ObserverBootClaimDeps = {},
): Promise<ObserverBootClaimResult> {
  const path = observerBootClaimPath(options.socketPath);
  if (isReservedClaimSocketPath(options.socketPath)) {
    return failedClaim(
      path,
      new Error("Observer socket path collides with the reserved boot claim database."),
    );
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    return failedClaim(path, new Error("Observer boot claim timeout must be a positive integer."));
  }

  try {
    await prepareClaimFiles(path);
  } catch (error) {
    return failedClaim(path, error);
  }

  let database: SqlDatabase | undefined;
  try {
    // process.umask is process-global, so keep its private override inside one
    // synchronous block where no other JavaScript work can interleave.
    withPrivateSqliteUmask(() => {
      database = (deps.openDatabase ?? openSqlDatabase)(path);
      const busyTimeoutPragma = ["PRAGMA busy_timeout = ", String(options.timeoutMs)].join("");
      database.exec(busyTimeoutPragma);
      database.exec("BEGIN IMMEDIATE");
    });
  } catch (error) {
    const closeError = closeAfterFailedAcquire(database);
    if (closeError !== undefined) {
      return failedClaim(
        path,
        new AggregateError([error, closeError], "Observer boot claim database cleanup failed."),
      );
    }
    if (isSqliteBusyError(error)) {
      return {
        status: "contended",
        path,
        error: observerBootClaimError(error, {
          code: "OBSERVER_BOOT_CLAIM_CONTENDED",
          message: "Observer boot ownership remained contended for the startup budget.",
        }),
      };
    }
    return failedClaim(path, error);
  }

  if (database === undefined) {
    return failedClaim(path, new Error("Observer boot claim database did not open."));
  }

  const release = createRelease(database);
  try {
    await requirePrivateClaimFiles(path);
  } catch (error) {
    const releaseResult = release();
    return failedClaim(
      path,
      releaseResult.status === "failed"
        ? new AggregateError(
            [error, releaseResult.error],
            "Observer boot claim validation and cleanup failed.",
          )
        : error,
    );
  }

  return { status: "acquired", path, release };
}

/**
 * ADAPTER
 *
 * Gives explicit reap a fail-fast startup exclusion and releases the claim
 * after every callback outcome, including failures.
 */
export function createObserverReapExclusion(
  options: { socketPath: string },
  deps: ObserverBootClaimCleanupExclusionDeps = {},
): ObserverReapExclusion {
  return {
    runExclusive: async <T>(operation: () => Promise<T>) => {
      const claim = await (deps.acquire ?? acquireObserverBootClaim)({
        socketPath: options.socketPath,
        timeoutMs: 1,
      });
      if (claim.status === "contended") return { status: "busy" };
      if (claim.status === "failed") {
        return { status: "failed", reason: claim.error.message };
      }

      let value: T;
      try {
        value = await operation();
      } catch {
        const release = claim.release();
        return {
          status: "failed",
          reason:
            release.status === "released"
              ? "Duplicate cleanup failed while holding the boot claim."
              : "Duplicate cleanup and boot claim release both failed.",
        };
      }
      const release = claim.release();
      return {
        status: "completed",
        value,
        released: release.status === "released",
      };
    },
  };
}

function isReservedClaimSocketPath(socketPath: string): boolean {
  const socketName = basename(socketPath).toLowerCase();
  return claimSidecarSuffixes.some((suffix) => socketName === `${claimFileName}${suffix}`);
}

async function prepareClaimFiles(path: string): Promise<void> {
  const directory = dirname(path);
  const createdDirectory = await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryHandle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await directoryHandle.stat();
    if (!metadata.isDirectory()) throw new Error("Observer socket directory is not a directory.");
    if (createdDirectory !== undefined) await directoryHandle.chmod(0o700);
    if ((metadata.mode & 0o777) !== 0o700) {
      throw new Error("Observer socket directory must have mode 0700.");
    }
  } finally {
    await directoryHandle.close();
  }

  let missing = false;
  try {
    await requirePrivateRegularFile(path, true, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    missing = true;
  }
  if (missing) await createInitializedClaimDatabase(path);

  await requirePrivateClaimFiles(path);
}

async function createInitializedClaimDatabase(path: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${claimFileName}.${randomUUID()}.tmp`);
  let temporary: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporary = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await temporary.chmod(0o600);
    await temporary.close();
    temporary = undefined;

    let database: SqlDatabase | undefined;
    try {
      database = withPrivateSqliteUmask(() => openSqlDatabase(temporaryPath));
      database.exec("PRAGMA user_version = 1");
    } finally {
      const openedDatabase = database;
      if (openedDatabase !== undefined) withPrivateSqliteUmask(() => openedDatabase.close());
    }
    await requirePrivateRegularFile(temporaryPath, true, true);

    try {
      await link(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await temporary?.close();
    for (const suffix of claimSidecarSuffixes) {
      await unlink(`${temporaryPath}${suffix}`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

async function requirePrivateClaimFiles(path: string): Promise<void> {
  await Promise.all(
    claimSidecarSuffixes.map((suffix) =>
      requirePrivateRegularFile(`${path}${suffix}`, suffix === "", suffix === ""),
    ),
  );
}

async function requirePrivateRegularFile(
  path: string,
  required: boolean,
  nonEmpty = false,
): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    // lstat avoids reopening the claim inode, which would release this process's POSIX lock.
    metadata = await lstat(path);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!metadata.isFile()) {
    throw new Error(`Observer boot claim path must be a regular non-symlink file: ${path}`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`Observer boot claim file must have mode 0600: ${path}`);
  }
  if (nonEmpty && metadata.size === 0) {
    throw new Error(`Observer boot claim database must be initialized: ${path}`);
  }
}

function createRelease(database: SqlDatabase): () => ObserverBootClaimReleaseResult {
  let result: ObserverBootClaimReleaseResult | undefined;
  return () => {
    if (result !== undefined) {
      return result;
    }

    const errors: unknown[] = [];
    try {
      withPrivateSqliteUmask(() => {
        try {
          database.exec("ROLLBACK");
        } catch (error) {
          errors.push(error);
        }
        try {
          database.close();
        } catch (error) {
          errors.push(error);
        }
      });
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 0) {
      result = { status: "released" };
    } else {
      result = {
        status: "failed",
        error: observerBootClaimError(
          new AggregateError(errors, "Observer boot claim release failed."),
          {
            code: "OBSERVER_BOOT_CLAIM_RELEASE_FAILED",
            message: "Observer boot ownership could not be released cleanly.",
          },
        ),
      };
    }
    return result;
  };
}

function closeAfterFailedAcquire(database: SqlDatabase | undefined): unknown | undefined {
  if (database === undefined) {
    return undefined;
  }
  try {
    withPrivateSqliteUmask(() => database.close());
    return undefined;
  } catch (error) {
    return error;
  }
}

function withPrivateSqliteUmask<T>(operation: () => T): T {
  const previous = process.umask(0o077);
  try {
    return operation();
  } finally {
    process.umask(previous);
  }
}

function failedClaim(path: string, error: unknown): ObserverBootClaimResult {
  return {
    status: "failed",
    path,
    error: observerBootClaimError(error, {
      code: "OBSERVER_BOOT_CLAIM_FAILED",
      message: "Observer boot ownership could not be acquired.",
    }),
  };
}

function observerBootClaimError(
  cause: unknown,
  fallback: { code: string; message: string },
): ObserverBootClaimError {
  const safeError = safeErrorFromUnknown(cause, {
    tag: "ObserverBootClaimError",
    code: fallback.code,
    message: fallback.message,
  }) as SafeError;
  return Object.assign(new Error(safeError.message, { cause }), safeError);
}
