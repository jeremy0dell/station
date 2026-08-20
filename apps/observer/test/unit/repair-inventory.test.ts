import type { SessionRecoveryHandle } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { inspectObserverRepairInventory } from "../../src/maintenance/repairInventory";

const earlier = "2026-08-20T11:00:00.000Z";
const now = "2026-08-20T12:00:00.000Z";

describe("inspectObserverRepairInventory", () => {
  it("reads once, sorts deterministically, and redacts provider-native recovery data", async () => {
    const readRepairInventory = vi.fn(async () => ({
      sessions: [
        {
          id: "session-z",
          projectId: "project-1",
          worktreeId: "worktree-z",
          lifecycle: "ended" as const,
          harness: "codex",
          terminalProvider: "station",
          createdAt: earlier,
          lastSeenAt: now,
          endedAt: now,
        },
        {
          id: "session-a",
          projectId: "project-1",
          worktreeId: "worktree-a",
          lifecycle: "open" as const,
          harness: "codex",
          terminalProvider: "station",
          createdAt: earlier,
          lastSeenAt: now,
        },
      ],
      recoveryHandles: [
        handle({ id: "handle-z", sessionId: "session-z", worktreeId: "worktree-z" }),
        handle({ id: "handle-a", sessionId: "session-a", worktreeId: "worktree-a" }),
      ],
    }));

    const result = await inspectObserverRepairInventory({
      persistence: { readRepairInventory },
    });

    expect(readRepairInventory).toHaveBeenCalledOnce();
    expect(result.sessions.map((session) => session.id)).toEqual(["session-a", "session-z"]);
    expect(result.recoveryHandles).toEqual([
      {
        id: "handle-a",
        provider: "codex",
        projectId: "project-1",
        worktreeId: "worktree-a",
        sessionId: "session-a",
        targetKind: "native-session",
        observedAt: earlier,
        lastSeenAt: now,
      },
      {
        id: "handle-z",
        provider: "codex",
        projectId: "project-1",
        worktreeId: "worktree-z",
        sessionId: "session-z",
        targetKind: "native-session",
        observedAt: earlier,
        lastSeenAt: now,
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("native-secret");
    expect(serialized).not.toContain("/private/worktree");
    expect(serialized).not.toContain("harnessRunId");
  });

  it("preserves absent optional evidence without deriving eligibility", async () => {
    const result = await inspectObserverRepairInventory({
      persistence: {
        readRepairInventory: async () => ({
          sessions: [],
          recoveryHandles: [
            handle({ id: "handle-a", target: { kind: "session-file", path: "/secret" } }),
          ],
        }),
      },
    });

    expect(result.recoveryHandles).toEqual([
      {
        id: "handle-a",
        provider: "codex",
        projectId: "project-1",
        worktreeId: "worktree-a",
        targetKind: "session-file",
        observedAt: earlier,
        lastSeenAt: now,
      },
    ]);
    expect(result.recoveryHandles[0]).not.toHaveProperty("sessionId");
    expect(result.recoveryHandles[0]).not.toHaveProperty("eligible");
    expect(JSON.stringify(result)).not.toContain("/secret");
  });
});

function handle(overrides: Partial<SessionRecoveryHandle> & { id: string }): SessionRecoveryHandle {
  const result: SessionRecoveryHandle = {
    id: overrides.id,
    provider: overrides.provider ?? "codex",
    projectId: "project-1",
    worktreeId: overrides.worktreeId ?? "worktree-a",
    target: overrides.target ?? { kind: "native-session", id: "native-secret" },
    cwd: "/private/worktree",
    harnessRunId: "native-run-secret",
    observedAt: earlier,
    lastSeenAt: now,
  };
  if (overrides.sessionId !== undefined) result.sessionId = overrides.sessionId;
  return result;
}
