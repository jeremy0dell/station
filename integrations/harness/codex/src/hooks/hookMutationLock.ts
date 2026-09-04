import {
  type ProviderHookLockDatabaseOpener,
  type ProviderHookMutationLockContext,
  type ProviderHookMutationLockErrorKind,
  withProviderHookMutationLock,
  withProviderHookMutationLockForTest,
} from "@station/runtime";
import { CodexHookSetupError } from "./hookErrors.js";

export type CodexHookLockDatabase = Awaited<ReturnType<ProviderHookLockDatabaseOpener>>;

/** Serializes the Codex writer across every resolved artifact it can mutate. */
export function withCodexHookMutationLock<T>(
  artifactPaths: readonly string[],
  effect: () => Promise<T>,
  context: ProviderHookMutationLockContext = {},
): Promise<T> {
  return withProviderHookMutationLock(artifactPaths, effect, context, codexLockError);
}

/** Test seam for deterministic SQLite driver cleanup failures. */
export function withCodexHookMutationLockForTest<T>(
  artifactPaths: readonly string[],
  effect: () => Promise<T>,
  openDatabase: ProviderHookLockDatabaseOpener,
  context: ProviderHookMutationLockContext = {},
): Promise<T> {
  return withProviderHookMutationLockForTest(
    artifactPaths,
    effect,
    openDatabase,
    context,
    codexLockError,
  );
}

function codexLockError(
  kind: ProviderHookMutationLockErrorKind,
  cause?: unknown,
): CodexHookSetupError {
  const details = {
    cancelled: {
      code: "CODEX_HOOK_RECONCILIATION_CANCELLED",
      message: "Codex hook reconciliation was cancelled while waiting for its artifact lock.",
    },
    "lock-failed": {
      code: "CODEX_HOOK_RECONCILIATION_LOCK_FAILED",
      message: "Codex hook reconciliation could not acquire its artifact lock.",
    },
    timeout: {
      code: "CODEX_HOOK_RECONCILIATION_TIMEOUT",
      message: "Codex hook reconciliation timed out waiting for its artifact lock.",
    },
    "release-failed": {
      code: "CODEX_HOOK_RECONCILIATION_LOCK_RELEASE_FAILED",
      message: "Codex hook reconciliation could not release its artifact lock.",
    },
  } as const;
  const detail = details[kind];
  return new CodexHookSetupError(detail.code, detail.message, { cause });
}
