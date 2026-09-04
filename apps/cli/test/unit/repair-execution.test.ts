import type {
  RepairAction,
  RepairAudit,
  RepairBackup,
  RepairInventory,
  RepairJournal,
  RepairPlan,
  UpdateReapJournalTarget,
} from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { executeRepair, type RepairExecutionDeps } from "../../src/repair/execution.js";

const now = "2026-09-04T12:00:00.000Z";
const inventoryDigest = "a".repeat(64);
const planDigest = "b".repeat(64);
const recoveryDigest = "c".repeat(64);
const backup: RepairBackup = {
  schemaVersion: 1,
  id: "00000000-0000-4000-8000-000000000003",
  contentDigest: "d".repeat(64),
  recoveryInventoryDigest: recoveryDigest,
};

describe("repair execution", () => {
  it("audits and refuses a changed locked plan without backup or mutation", async () => {
    const setup = fixture({ kind: "observer-cleanup" });
    const result = await executeRepair({ kind: "observer-cleanup" }, "f".repeat(64), setup.deps);
    expect(result.status).toBe("refused");
    expect(setup.events).toEqual(["repair-lock", "inspect", "audit-start", "audit-refused"]);
    expect(setup.deps.cleanupObserver).not.toHaveBeenCalled();
  });

  it("replaces changed pre-mutation authorization only with the new preview digest", async () => {
    const action: RepairAction = { kind: "observer-cleanup" };
    const setup = fixture(action);
    setup.currentJournal = {
      ...journal(action, "authorized"),
      planDigest: "f".repeat(64),
      inventoryDigest: "0".repeat(64),
    };

    const result = await executeRepair({ kind: "observer-cleanup" }, planDigest, setup.deps);

    expect(result.status).toBe("completed");
    expect(setup.deps.cleanupObserver).toHaveBeenCalledOnce();
    expect(setup.currentJournal).toMatchObject({
      id: "00000000-0000-4000-8000-000000000005",
      planDigest,
      inventoryDigest,
      phase: "completed",
    });
  });

  it("writes the audit, journal, and verified backup before prune dispatch", async () => {
    const setup = fixture({
      kind: "recovery-prune",
      recoveryHandleId: "handle-1",
      projectId: "project-1",
      worktreeId: "worktree-1",
      sessionId: "session-1",
      provider: "codex",
    });
    const result = await executeRepair(
      { kind: "recovery-prune", recoveryHandleId: "handle-1" },
      planDigest,
      setup.deps,
    );
    expect(result).toMatchObject({
      status: "completed",
      backup,
      auditId: expect.any(String),
    });
    expect(setup.events.indexOf("audit-start")).toBeLessThan(
      setup.events.indexOf("journal-authorized"),
    );
    expect(setup.events.indexOf("backup")).toBeLessThan(
      setup.events.indexOf("journal-mutation-started"),
    );
    expect(setup.events.indexOf("journal-mutation-started")).toBeLessThan(
      setup.events.indexOf("prune"),
    );
    expect(setup.deps.pruneRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryHandleId: "handle-1" }),
      expect.objectContaining({
        expectedRecoveryInventoryDigest: recoveryDigest,
        backup,
      }),
    );
  });

  it("continues the same journal after mutation starts without reauthorizing changed evidence", async () => {
    const action: RepairAction = {
      kind: "recovery-prune",
      recoveryHandleId: "handle-1",
      projectId: "project-1",
      worktreeId: "worktree-1",
      sessionId: "session-1",
      provider: "codex",
    };
    const setup = fixture(action);
    setup.currentJournal = journal(action, "mutation-started", backup);
    vi.mocked(setup.deps.verify).mockResolvedValueOnce(false);
    const result = await executeRepair(
      { kind: "recovery-prune", recoveryHandleId: "handle-1" },
      "changed-preview-is-ignored-after-commit",
      setup.deps,
    );
    expect(result.status).toBe("completed");
    expect(setup.deps.inspectInventory).not.toHaveBeenCalled();
    expect(setup.deps.backup.create).not.toHaveBeenCalled();
    expect(setup.deps.pruneRecovery).toHaveBeenCalledOnce();
  });

  it("does not launch recovery resume again after an interrupted commit", async () => {
    const action: RepairAction = {
      kind: "recovery-resume",
      recoveryHandleId: "handle-1",
      projectId: "project-1",
      worktreeId: "worktree-1",
      sessionId: "session-1",
      provider: "codex",
    };
    const setup = fixture(action);
    setup.currentJournal = journal(action, "mutation-started", backup);
    vi.mocked(setup.deps.verify).mockResolvedValue(false);

    const result = await executeRepair(
      { kind: "recovery-resume", recoveryHandleId: "handle-1" },
      "changed-preview-is-ignored-after-commit",
      setup.deps,
    );

    expect(result.status).toBe("recovery-required");
    expect(setup.deps.inspectInventory).not.toHaveBeenCalled();
    expect(setup.deps.resumeRecovery).not.toHaveBeenCalled();
  });

  it("continues cleanup policy after an interrupted commit when its postcondition is absent", async () => {
    const action: RepairAction = { kind: "observer-cleanup" };
    const setup = fixture(action);
    setup.currentJournal = journal(action, "mutation-started");
    vi.mocked(setup.deps.verify).mockResolvedValueOnce(false);

    const result = await executeRepair(
      { kind: "observer-cleanup" },
      "changed-preview-is-ignored-after-commit",
      setup.deps,
    );

    expect(result.status).toBe("completed");
    expect(setup.deps.cleanupObserver).toHaveBeenCalledOnce();
  });

  it("records an unresolved one-terminal reap as partial", async () => {
    const action: RepairAction = { kind: "terminal-reap", terminalTargetId: "terminal-1" };
    const setup = fixture(action);
    const target = terminalTarget();
    setup.currentJournal = {
      ...journal(action, "mutation-started", backup),
      terminalTarget: target,
      terminalAuthorizationDigest: "f".repeat(64),
    };
    vi.mocked(setup.deps.verify).mockResolvedValueOnce(false);
    vi.mocked(setup.deps.reapTerminal).mockResolvedValueOnce({
      ...target,
      result: {
        terminalTargetId: "terminal-1",
        ptyId: "pty-1",
        ptyInstanceId: "instance-1",
        sessionId: "session-1",
        terminationOutcome: "unresolved",
        escalationUsed: false,
        resumeDisposition: "non-resumable",
        unresolved: true,
        recoveryCommands: [["stn", "repair", "terminal", "reap", "--terminal", "terminal-1"]],
      },
    });

    const result = await executeRepair(
      { kind: "terminal-reap", terminalTargetId: "terminal-1" },
      "changed-preview-is-ignored-after-commit",
      setup.deps,
    );

    expect(result).toMatchObject({ status: "partial", termination: { unresolved: true } });
    expect(result.recoveryCommands[0]).toEqual([
      "stn",
      "repair",
      "terminal",
      "reap",
      "--terminal",
      "terminal-1",
      "--yes",
      "--expect-plan",
      planDigest,
    ]);
    expect(setup.events).toContain("audit-partial");
  });

  it("refuses changed private terminal authorization after backup and before signaling", async () => {
    const action: RepairAction = { kind: "terminal-reap", terminalTargetId: "terminal-1" };
    const setup = fixture(action);
    const target = terminalTarget();
    vi.mocked(setup.deps.authorizeTerminal)
      .mockResolvedValueOnce({ target, authorizationDigest: "f".repeat(64) })
      .mockResolvedValueOnce({ target, authorizationDigest: "0".repeat(64) });

    const result = await executeRepair(
      { kind: "terminal-reap", terminalTargetId: "terminal-1" },
      planDigest,
      setup.deps,
    );

    expect(result.status).toBe("refused");
    expect(setup.deps.authorizeTerminal).toHaveBeenCalledTimes(2);
    expect(setup.deps.reapTerminal).not.toHaveBeenCalled();
    expect(setup.currentJournal?.phase).toBe("backup-verified");
  });

  it("refuses a changed complete inventory after backup and before signaling", async () => {
    const action: RepairAction = { kind: "terminal-reap", terminalTargetId: "terminal-1" };
    const selector = { kind: "terminal-reap" as const, terminalTargetId: "terminal-1" };
    const setup = fixture(action);
    const target = terminalTarget();
    const originalPlan = setup.deps.derivePlan(recoveryInventory(), selector);
    vi.mocked(setup.deps.derivePlan)
      .mockReturnValueOnce(originalPlan)
      .mockReturnValueOnce({ ...originalPlan, repairPlanDigest: "0".repeat(64) });
    vi.mocked(setup.deps.authorizeTerminal).mockResolvedValue({
      target,
      authorizationDigest: "f".repeat(64),
    });

    const result = await executeRepair(selector, planDigest, setup.deps);

    expect(result.status).toBe("refused");
    expect(setup.deps.inspectInventory).toHaveBeenCalledTimes(2);
    expect(setup.deps.authorizeTerminal).toHaveBeenCalledOnce();
    expect(setup.deps.reapTerminal).not.toHaveBeenCalled();
    expect(setup.currentJournal?.phase).toBe("backup-verified");
  });

  it("continues the audit named by an interrupted journal instead of orphaning it", async () => {
    const action: RepairAction = { kind: "observer-cleanup" };
    const setup = fixture(action);
    setup.currentJournal = journal(action, "mutation-started");
    setup.currentAudit = repairAudit(action, "in-progress");
    vi.mocked(setup.deps.verify).mockResolvedValueOnce(true);

    const result = await executeRepair(
      { kind: "observer-cleanup" },
      "ignored-after-commit",
      setup.deps,
    );

    expect(result.status).toBe("completed");
    expect(setup.deps.audit.start).not.toHaveBeenCalled();
    expect(result.auditId).toBe(setup.currentJournal.auditId);
    expect(setup.currentAudit?.status).toBe("completed");
  });

  it("finalizes an audit interrupted before its journal and records the retry", async () => {
    const action: RepairAction = { kind: "observer-cleanup" };
    const setup = fixture(action);
    setup.currentAudit = repairAudit(action, "in-progress");

    const result = await executeRepair({ kind: "observer-cleanup" }, planDigest, setup.deps);

    expect(result.status).toBe("completed");
    expect(setup.events.indexOf("audit-refused")).toBeLessThan(setup.events.indexOf("audit-start"));
    expect(setup.deps.audit.start).toHaveBeenCalledOnce();
  });

  it("finalizes an interrupted audit from its completed journal before the next attempt", async () => {
    const action: RepairAction = { kind: "observer-cleanup" };
    const setup = fixture(action);
    setup.currentJournal = journal(action, "completed");
    setup.currentAudit = repairAudit(action, "in-progress");
    const freshPlan = setup.deps.derivePlan(recoveryInventory(), { kind: "observer-cleanup" });
    vi.mocked(setup.deps.derivePlan)
      .mockClear()
      .mockReturnValue({
        ...freshPlan,
        status: "refused",
        reason: "observer-not-stale",
      });

    const result = await executeRepair({ kind: "observer-cleanup" }, planDigest, setup.deps);

    expect(result.status).toBe("completed");
    expect(result.journalId).toBe(setup.currentJournal.id);
    expect(setup.events).toEqual(["repair-lock", "audit-completed"]);
    expect(setup.deps.audit.start).not.toHaveBeenCalled();
    expect(setup.deps.inspectInventory).not.toHaveBeenCalled();
  });

  it("audits a selector that conflicts with an incomplete transaction", async () => {
    const attempted: RepairAction = {
      kind: "recovery-prune",
      recoveryHandleId: "handle-1",
      projectId: "project-1",
      worktreeId: "worktree-1",
      sessionId: "session-1",
      provider: "codex",
    };
    const setup = fixture(attempted);
    setup.currentJournal = journal({ kind: "observer-cleanup" }, "mutation-started");

    const result = await executeRepair(
      { kind: "recovery-prune", recoveryHandleId: "handle-1" },
      planDigest,
      setup.deps,
    );

    expect(result.status).toBe("refused");
    expect(setup.deps.audit.start).toHaveBeenCalledOnce();
    expect(setup.events).toContain("audit-refused");
    expect(result.recoveryCommands[0]).toEqual([
      "stn",
      "repair",
      "observer",
      "cleanup",
      "--yes",
      "--expect-plan",
      planDigest,
    ]);
  });

  it("returns recovery-required and keeps the incomplete journal after a committed failure", async () => {
    const setup = fixture({ kind: "observer-cleanup" });
    vi.mocked(setup.deps.cleanupObserver).mockRejectedValueOnce(new Error("changed owner"));
    const result = await executeRepair({ kind: "observer-cleanup" }, planDigest, setup.deps);
    expect(result).toMatchObject({
      status: "recovery-required",
      journalId: expect.any(String),
    });
    expect(setup.currentJournal?.phase).toBe("mutation-started");
    expect(setup.events).toContain("audit-recovery-required");
  });
});

