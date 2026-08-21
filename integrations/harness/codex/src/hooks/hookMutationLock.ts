import { randomUUID } from "node:crypto";
import { link, mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "@station/runtime";
import { CodexHookSetupError } from "./hookErrors.js";

type HeldLock = {
  release(): Promise<void>;
};

type FileIdentity = { dev: number | bigint; ino: number | bigint };

const lockStaleMs = 5 * 60 * 1_000;
const lockWaitMs = 10_000;
const retryMs = 25;
const lockAttempts = Math.ceil(lockWaitMs / retryMs);

/** Serializes the existing Codex writer across every resolved artifact it can mutate. */
export async function withCodexHookMutationLock<T>(
  artifactPaths: readonly string[],
  effect: () => Promise<T>,
): Promise<T> {
  const lockPaths = [...new Set(artifactPaths.map((path) => `${path}.station-hook.lock`))].sort();
  const held: HeldLock[] = [];
  try {
    for (const path of lockPaths) {
      held.push(await acquireLock(path));
    }
    return await effect();
  } finally {
    for (const lock of held.reverse()) {
      await lock.release().catch(() => undefined);
    }
  }
}

async function acquireLock(path: string): Promise<HeldLock> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt <= lockAttempts; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      const metadata = await handle.stat({ bigint: true });
      const identity: FileIdentity = { dev: metadata.dev, ino: metadata.ino };
      return {
        release: async () => {
          await handle.close();
          await unlinkIfIdentityMatches(path, identity);
        },
      };
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") {
        throw lockError(cause);
      }
      if (await lockIsStale(path)) {
        await unlinkIfIdentityMatches(path, await fileIdentity(path));
        continue;
      }
      if (attempt < lockAttempts) await delay(retryMs);
    }
  }
  throw lockError();
}

async function fileIdentity(path: string): Promise<FileIdentity | undefined> {
  const metadata = await stat(path, { bigint: true }).catch(() => undefined);
  return metadata === undefined ? undefined : { dev: metadata.dev, ino: metadata.ino };
}

async function unlinkIfIdentityMatches(
  path: string,
  expected: FileIdentity | undefined,
): Promise<void> {
  if (expected === undefined) return;
  const witnessPath = `${path}.witness.${randomUUID()}`;
  try {
    await link(path, witnessPath);
    const witness = await fileIdentity(witnessPath);
    const current = await fileIdentity(path);
    if (sameIdentity(witness, expected) && sameIdentity(current, expected)) {
      await unlink(path).catch(() => undefined);
    }
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause;
  } finally {
    await unlink(witnessPath).catch(() => undefined);
  }
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity): boolean {
  return left?.dev === right.dev && left.ino === right.ino;
}

async function lockIsStale(path: string): Promise<boolean> {
  const metadata = await stat(path).catch(() => undefined);
  return metadata === undefined || Date.now() - metadata.mtimeMs > lockStaleMs;
}

function delay(milliseconds: number): Promise<void> {
  return Effect.runPromise(Effect.sleep(`${milliseconds} millis`));
}

function errorCode(cause: unknown): string | undefined {
  return (cause as NodeJS.ErrnoException | null | undefined)?.code;
}

function lockError(cause?: unknown): CodexHookSetupError {
  return new CodexHookSetupError(
    "CODEX_HOOK_RECONCILIATION_LOCK_FAILED",
    "Codex hook reconciliation could not acquire its artifact lock.",
    cause === undefined ? {} : { cause },
  );
}
