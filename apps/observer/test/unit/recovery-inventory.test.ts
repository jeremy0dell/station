import type { SessionRecoveryHandle } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { inspectObserverRecoveryInventory } from "../../src/sessionRecovery/inventory";

const earlier = "2026-08-20T11:00:00.000Z";
const now = "2026-08-20T12:00:00.000Z";

describe("inspectObserverRecoveryInventory", () => {
  it("reads once, sorts deterministically, and preserves contradictory evidence unclassified", async () => {
    const readRecoveryInventory = vi.fn(async () => ({
      sessions: [
        {
          id: "session-z",
          projectId: "project-1",
          worktreeId: "worktree-z",
          lifecycle: "ended" as const,
          title: "private title",
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
        handle({
          id: "handle-z",
          projectId: "different-project",
          sessionId: "session-z",
          worktreeId: "different-worktree",
        }),
        handle({
          id: "handle-a",
          target: { kind: "session-file", path: "/private/provider/session.jsonl" },
        }),
      ],
    }));

    const result = await inspectObserverRecoveryInventory({
      persistence: { readRecoveryInventory },
    });

    expect(readRecoveryInventory).toHaveBeenCalledOnce();
    expect(result.sessions.map((session) => session.id)).toEqual(["session-a", "session-z"]);
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
      {
        id: "handle-z",
        provider: "codex",
        projectId: "different-project",
        worktreeId: "different-worktree",
        sessionId: "session-z",
        targetKind: "native-session",
        observedAt: earlier,
        lastSeenAt: now,
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("native-secret");
    expect(serialized).not.toContain("/private/worktree");
    expect(serialized).not.toContain("/private/provider/session.jsonl");
    expect(serialized).not.toContain("terminal-secret");
    expect(serialized).not.toContain("native-run-secret");
    expect(serialized).not.toContain("private title");
    expect(serialized).not.toContain("eligible");
    expect(serialized).not.toContain("disposition");
  });

  it("returns version 1 with empty arrays and preserves absent optional fields", async () => {
    const empty = await inspectObserverRecoveryInventory({
      persistence: {
        readRecoveryInventory: async () => ({ sessions: [], recoveryHandles: [] }),
      },
    });
    expect(empty).toEqual({ schemaVersion: 1, sessions: [], recoveryHandles: [] });

    const result = await inspectObserverRecoveryInventory({
      persistence: {
        readRecoveryInventory: async () => ({
          sessions: [
            {
              id: "session-a",
              projectId: "project-1",
              worktreeId: "worktree-a",
              lifecycle: "legacy",
              createdAt: earlier,
              lastSeenAt: now,
            },
          ],
          recoveryHandles: [
            handle({ id: "handle-a", target: { kind: "session-file", path: "/secret" } }),
          ],
        }),
      },
    });

    expect(result.sessions[0]).not.toHaveProperty("harnessProvider");
    expect(result.sessions[0]).not.toHaveProperty("terminalProvider");
    expect(result.sessions[0]).not.toHaveProperty("endedAt");
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

  it("rejects duplicate persisted identities instead of returning an ambiguous inventory", async () => {
    const duplicate = {
      id: "session-a",
      projectId: "project-1",
      worktreeId: "worktree-a",
      lifecycle: "open" as const,
      createdAt: earlier,
      lastSeenAt: now,
    };
    await expect(
      inspectObserverRecoveryInventory({
        persistence: {
          readRecoveryInventory: async () => ({
            sessions: [duplicate, duplicate],
            recoveryHandles: [],
          }),
        },
      }),
    ).rejects.toThrow("Entries must be unique and deterministically sorted");
  });
});

function handle(overrides: Partial<SessionRecoveryHandle> & { id: string }): SessionRecoveryHandle {
  const result: SessionRecoveryHandle = {
    id: overrides.id,
    provider: overrides.provider ?? "codex",
    projectId: overrides.projectId ?? "project-1",
    worktreeId: overrides.worktreeId ?? "worktree-a",
    target: overrides.target ?? { kind: "native-session", id: "native-secret" },
    cwd: "/private/worktree",
    terminalTargetId: "terminal-secret",
    harnessRunId: "native-run-secret",
    observedAt: earlier,
    lastSeenAt: now,
  };
  if (overrides.sessionId !== undefined) result.sessionId = overrides.sessionId;
  return result;
}
