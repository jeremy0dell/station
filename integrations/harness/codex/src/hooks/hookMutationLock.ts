import { constants } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { CodexHookSetupError, type CodexHookSetupErrorInstance } from "./hookErrors.js";
import {
  type CodexHookLockDatabase,
  type CodexHookLockDatabaseOpener,
  isCodexHookLockBusy,
  openCodexHookLockDatabase,
} from "./hookMutationLockSqlite.js";

type HeldLock = {
  release(): void;
};

type LockFileIdentity = {
  dev: number;
  ino: number;
};

type OpenLockFile = {
  handle: FileHandle;
  identity: LockFileIdentity;
};

type LockOutcome<T> = { status: "succeeded"; value: T } | { status: "failed"; cause: unknown };

type LockFailure = { cause: unknown };

export type CodexHookMutationLockContext = {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Absolute monotonic deadline expressed in `performance.now()` milliseconds. */
  deadlineMs?: number;
};

const lockWaitMs = 10_000;
const retryMs = 25;
const openLockFileFlags = constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW;
const inspectLockFileFlags = constants.O_RDWR | constants.O_NOFOLLOW;

/** Serializes the existing Codex writer across every resolved artifact it can mutate. */
export function withCodexHookMutationLock<T>(
  artifactPaths: readonly string[],
  effect: () => Promise<T>,
  context: CodexHookMutationLockContext = {},
): Promise<T> {
  return withCodexHookMutationLockForTest(
    artifactPaths,
    effect,
    openCodexHookLockDatabase,
    context,
  );
}

/** Test seam for deterministic SQLite driver cleanup failures. */
export async function withCodexHookMutationLockForTest<T>(
  artifactPaths: readonly string[],
  effect: () => Promise<T>,
  openDatabase: CodexHookLockDatabaseOpener,
  context: CodexHookMutationLockContext = {},
): Promise<T> {
  const lockPaths = [
    ...new Set(artifactPaths.map((path) => `${path}.station-hook.lock.sqlite`)),
  ].sort();
  const deadlineMs =
    context.deadlineMs ?? performance.now() + Math.max(0, context.timeoutMs ?? lockWaitMs);
  const held: HeldLock[] = [];
  const outcome: LockOutcome<T> = await (async () => {
    try {
      for (const path of lockPaths) {
        held.push(await acquireLock(path, deadlineMs, context.signal, openDatabase));
      }
      throwIfAborted(context.signal);
      return { status: "succeeded", value: await effect() };
    } catch (cause) {
      return { status: "failed", cause };
    }
  })();
  const releaseFailure = releaseLocks(held);

  if (outcome.status === "failed") {
    throw outcome.cause;
  }
  if (releaseFailure !== undefined) {
    throw lockReleaseError(releaseFailure.cause);
  }
  return outcome.value;
}

async function acquireLock(
  path: string,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  openDatabase: CodexHookLockDatabaseOpener,
): Promise<HeldLock> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  throwIfAborted(signal);

  let database: CodexHookLockDatabase;
  try {
    database = await openValidatedLockDatabase(path, openDatabase);
  } catch (cause) {
    throw lockError(cause);
  }

  try {
    while (true) {
      throwIfAborted(signal);
      if (performance.now() >= deadlineMs) {
        throw lockTimeoutError();
      }
      try {
        database.exec("BEGIN IMMEDIATE");
        return heldDatabaseLock(database);
      } catch (cause) {
        if (!isCodexHookLockBusy(cause)) {
          throw lockError(cause);
        }
      }

      const remainingMs = deadlineMs - performance.now();
      if (remainingMs <= 0) {
        throw lockTimeoutError();
      }
      await delay(Math.min(retryMs, remainingMs), signal);
    }
  } catch (cause) {
    try {
      database.close();
    } catch {
      // Preserve cancellation, timeout, or the acquisition failure.
    }
    throw cause;
  }
}