function fixture(action: RepairAction): {
  deps: RepairExecutionDeps;
  events: string[];
  currentJournal?: RepairJournal;
  currentAudit?: RepairAudit;
} {
  const state: {
    deps: RepairExecutionDeps;
    events: string[];
    currentJournal?: RepairJournal;
    currentAudit?: RepairAudit;
  } = { events: [] } as never;
  const inventory = recoveryInventory();
  const plan: RepairPlan = {
    schemaVersion: 1,
    authorization: "none",
    action,
    inventoryDigest,
    configuredStateScopeDigest: inventory.configuredStateScopeDigest,
    status: "ready",
    reason: "ready",
    detail: "Ready.",
    recoveryCommands: [],
    repairPlanDigest: planDigest,
  };
  const audit = (status: RepairAudit["status"]): RepairAudit => ({
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000004",
    action,
    planDigest,
    inventoryDigest,
    status,
    errorCodes: [],
    recoveryCommands: [],
    createdAt: now,
    updatedAt: now,
  });
  state.deps = {
    inspectInventory: vi.fn(async () => {
      state.events.push("inspect");
      return inventory;
    }),
    derivePlan: vi.fn(() => plan),
    journal: {
      findIncomplete: vi.fn(async () =>
        state.currentJournal?.phase === "completed" ? undefined : state.currentJournal,
      ),
      findByAuditId: vi.fn(async (auditId) =>
        state.currentJournal?.auditId === auditId ? state.currentJournal : undefined,
      ),
      write: vi.fn(async (value) => {
        state.currentJournal = value;
        state.events.push(`journal-${value.phase}`);
      }),
      withLock: async (run) => {
        state.events.push("repair-lock");
        return run();
      },
    },
    audit: {
      findInProgress: vi.fn(async () =>
        state.currentAudit?.status === "in-progress" ? state.currentAudit : undefined,
      ),
      read: vi.fn(async () => state.currentAudit ?? audit("in-progress")),
      start: vi.fn(async () => {
        state.events.push("audit-start");
        state.currentAudit = audit("in-progress");
        return state.currentAudit;
      }),
      finalize: vi.fn(async (current, update) => {
        state.events.push(`audit-${update.status}`);
        state.currentAudit = { ...current, ...update };
        return state.currentAudit;
      }),
    },
    updateReapJournal: { withLock: async (run) => run() },
    backup: {
      create: vi.fn(async () => {
        state.events.push("backup");
        return backup;
      }),
    },
    authorizeTerminal: vi.fn(async () => {
      throw new Error("Unexpected terminal authorization.");
    }),
    reapTerminal: vi.fn(async () => {
      throw new Error("Unexpected terminal reap.");
    }),
    cleanupObserver: vi.fn(async () => {
      state.events.push("cleanup");
    }),
    resumeRecovery: vi.fn(async () => {
      state.events.push("resume");
    }),
    pruneRecovery: vi.fn(async () => {
      state.events.push("prune");
    }),
    verify: vi.fn(async () => true),
    now: () => now,
    journalId: () => "00000000-0000-4000-8000-000000000005",
  };
  return state;
}

