import type { UpdateReapJournal } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  executeUpdateReap,
  recoveryFromUpdateReapJournal,
} from "../../src/update/reapExecution.js";
import type { UpdateReapJournalPort } from "../../src/update/reapJournal.js";
import type { UpdateReapAuthorization } from "../../src/update/reapPlan.js";
import type {
  UpdateReapProcessGroup,
  UpdateReapProcessGroupPort,
} from "../../src/update/reapProcessGroups.js";

const group: UpdateReapProcessGroup = {
  leader: { pid: 200, parentPid: 100, pgid: 200, startToken: "terminal-start" },
  members: [{ pid: 200, parentPid: 100, pgid: 200, startToken: "terminal-start" }],
};
const authorization: UpdateReapAuthorization = {
  digest: "a".repeat(64),
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
        kind: "aux",
        terminalTargetId: "terminal-1",
        ptyId: "pty-1",
        ptyInstanceId: "instance-1",
        projectId: "project-1",
        worktreeId: "worktree-1",
        sessionId: "session-1",
        harnessProvider: "codex",
        pid: 200,
      },
      processGroup: group,
      recovery: { kind: "non-resumable" },
    },
  ],
};

describe("update reap execution", () => {
  it("persists nothing and sends no signal when cancelled before reaping", async () => {
    const journal = inMemoryJournal();
    const signal = vi.fn();
    const abort = new AbortController();
    abort.abort();

    await expect(
      executeUpdateReap({
        expected: expectedTransaction(),
        authorization,
        reauthorize: async () => authorization,
        journal,
        processGroups: { read: async () => group, signal, wait: async () => undefined },
        signal: abort.signal,
      }),
    ).rejects.toThrow("cancelled before reaping");
    expect(journal.writes).toEqual([]);
    expect(signal).not.toHaveBeenCalled();
  });

  it("persists reap-started before TERM and records graceful exit", async () => {
    const journal = inMemoryJournal();
    let alive = true;
    const signal = vi.fn();
    const processGroups: UpdateReapProcessGroupPort = {
      read: async () => (alive ? structuredClone(group) : { members: [] }),
      signal,
      wait: async (milliseconds) => {
        if (milliseconds === 3_000) alive = false;
      },
    };
    const result = await executeUpdateReap({
      expected: expectedTransaction(),
      authorization,
      reauthorize: async () => authorization,
      journal,
      processGroups,
      journalId: () => "00000000-0000-4000-8000-000000000001",
      now: () => "2026-09-04T12:00:00.000Z",
    });

    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(200, "SIGTERM");
    expect(result.journal.phase).toBe("reap-started");
    expect(result.recovery.terminals[0]).toMatchObject({
      terminationOutcome: "terminated",
      escalationUsed: false,
      resumeDisposition: "non-resumable",
      unresolved: false,
    });
    expect(journal.writes.map(({ phase }) => phase)).toEqual([
      "authorized",
      "recovery-prepared",
      "reap-started",
      "reap-started",
    ]);
  });

  it("sends no KILL when membership changes after TERM", async () => {
    const journal = inMemoryJournal();
    let reads = 0;
    const signal = vi.fn();
    const processGroups: UpdateReapProcessGroupPort = {
      read: async () => {
        reads += 1;
        return reads === 1
          ? structuredClone(group)
          : {
              ...structuredClone(group),
              members: [...group.members, { ...group.leader, pid: 201 }],
            };
      },
      signal,
      wait: async () => undefined,
    };
    const result = await executeUpdateReap({
      expected: expectedTransaction(),
      authorization,
      reauthorize: async () => authorization,
      journal,
      processGroups,
      journalId: () => "00000000-0000-4000-8000-000000000001",
    });

    expect(signal.mock.calls).toEqual([[200, "SIGTERM"]]);
    expect(result.recovery).toMatchObject({ status: "partial", unresolved: true });
  });

  it("kills an unchanged surviving member after the group leader exits", async () => {
    const journal = inMemoryJournal();
    const child = { ...group.leader, pid: 201, parentPid: 200 };
    const authorizedGroup = { ...group, members: [group.leader, child] };
    const authorized = {
      ...authorization,
      targets: [{ ...authorization.targets[0], processGroup: authorizedGroup }],
    };
    let reads = 0;
    const signal = vi.fn();
    const processGroups: UpdateReapProcessGroupPort = {
      read: async () => {
        reads += 1;
        if (reads === 1) return structuredClone(authorizedGroup);
        if (reads === 2) return { members: [{ ...child, parentPid: 1 }] };
        return { members: [] };
      },
      signal,
      wait: async () => undefined,
    };

    const result = await executeUpdateReap({
      expected: expectedTransaction(),
      authorization: authorized,
      reauthorize: async () => authorized,
      journal,
      processGroups,
      journalId: () => "00000000-0000-4000-8000-000000000001",
    });

    expect(signal.mock.calls).toEqual([
      [200, "SIGTERM"],
      [200, "SIGKILL"],
    ]);
    expect(result.recovery.terminals[0]).toMatchObject({
      terminationOutcome: "killed",
      escalationUsed: true,
      unresolved: false,
    });
  });

  it("journals an exact group that remains unresolved after KILL and never signals it again", async () => {
    const journal = inMemoryJournal();
    const signal = vi.fn();
    const processGroups: UpdateReapProcessGroupPort = {
      read: async () => structuredClone(group),
      signal,
      wait: async () => undefined,
    };
    const first = await executeUpdateReap({
      expected: expectedTransaction(),
      authorization,
      reauthorize: async () => authorization,
      journal,
      processGroups,
      journalId: () => "00000000-0000-4000-8000-000000000001",
    });

    expect(first.recovery.terminals[0]).toMatchObject({
      terminationOutcome: "unresolved",
      escalationUsed: true,
      unresolved: true,
    });
    expect(journal.writes.at(-1)?.targets[0]?.result).toEqual(first.recovery.terminals[0]);
    await executeUpdateReap({
      expected: expectedTransaction(),
      journal,
      processGroups,
    });
    expect(signal.mock.calls).toEqual([
      [200, "SIGTERM"],
      [200, "SIGKILL"],
    ]);
  });

  it("sends no further signal when process evidence becomes unreadable after TERM", async () => {
    const journal = inMemoryJournal();
    let reads = 0;
    const signal = vi.fn();
    const processGroups: UpdateReapProcessGroupPort = {
      read: async () => {
        reads += 1;
        if (reads > 1) throw new Error("ps failed");
        return structuredClone(group);
      },
      signal,
      wait: async () => undefined,
    };
    const result = await executeUpdateReap({
      expected: expectedTransaction(),
      authorization,
      reauthorize: async () => authorization,
      journal,
      processGroups,
      journalId: () => "00000000-0000-4000-8000-000000000001",
    });

    expect(signal.mock.calls).toEqual([[200, "SIGTERM"]]);
    expect(result.recovery).toMatchObject({ status: "partial", unresolved: true });
  });

  it("refuses a changed locked authorization before any signal", async () => {
    const journal = inMemoryJournal();
    const signal = vi.fn();
    await expect(
      executeUpdateReap({
        expected: expectedTransaction(),
        authorization,
        reauthorize: async () => ({ ...authorization, digest: "d".repeat(64) }),
        journal,
        processGroups: { read: async () => group, signal, wait: async () => undefined },
      }),
    ).rejects.toThrow("changed during locked preflight");
    expect(signal).not.toHaveBeenCalled();
    expect(journal.writes).toEqual([]);
  });

  it("projects missing post-start outcomes as retryable unresolved state", () => {
    const journal = journalFromAuthorization("reap-started");
    expect(recoveryFromUpdateReapJournal(journal)).toMatchObject({
      status: "partial",
      unresolved: true,
    });
  });
});

