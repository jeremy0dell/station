import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { type ExternalCommandRunner, runExternalCommand } from "./externalCommand.js";

export const gitLocalEnvironmentVariables = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
] as const;

export function environmentWithoutGitLocals(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of gitLocalEnvironmentVariables) delete sanitized[key];
  return sanitized;
}

export type GitCheckoutBareProbeOptions = {
  runner?: ExternalCommandRunner;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export function gitCheckoutBareRepairHint(root: string): string {
  const quotedRoot = `'${root.replaceAll("'", `'\\''`)}'`;
  return `Inspect with git -C ${quotedRoot} config --show-origin --get core.bare. If this is the intended checkout, run git -C ${quotedRoot} config --local core.bare false; otherwise correct projects.root.`;
}

/**
 * Read-only check for checkout roots whose local Git config marks them bare.
 * Bare repositories, missing checkout markers, and inconclusive probes return false.
 */
export async function isGitCheckoutConfiguredBare(
  root: string,
  options: GitCheckoutBareProbeOptions = {},
): Promise<boolean> {
  try {
    const marker = await lstat(join(root, ".git"));
    if (!marker.isDirectory() && !marker.isFile()) {
      return false;
    }

    const result = await runExternalCommand(
      {
        command: "git",
        args: ["-C", root, "config", "--local", "--type=bool", "--get", "core.bare"],
        unsetEnv: gitLocalEnvironmentVariables,
        allowedExitCodes: [0, 1],
        timeoutMs: options.timeoutMs ?? 5_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      options.runner,
    );
    return result.exitCode === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}
