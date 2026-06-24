import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorktreeObservation } from "@station/contracts";
import type { RealStationConfigFixture } from "./config";
import type { RealE2eEnvironment } from "./env";
import { requireToolPath } from "./env";
import type { RealTempRepo } from "./repo";

const execFileAsync = promisify(execFile);

export async function runWorktrunkJson<T = unknown>(input: {
  env: RealE2eEnvironment;
  config: RealStationConfigFixture;
  repo: RealTempRepo;
  args: string[];
  envVars?: Record<string, string>;
  timeoutMs?: number;
}): Promise<T> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (input.envVars !== undefined) {
    for (const [key, value] of Object.entries(input.envVars)) {
      childEnv[key] = value;
    }
  }
  const output = await execFileAsync(
    requireToolPath(input.env, "worktrunk"),
    ["--config", input.config.worktrunkConfigPath, ...input.args],
    {
      cwd: input.repo.repoPath,
      env: childEnv,
      timeout: input.timeoutMs ?? 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(output.stdout) as T;
}

export async function listRealWorktrunkWorktrees(input: {
  env: RealE2eEnvironment;
  config: RealStationConfigFixture;
  repo: RealTempRepo;
}): Promise<unknown> {
  return runWorktrunkJson({
    ...input,
    args: ["list", "--format=json"],
  });
}

export async function createRealWorktrunkWorktree(input: {
  env: RealE2eEnvironment;
  config: RealStationConfigFixture;
  repo: RealTempRepo;
  branch: string;
}): Promise<unknown> {
  return runWorktrunkJson({
    env: input.env,
    config: input.config,
    repo: input.repo,
    args: [
      "switch",
      "--create",
      input.branch,
      "--base",
      input.repo.baseBranch,
      "--no-cd",
      "--format=json",
    ],
    envVars: {
      WORKTRUNK_WORKTREE_PATH: join(
        input.repo.repoPath,
        ".station-real-e2e",
        "worktrees",
        "{{ branch | sanitize }}",
      ),
    },
    timeoutMs: 60_000,
  });
}

export async function removeRealWorktrunkWorktree(input: {
  env: RealE2eEnvironment;
  config: RealStationConfigFixture;
  repo: RealTempRepo;
  branch: string | readonly string[];
}): Promise<void> {
  const branches = typeof input.branch === "string" ? [input.branch] : input.branch;
  for (const branch of branches) {
    await execFileAsync(
      requireToolPath(input.env, "worktrunk"),
      [
        "--config",
        input.config.worktrunkConfigPath,
        "remove",
        branch,
        "--force",
        "--force-delete",
        "--foreground",
        "--format=json",
      ],
      {
        cwd: input.repo.repoPath,
        timeout: 60_000,
      },
    ).catch(() => undefined);
  }
}

export function findWorktrunkObservation(
  value: unknown,
  branch: string,
): WorktreeObservation | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.find((item): item is WorktreeObservation => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    return "branch" in item && item.branch === branch;
  });
}