function expectedTransaction() {
  return {
    channel: authorization.channel,
    selectedArtifact: authorization.selectedArtifact,
    installedScopeDigest: authorization.installedScopeDigest,
  };
}

function journalFromAuthorization(phase: UpdateReapJournal["phase"]): UpdateReapJournal {
  return {
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000001",
    authorizationDigest: authorization.digest,
    phase,
    channel: authorization.channel,
    selectedArtifact: authorization.selectedArtifact,
    installedScopeDigest: authorization.installedScopeDigest,
    host: authorization.host,
    targets: structuredClone(authorization.targets),
    createdAt: "2026-09-04T12:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
  };
}

function inMemoryJournal(): UpdateReapJournalPort & { writes: UpdateReapJournal[] } {
  let stored: UpdateReapJournal | undefined;
  const writes: UpdateReapJournal[] = [];
  return {
    writes,
    findIncomplete: async () => stored,
    read: async () => {
      if (stored === undefined) throw new Error("missing");
      return stored;
    },
    write: async (journal) => {
      stored = structuredClone(journal);
      writes.push(structuredClone(journal));
    },
    withLock: async (run) =>
      run({
        prepareTransfer: async () => "00000000-0000-4000-8000-000000000099",
        release: async () => undefined,
      }),
    takeOverLock: async (_transferToken, run) =>
      run({
        prepareTransfer: async () => "00000000-0000-4000-8000-000000000098",
        release: async () => undefined,
      }),
  };
}