async function openValidatedLockDatabase(
  path: string,
  openDatabase: CodexHookLockDatabaseOpener,
): Promise<CodexHookLockDatabase> {
  const lockFile = await openPreparedLockFile(path);
  let database: CodexHookLockDatabase | undefined;
  try {
    database = await openDatabase(path);
    await verifyCurrentLockFile(path, lockFile.identity);
    await lockFile.handle.close();
    return database;
  } catch (cause) {
    try {
      await lockFile.handle.close();
    } catch {
      // Preserve the validation or database-open failure.
    }
    try {
      database?.close();
    } catch {
      // Preserve the validation or database-open failure.
    }
    throw cause;
  }
}

async function openPreparedLockFile(path: string): Promise<OpenLockFile> {
  const handle = await open(path, openLockFileFlags, 0o600);
  try {
    const initial = await handle.stat();
    assertRegularLockFile(initial.isFile());
    await handle.chmod(0o600);
    const secured = await handle.stat();
    assertRegularLockFile(secured.isFile());
    assertRestrictedLockFileMode(secured.mode);
    return {
      handle,
      identity: { dev: secured.dev, ino: secured.ino },
    };
  } catch (cause) {
    try {
      await handle.close();
    } catch {
      // Preserve the unsafe-path or permission failure.
    }
    throw cause;
  }
}

async function verifyCurrentLockFile(path: string, expected: LockFileIdentity): Promise<void> {
  const handle = await open(path, inspectLockFileFlags);
  try {
    const current = await handle.stat();
    assertRegularLockFile(current.isFile());
    assertRestrictedLockFileMode(current.mode);
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new Error("Codex hook lock database path changed during acquisition.");
    }
  } catch (cause) {
    try {
      await handle.close();
    } catch {
      // Preserve the unsafe-path or identity failure.
    }
    throw cause;
  }
  await handle.close();
}

function assertRegularLockFile(isRegular: boolean): void {
  if (!isRegular) {
    throw new Error("Codex hook lock database path is not a regular file.");
  }
}

function assertRestrictedLockFileMode(mode: number): void {
  if ((mode & 0o7777) !== 0o600) {
    throw new Error("Codex hook lock database permissions are not 0600.");
  }
}

function heldDatabaseLock(database: CodexHookLockDatabase): HeldLock {
  return {
    release: () => {
      const failures: unknown[] = [];
      try {
        database.exec("ROLLBACK");
      } catch (cause) {
        failures.push(cause);
      }
      try {
        database.close();
      } catch (cause) {
        failures.push(cause);
      }
      throwCollectedFailures(failures, "Codex hook lock rollback and close both failed.");
    },
  };
}

function releaseLocks(held: readonly HeldLock[]): LockFailure | undefined {
  const failures: unknown[] = [];
  for (const lock of [...held].reverse()) {
    try {
      lock.release();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length === 0) return undefined;
  return {
    cause:
      failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "Multiple Codex hook artifact locks failed to release."),
  };
}

function throwCollectedFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, message);
  }
}

function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancellationReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw cancellationReason(signal);
  }
}

function cancellationReason(signal: AbortSignal | undefined): unknown {
  return (
    signal?.reason ??
    new CodexHookSetupError(
      "CODEX_HOOK_RECONCILIATION_CANCELLED",
      "Codex hook reconciliation was cancelled while waiting for its artifact lock.",
    )
  );
}

function lockError(cause: unknown): CodexHookSetupErrorInstance {
  return new CodexHookSetupError(
    "CODEX_HOOK_RECONCILIATION_LOCK_FAILED",
    "Codex hook reconciliation could not acquire its artifact lock.",
    { cause },
  );
}

function lockTimeoutError(): CodexHookSetupErrorInstance {
  return new CodexHookSetupError(
    "CODEX_HOOK_RECONCILIATION_TIMEOUT",
    "Codex hook reconciliation timed out waiting for its artifact lock.",
  );
}

function lockReleaseError(cause: unknown): CodexHookSetupErrorInstance {
  return new CodexHookSetupError(
    "CODEX_HOOK_RECONCILIATION_LOCK_RELEASE_FAILED",
    "Codex hook reconciliation could not release its artifact lock.",
    { cause },
  );
}
