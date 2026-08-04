import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeRecoveryArtifactLocator } from "../../src/recoveryArtifacts.js";

const now = "2026-07-30T12:00:00.000Z";

describe("Claude recovery artifacts", () => {
  it("uses the configured projects root and exact native session id", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-claude-recovery-"));
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    const exact = join(project, "native-1.jsonl");
    await writeFile(exact, "exact\n");
    await writeFile(join(project, "native-10.jsonl"), "near\n");

    try {
      const locator = createClaudeRecoveryArtifactLocator(root);
      expect(locator.protectedRoots()).toEqual([root]);
      await expect(
        locator.locate({
          id: "rec_claude",
          provider: "claude",
          projectId: "station",
          worktreeId: "wt_station",
          target: { kind: "native-session", id: "native-1" },
          observedAt: now,
          lastSeenAt: now,
        }),
      ).resolves.toEqual([exact]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
