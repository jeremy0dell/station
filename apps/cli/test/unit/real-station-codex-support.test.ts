import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexSentinel } from "../../../../tests/support/real-station/codex.js";
import type { RealTempRepo } from "../../../../tests/support/real-station/repo.js";

describe("real Station Codex support", () => {
  it("targets an explicit worktree in the prompt and sentinel path", () => {
    const repo: RealTempRepo = {
      root: "/tmp/station-real-e2e",
      repoPath: "/tmp/station-real-e2e/repo",
      realE2eDir: "/tmp/station-real-e2e/repo/.station-real-e2e",
      baseBranch: "main",
      cleanup: async () => undefined,
    };
    const targetRoot = "/tmp/station-real-e2e/worktrees/existing";

    const sentinel = createCodexSentinel(repo, "start-agent", targetRoot);

    expect(sentinel.absolutePath).toBe(join(targetRoot, sentinel.relativePath));
    expect(sentinel.prompt.split("\n")).toContain(
      `Create or overwrite only ${sentinel.absolutePath}.`,
    );
  });
});
