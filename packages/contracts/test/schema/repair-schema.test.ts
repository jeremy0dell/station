import { ObserverRepairInventorySchema } from "@station/contracts";
import { describe, expect, it } from "vitest";

const now = "2026-08-20T12:00:00.000Z";
const recoveryHandle = {
  id: "handle-1",
  provider: "codex",
  projectId: "project-1",
  worktreeId: "worktree-1",
  sessionId: "session-1",
  targetKind: "native-session" as const,
  observedAt: now,
  lastSeenAt: now,
};

describe("observer repair inventory schema", () => {
  it("parses strict retained-session and redacted recovery-handle evidence", () => {
    const inventory = {
      schemaVersion: 1,
      sessions: [
        {
          id: "session-1",
          projectId: "project-1",
          worktreeId: "worktree-1",
          lifecycle: "open",
          harnessProvider: "codex",
          createdAt: now,
          lastSeenAt: now,
        },
      ],
      recoveryHandles: [recoveryHandle],
    } as const;

    expect(ObserverRepairInventorySchema.parse(inventory)).toEqual(inventory);
  });

  it("rejects duplicate or unsorted evidence", () => {
    const inventory = {
      schemaVersion: 1,
      sessions: [],
      recoveryHandles: [
        { ...recoveryHandle, id: "handle-z" },
        { ...recoveryHandle, id: "handle-a" },
      ],
    };
    expect(ObserverRepairInventorySchema.safeParse(inventory).success).toBe(false);
    expect(
      ObserverRepairInventorySchema.safeParse({
        ...inventory,
        recoveryHandles: [recoveryHandle, recoveryHandle],
      }).success,
    ).toBe(false);
  });

  it("rejects provider-native data and speculative repair policy", () => {
    for (const leakedField of [
      { target: { kind: "native-session", id: "native-secret" } },
      { cwd: "/private/worktree" },
      { harnessRunId: "native-run-secret" },
      { eligible: true },
      { disposition: "viable" },
      { reasonCode: "eligible" },
    ]) {
      expect(
        ObserverRepairInventorySchema.safeParse({
          schemaVersion: 1,
          sessions: [],
          recoveryHandles: [{ ...recoveryHandle, ...leakedField }],
        }).success,
      ).toBe(false);
    }
  });
});
