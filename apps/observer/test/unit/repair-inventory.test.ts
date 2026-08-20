import type { SessionRecoveryHandle } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { inspectObserverRepairInventory } from "../../src/maintenance/repairInventory";
import type { ProviderRegistry } from "../../src/providers/registry";

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
      providers: providersWithResume("codex"),
    });

    expect(readRepairInventory).toHaveBeenCalledOnce();
    expect(result.sessions.map((session) => session.id)).toEqual(["session-a", "session-z"]);
    expect(result.recoveryHandles).toEqual([
      expect.objectContaining({ id: "handle-a", disposition: "viable", eligible: true }),
      expect.objectContaining({
        id: "handle-z",
        disposition: "ended-session",
        eligible: false,
      }),
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("native-secret");
    expect(serialized).not.toContain("/private/worktree");
    expect(serialized).not.toContain("harnessRunId");
  });

  it("classifies missing, mismatched, and unsupported handles without mutating", async () => {
    const result = await inspectObserverRepairInventory({
      persistence: {
        readRepairInventory: async () => ({
          sessions: [
            {
              id: "session-a",
              projectId: "project-1",
              worktreeId: "worktree-a",
              lifecycle: "open",
              harness: "codex",
              createdAt: earlier,
              lastSeenAt: now,
            },
          ],
          recoveryHandles: [
            handle({ id: "a-missing" }),
            handle({ id: "b-worktree", sessionId: "session-a", worktreeId: "other" }),
            handle({ id: "c-provider", sessionId: "session-a", provider: "claude" }),
            handle({ id: "d-unsupported", sessionId: "session-a" }),
          ],
        }),
      },
    });

    expect(result.recoveryHandles.map((item) => item.disposition)).toEqual([
      "missing-session",
      "worktree-mismatch",
      "provider-mismatch",
      "unsupported-provider",
    ]);
  });
});

function handle(overrides: Partial<SessionRecoveryHandle> & { id: string }): SessionRecoveryHandle {
  return {
    id: overrides.id,
    provider: overrides.provider ?? "codex",
    projectId: "project-1",
    worktreeId: overrides.worktreeId ?? "worktree-a",
    target: { kind: "native-session", id: "native-secret" },
    cwd: "/private/worktree",
    harnessRunId: "native-run-secret",
    observedAt: earlier,
    lastSeenAt: now,
    ...(overrides.sessionId === undefined ? {} : { sessionId: overrides.sessionId }),
  };
}

function providersWithResume(provider: string): ProviderRegistry {
  return {
    harnesses: new Map([[provider, { capabilities: () => ({ canResume: true }) }]]),
  } as unknown as ProviderRegistry;
}
