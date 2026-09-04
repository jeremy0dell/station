import { UpdateReapJournalSchema, UpdateReapRecoveryResultSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";

const terminal = {
  kind: "agent" as const,
  terminalTargetId: "terminal-1",
  ptyId: "pty-1",
  ptyInstanceId: "pty-instance-1",
  projectId: "project-1",
  worktreeId: "worktree-1",
  sessionId: "session-1",
  harnessProvider: "codex",
  pid: 200,
};
const result = {
  terminalTargetId: terminal.terminalTargetId,
  ptyId: terminal.ptyId,
  ptyInstanceId: terminal.ptyInstanceId,
  sessionId: terminal.sessionId,
  terminationOutcome: "terminated" as const,
  escalationUsed: false,
  resumeDisposition: "resumed" as const,
  unresolved: false,
  recoveryCommands: [],
};
const journal = {
  schemaVersion: 1 as const,
  id: "00000000-0000-4000-8000-000000000001",
  authorizationDigest: "a".repeat(64),
  phase: "completed" as const,
  channel: "installer-binary" as const,
  selectedArtifact: { version: "1.2.3" },
  installedScopeDigest: "b".repeat(64),
  host: {
    socketPath: "/private/state/host.sock",
    inode: "7",
    birthtimeNs: "8",
    buildVersion: "1.2.2",
    buildIdentity: "c".repeat(64),
    process: { pid: 100, startToken: "Mon Jan 01 00:00:00 2024" },
  },
  targets: [
    {
      terminal,
      processGroup: {
        leader: {
          pid: 200,
          parentPid: 100,
          pgid: 200,
          startToken: "Mon Jan 01 00:00:01 2024",
        },
        members: [
          {
            pid: 200,
            parentPid: 100,
            pgid: 200,
            startToken: "Mon Jan 01 00:00:01 2024",
          },
        ],
      },
      recovery: {
        kind: "selected" as const,
        projectId: terminal.projectId,
        worktreeId: terminal.worktreeId,
        sessionId: terminal.sessionId,
        handleId: "handle-1",
      },
      result,
    },
  ],
  createdAt: "2026-09-04T12:00:00.000Z",
  updatedAt: "2026-09-04T12:01:00.000Z",
};

describe("update reap execution schemas", () => {
  it("accepts a strict completed private journal", () => {
    expect(UpdateReapJournalSchema.parse(journal)).toEqual(journal);
    expect(UpdateReapJournalSchema.safeParse({ ...journal, signalAuthority: true }).success).toBe(
      false,
    );
  });

  it("rejects changed process groups and unresolved completed journals", () => {
    const changedGroup = structuredClone(journal);
    const changedMember = changedGroup.targets[0]?.processGroup.members[0];
    if (changedMember === undefined) throw new Error("Expected a process-group member fixture.");
    changedMember.pgid = 201;
    expect(UpdateReapJournalSchema.safeParse(changedGroup).success).toBe(false);

    const unresolved = structuredClone(journal);
    const unresolvedTarget = unresolved.targets[0];
    if (unresolvedTarget === undefined) throw new Error("Expected a journal target fixture.");
    unresolvedTarget.result = {
      ...result,
      terminationOutcome: "unresolved",
      escalationUsed: true,
      resumeDisposition: "unresolved",
      unresolved: true,
      recoveryCommands: [["stn", "update", "--reap"]],
    };
    unresolved.phase = "reap-started";
    expect(UpdateReapJournalSchema.safeParse(unresolved).success).toBe(true);
    unresolved.phase = "completed";
    expect(UpdateReapJournalSchema.safeParse(unresolved).success).toBe(false);
  });

  it("requires aggregate and per-terminal recovery outcomes to agree", () => {
    const recovery = {
      status: "completed" as const,
      terminals: [result],
      unresolved: false,
      recoveryCommands: [],
    };
    expect(UpdateReapRecoveryResultSchema.parse(recovery)).toEqual(recovery);
    expect(
      UpdateReapRecoveryResultSchema.safeParse({ ...recovery, unresolved: true }).success,
    ).toBe(false);
  });
});
