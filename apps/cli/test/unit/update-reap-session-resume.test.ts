import type { UpdateReapJournal } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import type { UpdateReapJournalPort } from "../../src/update/reapJournal.js";
import { executeUpdateReapSessionResume } from "../../src/update/reapSessionResume.js";

describe("update reap session resume", () => {
  it("resumes only the selected handle and completes the phase", async () => {
    const port = journalPort();
    let resumed = false;
    const resume = vi.fn(async () => {
      resumed = true;
    });
    const result = await executeUpdateReapSessionResume(journal(), port, {
      inspect: async () => (resumed ? "resumed" : "pending"),
      resume,
    });

    expect(resume).toHaveBeenCalledWith({
      projectId: "project-1",
      worktreeId: "worktree-1",
      sessionId: "session-1",
      harnessProvider: "codex",
      recoveryHandleId: "handle-1",
    });
    expect(result.phase).toBe("sessions-resumed");
    expect(result.targets[0]?.result?.resumeDisposition).toBe("resumed");
  });

  it("retains a retry command when exact-handle resume fails", async () => {
    const port = journalPort();
    const result = await executeUpdateReapSessionResume(journal(), port, {
      inspect: async () => "pending",
      resume: async () => {
        throw new Error("failed");
      },
    });

    expect(result.phase).toBe("persisted-reconciled");
    expect(result.targets[0]?.result).toMatchObject({
      resumeDisposition: "unresolved",
      unresolved: true,
      recoveryCommands: [["stn", "update", "--reap"]],
    });
  });

  it("does not repeat a resume after the journal recorded completion", async () => {
    const completed = journal();
    completed.phase = "sessions-resumed";
    const target = completed.targets[0];
    if (target?.result === undefined) throw new Error("Expected a completed terminal fixture.");
    target.result = {
      ...target.result,
      resumeDisposition: "resumed",
    };
    const resume = vi.fn(async () => undefined);

    const result = await executeUpdateReapSessionResume(completed, journalPort(), {
      inspect: vi.fn(async () => "resumed"),
      resume,
    });

    expect(result.phase).toBe("sessions-resumed");
    expect(resume).not.toHaveBeenCalled();
  });

  it("records an exact resumed session without repeating its successful command", async () => {
    const resume = vi.fn(async () => undefined);

    const result = await executeUpdateReapSessionResume(journal(), journalPort(), {
      inspect: async () => "resumed",
      resume,
    });

    expect(result.phase).toBe("sessions-resumed");
    expect(result.targets[0]?.result?.resumeDisposition).toBe("resumed");
    expect(resume).not.toHaveBeenCalled();
  });

  it("refuses a different live session without dispatching the recovery handle", async () => {
    const resume = vi.fn(async () => undefined);

    const result = await executeUpdateReapSessionResume(journal(), journalPort(), {
      inspect: async () => "conflict",
      resume,
    });

    expect(result.phase).toBe("persisted-reconciled");
    expect(result.targets[0]?.result?.resumeDisposition).toBe("unresolved");
    expect(resume).not.toHaveBeenCalled();
  });
});

function journal(): UpdateReapJournal {
  return {
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000001",
    authorizationDigest: "a".repeat(64),
    phase: "persisted-reconciled",
    channel: "installer-binary",
    selectedArtifact: { version: "1.2.3" },
    installedScopeDigest: "b".repeat(64),
    host: {
      socketPath: "/state/host.sock",
      inode: "1",
      birthtimeNs: "2",
      buildVersion: "1.2.2",
      buildIdentity: "c".repeat(64),
      process: { pid: 100, startToken: "host-start" },
    },
    targets: [
      {
        terminal: {
          kind: "agent",
          terminalTargetId: "terminal-1",
          ptyId: "pty-1",
          ptyInstanceId: "instance-1",
          projectId: "project-1",
          worktreeId: "worktree-1",
          sessionId: "session-1",
          harnessProvider: "codex",
          pid: 200,
        },
        processGroup: {
          leader: { pid: 200, parentPid: 100, pgid: 200, startToken: "terminal-start" },
          members: [{ pid: 200, parentPid: 100, pgid: 200, startToken: "terminal-start" }],
        },
        recovery: {
          kind: "selected",
          projectId: "project-1",
          worktreeId: "worktree-1",
          sessionId: "session-1",
          handleId: "handle-1",
        },
        result: {
          terminalTargetId: "terminal-1",
          ptyId: "pty-1",
          ptyInstanceId: "instance-1",
          sessionId: "session-1",
          terminationOutcome: "terminated",
          escalationUsed: false,
          resumeDisposition: "retained",
          unresolved: false,
          recoveryCommands: [],
        },
      },
    ],
    createdAt: "2026-09-04T12:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
  };
}

function journalPort(): UpdateReapJournalPort {
  let stored = journal();
  return {
    findIncomplete: async () => stored,
    read: async () => stored,
    write: async (value) => {
      stored = structuredClone(value);
    },
    withLock: async (run) => run(memoryLock()),
    takeOverLock: async (_transferToken, run) => run(memoryLock()),
  };
}

function memoryLock() {
  return {
    prepareTransfer: async () => "00000000-0000-4000-8000-000000000099",
    release: async () => undefined,
  };
}
