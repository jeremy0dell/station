import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationSnapshot } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  createWorktreeGitRefInvalidationService,
  gitRefInvalidationTargetsForWorktree,
} from "../../src/metadata/gitRefInvalidation.js";

describe("worktree git ref invalidation", () => {
  it("resolves linked-worktree git ref targets", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "station-git-ref-invalidation-"));
    try {
      const worktree = join(tempDir, "worktree");
      const commonGitDir = join(tempDir, "repo", ".git");
      const gitDir = join(commonGitDir, "worktrees", "pr-info-1");
      await mkdir(worktree, { recursive: true });
      await mkdir(gitDir, { recursive: true });
      await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
      await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/pr-info-1\n");
      await writeFile(join(gitDir, "commondir"), "../..\n");

      const targets = gitRefInvalidationTargetsForWorktree(worktree, "pr-info-1").map(
        (target) => target.path,
      );

      expect(targets).toContain(join(worktree, ".git"));
      expect(targets).toContain(join(gitDir, "HEAD"));
      expect(targets).toContain(join(commonGitDir, "refs/heads/pr-info-1"));
      expect(targets).toContain(join(commonGitDir, "packed-refs"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requests reconcile when a watched branch ref changes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "station-git-ref-invalidation-"));
    const reasons: string[] = [];
    const directoryWatches: Array<{
      directory: string;
      listener: (changedFile: string | undefined) => void;
    }> = [];
    const watcher = createWorktreeGitRefInvalidationService({
      debounceMs: 10,
      requestReconcile: (reason) => {
        reasons.push(reason);
      },
      watchDirectory: (directory, listener) => {
        directoryWatches.push({ directory, listener });
        return { close: () => undefined };
      },
    });

    try {
      const worktree = join(tempDir, "worktree");
      const refDir = join(worktree, ".git", "refs", "heads");
      await mkdir(refDir, { recursive: true });
      await writeFile(join(worktree, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(refDir, "main"), "one\n");

      watcher.update({
        rows: [
          {
            id: "wt_1",
            path: worktree,
            branch: "main",
            worktree: { state: "exists" },
          },
        ],
      } as StationSnapshot);

      const refWatch = directoryWatches.find((entry) => entry.directory === refDir);
      expect(refWatch).toBeDefined();
      refWatch?.listener("main");
      await waitFor(() => reasons.includes("metadata:git-ref:wt_1"));
    } finally {
      watcher.shutdown();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}
