import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexRecoveryArtifactLocator } from "../../src/recoveryArtifacts.js";

const now = "2026-07-30T12:00:00.000Z";

describe("Codex recovery artifacts", () => {
  it("returns the state database and only exact native-session assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-recovery-"));
    const sessions = join(root, "sessions", "2026", "07", "30");
    const snapshots = join(root, "shell_snapshots");
    await mkdir(sessions, { recursive: true });
    await mkdir(snapshots, { recursive: true });
    const exactRollout = join(sessions, "rollout-now-thread-1.jsonl");
    const exactSnapshot = join(snapshots, "thread-1.123.sh");
    const stateDatabase = join(root, "state_5.sqlite");
    await writeFile(exactRollout, "exact\n");
    await writeFile(join(sessions, "rollout-now-thread-10.jsonl"), "near\n");
    await writeFile(exactSnapshot, "exact\n");
    await writeFile(stateDatabase, "state\n");

    try {
      const locator = createCodexRecoveryArtifactLocator(root);
      await expect(
        locator.locate({
          id: "rec_codex",
          provider: "codex",
          projectId: "station",
          worktreeId: "wt_station",
          target: { kind: "native-session", id: "thread-1" },
          observedAt: now,
          lastSeenAt: now,
        }),
      ).resolves.toEqual([exactRollout, exactSnapshot, stateDatabase]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
