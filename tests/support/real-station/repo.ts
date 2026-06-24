import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RealE2eEnvironment } from "./env";

const execFileAsync = promisify(execFile);

export type RealTempRepo = {
  root: string;
  repoPath: string;
  realE2eDir: string;
  baseBranch: string;
  cleanup(): Promise<void>;
};

export async function createRealTempRepo(env: RealE2eEnvironment): Promise<RealTempRepo> {
  const root = await mkdtemp(join(tmpdir(), "station-real-e2e-"));
  const repoPath = join(root, "repo");
  const realE2eDir = join(repoPath, ".station-real-e2e");

  await execFileAsync(
    "git",
    ["clone", "--quiet", "--local", "--no-hardlinks", env.repoRoot, repoPath],
    {
      timeout: 60_000,
    },
  );
  await execFileAsync("git", ["config", "user.email", "station@example.invalid"], {
    cwd: repoPath,
    timeout: 10_000,
  });
  await execFileAsync("git", ["config", "user.name", "station real E2E"], {
    cwd: repoPath,
    timeout: 10_000,
  });
  await mkdir(realE2eDir, { recursive: true });

  const baseBranchOutput = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoPath,
    timeout: 10_000,
  });
  const baseBranch = baseBranchOutput.stdout.trim() || "HEAD";

  return {
    root,
    repoPath,
    realE2eDir,
    baseBranch,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function uniqueBranch(prefix: string): string {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `station/${prefix}-${suffix}`;
}
