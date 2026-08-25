import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CreateWorktreeRequest, WorktreeObservation } from "@station/contracts";
import { sameObservedPath, WorktreeObservationSchema } from "@station/contracts";
import {
  type ExternalCommandInput,
  type ExternalCommandRunner,
  gitLocalEnvironmentVariables,
  type RuntimeClock,
  runExternalCommand,
  runRuntimeBoundaryWithRetryAndTimeout,
  safeErrorFromUnknown,
  toIsoTimestamp,
} from "@station/runtime";
import { z } from "zod";
import { worktrunkCommandFailure } from "./commandFailure.js";
import { worktrunkInstallHint } from "./dependency.js";
import { WorktrunkProviderError } from "./errors.js";
import { worktreeId } from "./worktreeIdentity.js";

const NativeCreateVerificationSchema = z.tuple([z.string().min(1), z.string().min(1)]);

export type NativeCreateOptions = {
  clock: RuntimeClock;
  resolveRegistrationIdentity: (worktreePath: string) => Promise<string | undefined>;
  runner?: ExternalCommandRunner;
  timeoutMs: number;
};

/**
 * Creates one hooks-disabled managed worktree and verifies its exact Git path,
 * branch, and native registration before returning provider-authoritative evidence.
 */
export async function createNativeWorktree(
  request: CreateWorktreeRequest,
  targetPath: string,
  base: string,
  options: NativeCreateOptions,
): Promise<WorktreeObservation> {
  try {
    await mkdir(dirname(targetPath), { recursive: true });
  } catch (cause) {
    throw new WorktrunkProviderError(
      "WORKTRUNK_COMMAND_FAILED",
      "Station could not prepare the managed worktree directory.",
      {
        cause: safeErrorFromUnknown(cause, {
          tag: "WorktreeProviderError",
          code: "WORKTRUNK_COMMAND_FAILED",
          message: "Station could not prepare the managed worktree directory.",
          provider: "worktrunk",
        }),
      },
    );
  }

  await runGit(
    [
      "-C",
      request.project.root,
      "worktree",
      "add",
      "--quiet",
      "-b",
      request.branch,
      targetPath,
      base,
    ],
    request.project.root,
    "provider.worktrunk.native-create",
    "Git failed to create the managed worktree.",
    options,
    base,
  );

  const verification = await runGit(
    [
      "-C",
      targetPath,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--abbrev-ref=strict",
      "HEAD",
    ],
    targetPath,
    "provider.worktrunk.native-create-verify",
    "Git failed to verify the created worktree.",
    options,
  );
  const parsed = NativeCreateVerificationSchema.safeParse(
    verification.stdout.trimEnd().split("\n"),
  );
  if (
    !parsed.success ||
    !sameObservedPath(parsed.data[0], targetPath) ||
    parsed.data[1] !== request.branch
  ) {
    throw new WorktrunkProviderError(
      "WORKTRUNK_WORKTREE_CHANGED",
      "Git created the worktree but Station could not verify its exact path and branch.",
      {
        hint: "Inspect the created worktree and refresh before trying to manage it in Station.",
        ...(!parsed.success ? { cause: parsed.error } : {}),
      },
    );
  }

  const registrationIdentity = await options.resolveRegistrationIdentity(targetPath);
  if (registrationIdentity === undefined) {
    throw new WorktrunkProviderError(
      "WORKTRUNK_WORKTREE_CHANGED",
      "Git created the worktree but Station could not verify its Git registration.",
      {
        hint: "Inspect the created worktree and refresh before trying to manage it in Station.",
      },
    );
  }

  return WorktreeObservationSchema.parse({
    id: worktreeId(request.project.id, targetPath),
    provider: "worktrunk",
    projectId: request.project.id,
    branch: request.branch,
    path: targetPath,
    registrationIdentity,
    state: "exists",
    source: "station",
    isPrimaryCheckout: false,
    confidence: "high",
    reason: "Station created and verified this worktree with native Git.",
    observedAt: toIsoTimestamp(options.clock.now()),
  });
}

async function runGit(
  args: string[],
  cwd: string,
  operation: string,
  message: string,
  options: NativeCreateOptions,
  unresolvedBase?: string,
) {
  const result = await runRuntimeBoundaryWithRetryAndTimeout(
    {
      operation,
      clock: options.clock,
      timeoutMs: options.timeoutMs,
      error: {
        tag: "WorktreeProviderError",
        code: "WORKTRUNK_COMMAND_FAILED",
        message,
        provider: "worktrunk",
      },
      timeoutError: {
        tag: "TimeoutError",
        code: "WORKTRUNK_TIMEOUT",
        message: "Git worktree creation timed out.",
        provider: "worktrunk",
      },
      retry: { retries: 0 },
    },
    ({ signal }) => {
      const input: ExternalCommandInput = {
        command: "git",
        args,
        cwd,
        unsetEnv: gitLocalEnvironmentVariables,
        signal,
        maxOutputChars: 64 * 1024,
      };
      return options.runner === undefined
        ? runExternalCommand(input)
        : runExternalCommand(input, options.runner);
    },
  );
  if (result.ok) return result.value;

  throw worktrunkCommandFailure({
    error: result.error,
    provider: "worktrunk",
    operation,
    command: "git",
    args,
    cwd,
    durationMs: result.timing.durationMs,
    fallback: {
      code: "WORKTRUNK_COMMAND_FAILED",
      message,
      ...(unresolvedBase === undefined ? {} : { unresolvedBase }),
    },
    installHint: worktrunkInstallHint("git"),
  });
}