function recoveryInventory(): RepairInventory {
  return {
    schemaVersion: 1,
    configuredStateScopeDigest: "e".repeat(64),
    runtime: {
      status: "unavailable",
      error: {
        tag: "Unavailable",
        code: "UNAVAILABLE",
        message: "Unavailable.",
      },
    },
    recovery: {
      status: "available",
      assessment: {
        schemaVersion: 1,
        inventory: { schemaVersion: 1, sessions: [], recoveryHandles: [] },
        resumeEnabled: true,
        providerCapabilities: [],
        sessions: [],
      },
      recoveryInventoryDigest: recoveryDigest,
    },
    repairInventoryDigest: inventoryDigest,
  };
}

function journal(
  action: RepairAction,
  phase: RepairJournal["phase"],
  recoveryBackup?: RepairBackup,
): RepairJournal {
  return {
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000005",
    auditId: "00000000-0000-4000-8000-000000000004",
    planDigest,
    inventoryDigest,
    configuredStateScopeDigest: "e".repeat(64),
    action,
    phase,
    ...(recoveryBackup === undefined ? {} : { backup: recoveryBackup }),
    createdAt: now,
    updatedAt: now,
  };
}

function terminalTarget(): UpdateReapJournalTarget {
  return {
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
    recovery: { kind: "non-resumable" },
  };
}

function repairAudit(action: RepairAction, status: RepairAudit["status"]): RepairAudit {
  return {
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000004",
    action,
    planDigest,
    inventoryDigest,
    status,
    errorCodes: [],
    recoveryCommands: [],
    createdAt: now,
    updatedAt: now,
  };
}
