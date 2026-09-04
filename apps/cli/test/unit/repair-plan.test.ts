import type { RepairInventory } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { deriveRepairPlan } from "../../src/repair/plan.js";

const now = "2026-09-04T12:00:00.000Z";
const digest = "a".repeat(64);

describe("repair plan", () => {
  it("commits exact action, inventory, and configured-state scope", () => {
    const inventory = recoveryInventory();
    const resume = deriveRepairPlan(inventory, {
      kind: "recovery-resume",
      recoveryHandleId: "handle-1",
    });
    const prune = deriveRepairPlan(inventory, {
      kind: "recovery-prune",
      recoveryHandleId: "handle-1",
    });
    expect(resume).toMatchObject({
      authorization: "none",
      status: "ready",
      action: {
        kind: "recovery-resume",
        recoveryHandleId: "handle-1",
        sessionId: "session-1",
      },
    });
    expect(resume.repairPlanDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(prune.repairPlanDigest).not.toBe(resume.repairPlanDigest);
    expect(
      deriveRepairPlan(
        { ...inventory, configuredStateScopeDigest: "b".repeat(64) },
        { kind: "recovery-resume", recoveryHandleId: "handle-1" },
      ).repairPlanDigest,
    ).not.toBe(resume.repairPlanDigest);
  });

  it("refuses missing, unbound, and mismatched recovery handles", () => {
    const inventory = recoveryInventory();
    expect(
      deriveRepairPlan(inventory, {
        kind: "recovery-prune",
        recoveryHandleId: "missing",
      }).reason,
    ).toBe("recovery-handle-not-found");
    const selectedHandle = inventory.recovery.assessment.inventory.recoveryHandles[0];
    if (selectedHandle === undefined) throw new Error("Expected recovery handle fixture.");
    const { sessionId: _sessionId, ...unboundHandle } = selectedHandle;
    inventory.recovery = {
      ...inventory.recovery,
      assessment: {
        ...inventory.recovery.assessment,
        inventory: {
          ...inventory.recovery.assessment.inventory,
          recoveryHandles: [unboundHandle],
        },
      },
    } as RepairInventory["recovery"];
    expect(
      deriveRepairPlan(inventory, {
        kind: "recovery-prune",
        recoveryHandleId: "handle-1",
      }).reason,
    ).toBe("recovery-handle-unbound");

    const ineligible = recoveryInventory();
    const assessment = ineligible.recovery.assessment.sessions[0];
    if (assessment === undefined) throw new Error("Expected recovery assessment fixture.");
    ineligible.recovery.assessment.sessions[0] = {
      ...assessment,
      disposition: "non-resumable",
      reasons: ["global_resume_disabled"],
    };
    expect(
      deriveRepairPlan(ineligible, {
        kind: "recovery-prune",
        recoveryHandleId: "handle-1",
      }).reason,
    ).toBe("recovery-handle-ineligible");
  });

  it("plans an explicitly imported bound handle without a local session", () => {
    const inventory = recoveryInventory();
    if (inventory.recovery.status !== "available") throw new Error("Expected recovery inventory.");
    inventory.recovery.assessment = {
      ...inventory.recovery.assessment,
      inventory: { ...inventory.recovery.assessment.inventory, sessions: [] },
      sessions: [],
    };

    for (const kind of ["recovery-resume", "recovery-prune"] as const) {
      expect(deriveRepairPlan(inventory, { kind, recoveryHandleId: "handle-1" })).toMatchObject({
        status: "ready",
        action: {
          kind,
          recoveryHandleId: "handle-1",
          sessionId: "session-1",
          provider: "codex",
        },
      });
    }

    const [importedHandle] = inventory.recovery.assessment.inventory.recoveryHandles;
    if (importedHandle === undefined) throw new Error("Expected imported recovery handle.");
    inventory.recovery.assessment.inventory.recoveryHandles.push({
      ...importedHandle,
      id: "handle-2",
      observedAt: "2026-09-04T12:01:00.000Z",
      lastSeenAt: "2026-09-04T12:01:00.000Z",
    });
    expect(
      deriveRepairPlan(inventory, {
        kind: "recovery-resume",
        recoveryHandleId: "handle-1",
      }).reason,
    ).toBe("recovery-handle-ineligible");
    expect(
      deriveRepairPlan(inventory, {
        kind: "recovery-resume",
        recoveryHandleId: "handle-2",
      }).status,
    ).toBe("ready");

    inventory.recovery.assessment.providerCapabilities = [
      { provider: "codex", status: "disabled" },
    ];
    expect(
      deriveRepairPlan(inventory, {
        kind: "recovery-resume",
        recoveryHandleId: "handle-1",
      }).reason,
    ).toBe("recovery-handle-ineligible");
  });

  it("previews one live terminal and refuses an unknown recovery disposition", () => {
    const inventory = terminalInventory();
    expect(
      deriveRepairPlan(inventory, {
        kind: "terminal-reap",
        terminalTargetId: "terminal-1",
      }),
    ).toMatchObject({ status: "ready", reason: "ready" });
    const withoutBackupInventory: RepairInventory = {
      ...inventory,
      recovery: {
        status: "unavailable",
        error: { tag: "Unavailable", code: "UNAVAILABLE", message: "Unavailable." },
      },
    };
    expect(
      deriveRepairPlan(withoutBackupInventory, {
        kind: "terminal-reap",
        terminalTargetId: "terminal-1",
      }).reason,
    ).toBe("recovery-unavailable");
    const runtime = inventory.runtime;
    if (runtime.status !== "available") throw new Error("Expected runtime fixture.");
    const terminal = runtime.preflight.terminalDispositions[0];
    if (terminal === undefined) throw new Error("Expected terminal fixture.");
    runtime.preflight.terminalDispositions[0] = {
      ...terminal,
      reapRecovery: "unknown",
      reasons: ["session_recovery_unknown"],
    };
    expect(
      deriveRepairPlan(inventory, {
        kind: "terminal-reap",
        terminalTargetId: "terminal-1",
      }).reason,
    ).toBe("terminal-recovery-unknown");
  });
});

function recoveryInventory(): RepairInventory {
  return {
    schemaVersion: 1,
    configuredStateScopeDigest: digest,
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
      recoveryInventoryDigest: "c".repeat(64),
      assessment: {
        schemaVersion: 1,
        resumeEnabled: true,
        providerCapabilities: [{ provider: "codex", status: "enabled" }],
        inventory: {
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
          recoveryHandles: [
            {
              id: "handle-1",
              provider: "codex",
              projectId: "project-1",
              worktreeId: "worktree-1",
              sessionId: "session-1",
              targetKind: "native-session",
              observedAt: now,
              lastSeenAt: now,
            },
          ],
        },
        sessions: [
          {
            sessionId: "session-1",
            projectId: "project-1",
            worktreeId: "worktree-1",
            lifecycle: "open",
            harnessProvider: "codex",
            disposition: "recoverable",
            reasons: [],
            handleResolution: {
              kind: "selected",
              selectedHandleId: "handle-1",
              eligibleHandleCount: 1,
              rejectedHandleCount: 0,
              rejectedReasons: [],
            },
          },
        ],
      },
    },
    repairInventoryDigest: "d".repeat(64),
  };
}

