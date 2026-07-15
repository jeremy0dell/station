import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gitLocalEnvironmentVariables, runExternalCommand } from "@station/runtime";
import { resolveConfigPath } from "../load/paths.js";
import { isProjectSafeError, projectConfigSafeError } from "./errors.js";

export type DetectedGitDefaultBranch = {
  defaultBranch: string;
  worktrunkBase: string;
};

type RemoteHeadInspection =
  | { status: "valid"; value: DetectedGitDefaultBranch }
  | { status: "absent" | "malformed" };

export async function findGitRoot(startPath: string): Promise<string | undefined> {
  let current = resolve(startPath);
  for (;;) {
    if (await hasGitMarker(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export async function resolveExistingDirectory(
  inputPath: string,
  homeDir: string,
): Promise<string> {
  const resolvedPath = resolveConfigPath(inputPath, homeDir, process.cwd());
  try {
    const rootStat = await stat(resolvedPath);
    if (!rootStat.isDirectory()) {
      throw projectConfigSafeError({
        code: "PROJECT_ROOT_INVALID",
        message: "Selected project path is not a directory.",
      });
    }
  } catch (cause) {
    if (isProjectSafeError(cause)) {
      throw cause;
    }
    throw projectConfigSafeError({
      code: "PROJECT_ROOT_INVALID",
      message: "Selected project path is not an existing directory.",
      hint: resolvedPath,
    });
  }
  return resolvedPath;
}

/** Resolves only committed, unambiguous Git evidence suitable for project defaults. */
export async function detectGitDefaultBranch(
  root: string,
): Promise<DetectedGitDefaultBranch | undefined> {
  const remotes = await gitLines(root, ["remote"]);
  if (remotes === undefined) {
    return undefined;
  }

  if (remotes.includes("origin")) {
    const origin = await inspectRemoteHead(root, "origin");
    if (origin.status === "valid") {
      return origin.value;
    }
    if (origin.status === "malformed") {
      return undefined;
    }
  }

  const otherRemotes = remotes.filter((remote) => remote !== "origin");
  // Refuse ambiguous configured remotes before probing so command count stays bounded.
  if (otherRemotes.length > 1) {
    return undefined;
  }
  if (otherRemotes[0] !== undefined) {
    const other = await inspectRemoteHead(root, otherRemotes[0]);
    if (other.status === "valid") {
      return other.value;
    }
    if (other.status === "malformed") {
      return undefined;
    }
  }

  const localBranches = await gitLines(root, [
    "for-each-ref",
    "--format=%(refname)%09%(objecttype)",
    "refs/heads",
  ]);
  if (localBranches?.length !== 1) {
    return undefined;
  }
  const [ref, objectType] = (localBranches[0] ?? "").split("\t");
  const prefix = "refs/heads/";
  if (objectType !== "commit" || ref === undefined || !ref.startsWith(prefix)) {
    return undefined;
  }
  const branch = ref.slice(prefix.length);
  if (branch.length === 0) {
    return undefined;
  }
  return { defaultBranch: branch, worktrunkBase: branch };
}

async function inspectRemoteHead(root: string, remote: string): Promise<RemoteHeadInspection> {
  const headRef = `refs/remotes/${remote}/HEAD`;
  const symbolic = await gitResult(root, ["symbolic-ref", "--quiet", headRef], [0, 1]);
  if (symbolic === undefined) {
    return { status: "malformed" };
  }
  if (symbolic.exitCode === 0) {
    const value = await resolveRemoteTarget(root, headRef, symbolic.stdout.trim());
    return value === undefined ? { status: "malformed" } : { status: "valid", value };
  }

  const direct = await gitResult(root, ["rev-parse", "--verify", "--quiet", headRef], [0, 1]);
  if (direct === undefined || direct.exitCode === 0) {
    return { status: "malformed" };
  }
  return { status: "absent" };
}

async function resolveRemoteTarget(
  root: string,
  headRef: string,
  target: string,
): Promise<DetectedGitDefaultBranch | undefined> {
  const remotePrefix = headRef.slice(0, -"HEAD".length);
  if (!target.startsWith(remotePrefix)) {
    return undefined;
  }
  const branch = target.slice(remotePrefix.length);
  if (branch.length === 0) {
    return undefined;
  }
  const commit = await gitOutput(root, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`]);
  if (commit === undefined || commit.length === 0) {
    return undefined;
  }
  return {
    defaultBranch: branch,
    worktrunkBase: target.slice("refs/remotes/".length),
  };
}

async function gitLines(root: string, args: string[]): Promise<string[] | undefined> {
  const output = await gitOutput(root, args);
  return output === undefined || output.length === 0 ? [] : output.split(/\r?\n/);
}

async function gitOutput(root: string, args: string[]): Promise<string | undefined> {
  const result = await gitResult(root, args);
  return result?.stdout.trim();
}

async function gitResult(root: string, args: string[], allowedExitCodes?: number[]) {
  try {
    return await runExternalCommand({
      command: "git",
      args,
      cwd: root,
      unsetEnv: gitLocalEnvironmentVariables,
      timeoutMs: 5_000,
      ...(allowedExitCodes === undefined ? {} : { allowedExitCodes }),
    });
  } catch {
    return undefined;
  }
}

async function hasGitMarker(directory: string): Promise<boolean> {
  const marker = join(directory, ".git");
  try {
    const markerStat = await stat(marker);
    return markerStat.isDirectory() || markerStat.isFile();
  } catch {
    return false;
  }
}
