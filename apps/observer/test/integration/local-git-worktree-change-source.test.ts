import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitLocalEnvironmentVariables } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { createLocalGitWorktreeChangeSource } from "../../src/metadata/localGitChangeSummary.js";

const execFileAsync = promisify(execFile);

describe("local Git worktree change source adapter", () => {
  it("reads real branch-diff evidence and changes its opaque cache key after a commit", async () => {
    const repository = await mkdtemp(join(tmpdir(), "station-local-git-source-"));
    try {
      await git(repository, "init", "-b", "main");
      await git(repository, "config", "user.name", "Station Test");
      await git(repository, "config", "user.email", "station@example.invalid");
      await writeFile(join(repository, "README.md"), "main\n");
      await git(repository, "add", "README.md");
      await git(repository, "commit", "-m", "main");
      const baseSha = await git(repository, "rev-parse", "HEAD");
      await git(repository, "checkout", "-b", "feature");
      await writeFile(join(repository, "feature.txt"), "first\n");
      await git(repository, "add", "feature.txt");
      await git(repository, "commit", "-m", "feature one");

      const source = createLocalGitWorktreeChangeSource({
        resolveWorktree: (target) => ({ ...target, path: repository }),
        timeoutMs: 2_000,
        clock: { now: () => new Date("2026-05-20T12:00:00.000Z") },
      });
      const request = {
        target: { worktreeId: "wt_feature", projectId: "web", branch: "feature" },
        baseSelection: { defaultBranch: "main" },
        signal: new AbortController().signal,
      };

      const first = await source.read(request);
      expect(first).toMatchObject({
        status: "available",
        evidence: {
          summary: {
            kind: "branch_diff",
            additions: 1,
            deletions: 0,
            filesChanged: 1,
            binaryFiles: 0,
            baseRef: "main",
            baseSha: baseSha.trim(),
            mergeBaseSha: baseSha.trim(),
            headRef: "feature",
            source: "local_git",
          },
        },
      });
      if (first.status !== "available") throw new Error("Expected local Git evidence.");

      await writeFile(join(repository, "feature.txt"), "first\nsecond\n");
      await git(repository, "add", "feature.txt");
      await git(repository, "commit", "-m", "feature two");
      const second = await source.read(request);

      expect(second.status).toBe("available");
      if (second.status !== "available") throw new Error("Expected updated local Git evidence.");
      expect(second.evidence.summary.headSha).not.toBe(first.evidence.summary.headSha);
      expect(second.evidence.cacheKey).not.toBe(first.evidence.cacheKey);
      expect(second.evidence).not.toHaveProperty("path");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const name of gitLocalEnvironmentVariables) delete env[name];
  const result = await execFileAsync("git", args, { cwd, env });
  return result.stdout;
}