function terminalInventory(): RepairInventory {
  const inventory = recoveryInventory();
  return {
    ...inventory,
    runtime: {
      status: "available",
      preflight: {
        schemaVersion: 1,
        boundary: {
          authorization: "none",
          actions: "not-included",
          digest: "not-included",
        },
        installed: { version: "1.0.0" },
        target: { version: "1.0.0" },
        observer: { status: "absent" },
        host: {
          status: "inspected",
          buildVersion: "1.0.0",
          buildIdentity: "e".repeat(64),
          protocolVersion: 8,
          relation: "matching-target",
          compatibility: "reuse",
          terminals: [
            {
              kind: "agent",
              terminalTargetId: "terminal-1",
              ptyId: "pty-1",
              ptyInstanceId: "instance-1",
              projectId: "project-1",
              worktreeId: "worktree-1",
              sessionId: "session-1",
              harnessProvider: "codex",
              alive: true,
              handoffSupport: "non-releasable",
            },
          ],
        },
        hookProviderIds: [],
        hooks: [],
        terminalDispositions: [
          {
            terminalTargetId: "terminal-1",
            ptyId: "pty-1",
            ptyInstanceId: "instance-1",
            sessionId: "session-1",
            handoff: "non-preservable",
            reapRecovery: "non-resumable",
            reasons: ["aux_terminal_not_resumable"],
          },
        ],
        parkedBridges: {
          status: "assessed",
          totalParkedCount: 0,
          unownedParkedCount: 0,
          adoptionRequiredCount: 0,
        },
        evidenceComplete: true,
      },
    },
  };
}
