import { ObserverRecoveryInventorySchema } from "@station/contracts";
import { describe, expect, it } from "vitest";

const now = "2026-08-20T12:00:00.000Z";
const session = {
  id: "session-a",
  projectId: "project-1",
  worktreeId: "worktree-1",
  lifecycle: "open" as const,
  createdAt: now,
  lastSeenAt: now,
};
const recoveryHandle = {
  id: "handle-a",
  provider: "codex",
  projectId: "project-1",
  worktreeId: "worktree-1",
  sessionId: "session-1",
  targetKind: "native-session" as const,
  observedAt: now,
  lastSeenAt: now,
};

describe("observer recovery inventory schema", () => {
  it("parses empty and incomplete persisted evidence without adding optional fields", () => {
    expect(
      ObserverRecoveryInventorySchema.parse({
        schemaVersion: 1,
        sessions: [],
        recoveryHandles: [],
      }),
    ).toEqual({ schemaVersion: 1, sessions: [], recoveryHandles: [] });

    const inventory = {
      schemaVersion: 1,
      sessions: [
        {
          ...session,
          lifecycle: "ended" as const,
        },
      ],
      recoveryHandles: [
        {
          id: recoveryHandle.id,
          provider: recoveryHandle.provider,
          projectId: "different-project",
          worktreeId: recoveryHandle.worktreeId,
          targetKind: recoveryHandle.targetKind,
          observedAt: recoveryHandle.observedAt,
          lastSeenAt: recoveryHandle.lastSeenAt,
        },
      ],
    } as const;

    const parsed = ObserverRecoveryInventorySchema.parse(inventory);
    expect(parsed.sessions[0]).not.toHaveProperty("harnessProvider");
    expect(parsed.sessions[0]).not.toHaveProperty("terminalProvider");
    expect(parsed.sessions[0]).not.toHaveProperty("endedAt");
    expect(parsed.recoveryHandles[0]).not.toHaveProperty("sessionId");
  });

  it.each([
    {
      label: "unsorted sessions",
      sessions: [{ ...session, id: "session-z" }, session],
      recoveryHandles: [],
    },
    { label: "duplicate sessions", sessions: [session, session], recoveryHandles: [] },
    {
      label: "unsorted handles",
      sessions: [],
      recoveryHandles: [{ ...recoveryHandle, id: "handle-z" }, recoveryHandle],
    },
    {
      label: "duplicate handles",
      sessions: [],
      recoveryHandles: [recoveryHandle, recoveryHandle],
    },
  ])("rejects $label", ({ sessions, recoveryHandles }) => {
    expect(
      ObserverRecoveryInventorySchema.safeParse({ schemaVersion: 1, sessions, recoveryHandles })
        .success,
    ).toBe(false);
  });

  it("rejects provider-native, local, and speculative policy fields", () => {
    for (const leakedField of [
      { target: { kind: "native-session", id: "native-secret" } },
      { nativeTargetId: "native-secret" },
      { sessionFilePath: "/private/provider/session.jsonl" },
      { cwd: "/private/worktree" },
      { terminalTargetId: "terminal-secret" },
      { harnessRunId: "native-run-secret" },
      { command: ["codex", "resume"] },
      { environment: { SECRET: "value" } },
      { transcript: "private output" },
      { eligible: true },
      { rank: 1 },
      { disposition: "viable" },
    ]) {
      expect(
        ObserverRecoveryInventorySchema.safeParse({
          schemaVersion: 1,
          sessions: [],
          recoveryHandles: [{ ...recoveryHandle, ...leakedField }],
        }).success,
      ).toBe(false);
    }

    expect(
      ObserverRecoveryInventorySchema.safeParse({
        schemaVersion: 1,
        sessions: [{ ...session, title: "private title" }],
        recoveryHandles: [],
      }).success,
    ).toBe(false);
    expect(
      ObserverRecoveryInventorySchema.safeParse({
        schemaVersion: 2,
        sessions: [],
        recoveryHandles: [],
      }).success,
    ).toBe(false);
  });
});
