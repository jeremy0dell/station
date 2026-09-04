import { describe, expect, it } from "vitest";
import { createInMemoryObserverPersistence } from "../support/inMemoryObserverPersistence.js";

const now = "2026-09-04T12:00:00.000Z";

describe("exact recovery-handle prune persistence", () => {
  it("requires one coherent digest and preserves every unrelated handle", async () => {
    const persistence = createInMemoryObserverPersistence();
    await persistence.seedSession({
      sessionId: "session-1",
      projectId: "project-1",
      worktreeId: "worktree-1",
      initialTitle: "Recovery",
      harness: "codex",
      terminalProvider: "tmux",
      createdAt: now,
      lastSeenAt: now,
    });
    const selected = await persistence.upsertSessionRecoveryHandle({
      id: "report-selected",
      provider: "codex",
      projectId: "project-1",
      worktreeId: "worktree-1",
      sessionId: "session-1",
      target: { kind: "native-session", id: "provider-selected" },
      cwd: "/tmp/project-1/worktree-1",
      observedAt: now,
      lastSeenAt: now,
    });
    const unrelated = await persistence.upsertSessionRecoveryHandle({
      id: "report-unrelated",
      provider: "codex",
      projectId: "project-1",
      worktreeId: "worktree-1",
      sessionId: "session-1",
      target: { kind: "native-session", id: "provider-unrelated" },
      cwd: "/tmp/project-1/worktree-1",
      observedAt: now,
      lastSeenAt: now,
    });
    const captured = await persistence.readRecoveryRepairSnapshot();
    const sessionId = selected.sessionId;
    if (sessionId === undefined) throw new Error("Expected session-bound recovery handle.");
    await expect(
      persistence.pruneSessionRecoveryHandle({
        recoveryHandleId: selected.id,
        expectedRecoveryInventoryDigest: "f".repeat(64),
        expected: {
          projectId: selected.projectId,
          worktreeId: selected.worktreeId,
          sessionId,
          provider: selected.provider,
        },
      }),
    ).rejects.toThrow("PERSISTENCE_TRANSACTION_FAILED");
    await expect(
      persistence.pruneSessionRecoveryHandle({
        recoveryHandleId: selected.id,
        expectedRecoveryInventoryDigest: captured.recoveryInventoryDigest,
        expected: {
          projectId: selected.projectId,
          worktreeId: selected.worktreeId,
          sessionId,
          provider: selected.provider,
        },
      }),
    ).resolves.toMatchObject({ deleted: true });
    await expect(persistence.listSessionRecoveryHandles()).resolves.toEqual([unrelated]);
  });
});
