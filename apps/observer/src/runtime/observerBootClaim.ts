import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SafeError } from "@station/contracts";
import { safeErrorFromUnknown } from "@station/runtime";
import { isSqliteBusyError, openSqlDatabase, type SqlDatabase } from "../sqlite/driver.js";

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

export function observerBootClaimPath(socketPath: string): string {
  return join(dirname(socketPath), claimFileName);
}

/**
 * ADAPTER
 *
 * Excludes cross-runtime socket boot mutation through a SQLite transaction
 * whose ownership comes from the OS lock, never the persistent claim file.
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
      database.exec(`PRAGMA busy_timeout = ${options.timeoutMs}`);
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

function isReservedClaimSocketPath(socketPath: string): boolean {
  const socketName = basename(socketPath).toLowerCase();
  return claimSidecarSuffixes.some((suffix) => socketName === `${claimFileName}${suffix}`);
}

async function prepareClaimFiles(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  // The database persists across boots; existence only prepares the SQLite
  // representation and never proves transaction ownership.
  let created: Awaited<ReturnType<typeof open>> | undefined;
  try {
    created = await open(path, "wx", 0o600);
    await created.chmod(0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  } finally {
    await created?.close();
  }

  await requirePrivateClaimFiles(path);
}

async function requirePrivateClaimFiles(path: string): Promise<void> {
  await Promise.all(
    claimSidecarSuffixes.map((suffix) =>
      requirePrivateRegularFile(`${path}${suffix}`, suffix === ""),
    ),
  );
}

async function requirePrivateRegularFile(path: string, required: boolean): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Observer boot claim path must be a regular non-symlink file: ${path}`);
  }
  await chmod(path, 0o600);
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

    result =
      errors.length === 0
        ? { status: "released" }
        : {
            status: "failed",
            error: observerBootClaimError(
              new AggregateError(errors, "Observer boot claim release failed."),
              {
                code: "OBSERVER_BOOT_CLAIM_RELEASE_FAILED",
                message: "Observer boot ownership could not be released cleanly.",
              },
            ),
          };
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
