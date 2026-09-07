import {
  type ObserverRecoveryAssessment,
  projectUpdateRecoveryAssessment,
  type UpdateReapRecoveryPreflight,
  UpdateReapRecoveryPreflightSchema,
  updateReapEvidenceIsComplete,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const preflight = {
  schemaVersion: 1 as const,
  boundary: {
    authorization: "none" as const,
    actions: "not-included" as const,
    digest: "not-included" as const,
  },
  installed: { version: "1.0.0", revision: "installed-revision" },
  target: { version: "1.1.0", revision: "target-revision" },
  observer: {
    status: "exact" as const,
    buildVersion: "1.0.0+station.observer",
    relation: "different" as const,
    health: "healthy" as const,
    recovery: {
      status: "assessed" as const,
      assessment: {
        schemaVersion: 1 as const,
        resumeEnabled: true,
        providerCapabilities: [{ provider: "codex", status: "enabled" as const }],
        sessions: [
          {
            sessionId: "session-a",
            projectId: "project-a",
            worktreeId: "worktree-a",
            lifecycle: "open" as const,
            harnessProvider: "codex",
            disposition: "recoverable" as const,
            reasons: [],
            handleResolution: {
              kind: "selected" as const,
              eligibleHandleCount: 1,
              rejectedHandleCount: 0,
              rejectedReasons: [],
            },
          },
        ],
      },
    },
  },
  host: {
    status: "inspected" as const,
    buildVersion: "1.0.0+station.host",
    buildIdentity: "a".repeat(64),
    protocolVersion: 8,
    relation: "different" as const,
    compatibility: "replace" as const,
    terminals: [
      {
        kind: "agent" as const,
        terminalTargetId: "terminal-a",
        ptyId: "pty-a",
        ptyInstanceId: "pty-instance-a",
        projectId: "project-a",
        worktreeId: "worktree-a",
        sessionId: "session-a",
        harnessProvider: "codex",
        alive: true,
        handoffSupport: "non-releasable" as const,
      },
    ],
  },
  hookProviderIds: ["codex"],
  hooks: [{ provider: "codex", status: "healthy" as const }],
  parkedBridges: {
    status: "assessed" as const,
    totalParkedCount: 0,
    unownedParkedCount: 0,
    adoptionRequiredCount: 0,
  },
  terminalDispositions: [
    {
      terminalTargetId: "terminal-a",
      ptyId: "pty-a",
      ptyInstanceId: "pty-instance-a",
      sessionId: "session-a",
      handoff: "non-preservable" as const,
      reapRecovery: "recoverable" as const,
      reasons: [],
    },
  ],
  evidenceComplete: true,
};

describe("UpdateReapRecoveryPreflightSchema", () => {
  it("strictly parses deterministic, facts-only recovery evidence", () => {
    expect(UpdateReapRecoveryPreflightSchema.parse(preflight)).toEqual(preflight);
    expect(updateReapEvidenceIsComplete(preflight)).toBe(true);
  });

  it("excludes only named unknown sessions without changing the schema invariant", () => {
    const input = withUnknownSession();
    const original = structuredClone(input);
    expect(updateReapEvidenceIsComplete(input)).toBe(false);
    expect(
      updateReapEvidenceIsComplete(input, { excludedSessionIds: new Set(["session-a"]) }),
    ).toBe(false);
    expect(
      updateReapEvidenceIsComplete(input, { excludedSessionIds: new Set(["session-z"]) }),
    ).toBe(true);
    expect(UpdateReapRecoveryPreflightSchema.safeParse(input).success).toBe(true);
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({ ...input, evidenceComplete: true }).success,
    ).toBe(false);
    expect(input).toEqual(original);
  });

  it.each([
    "observer",
    "host",
    "host-handoff",
    "hook-coverage",
    "hook-inspection",
    "parked",
    "terminal-handoff",
    "terminal-recovery",
  ])("never excludes incomplete %s evidence", (change) => {
    const input = withUnknownSession();
    const error = { tag: "TestError", code: "UNKNOWN", message: "Unavailable." };
    if (change === "observer") input.observer = { status: "absent" };
    if (change === "host") input.host = { status: "unknown", reason: "inspection-failed", error };
    if (change === "host-handoff" && input.host.status === "inspected") {
      const terminal = input.host.terminals[0];
      if (terminal === undefined) throw new Error("Expected terminal");
      terminal.handoffSupport = "unknown";
    }
    if (change === "hook-coverage") input.hooks = [];
    if (change === "hook-inspection")
      input.hooks = [
        {
          provider: "codex",
          status: "inspection-failed",
          error,
          followUp: { action: "run-doctor" },
        },
      ];
    if (change === "parked") input.parkedBridges = { status: "unknown", error };
    const disposition = input.terminalDispositions[0];
    if (disposition === undefined) throw new Error("Expected disposition");
    if (change === "terminal-handoff") disposition.handoff = "unknown";
    if (change === "terminal-recovery") disposition.reapRecovery = "unknown";
    expect(
      updateReapEvidenceIsComplete(input, { excludedSessionIds: new Set(["session-z"]) }),
    ).toBe(false);
  });

  it("projects the private assessment without leaking handles, adding absent fields, or mutating input", () => {
    const assessment: ObserverRecoveryAssessment = {
      ...structuredClone(preflight.observer.recovery.assessment),
      inventory: { schemaVersion: 1, sessions: [], recoveryHandles: [] },
      sessions: preflight.observer.recovery.assessment.sessions.map((session) => ({
        ...session,
        handleResolution: { ...session.handleResolution, selectedHandleId: "private-handle" },
      })),
    };
    const session = assessment.sessions[0];
    if (session === undefined) throw new Error("Expected session");
    delete session.harnessProvider;
    const original = structuredClone(assessment);
    const projection = projectUpdateRecoveryAssessment(assessment);
    expect(projection).not.toHaveProperty("inventory");
    expect(projection.sessions[0]).not.toHaveProperty("harnessProvider");
    expect(projection.sessions[0]?.handleResolution).toEqual({
      kind: "selected",
      eligibleHandleCount: 1,
      rejectedHandleCount: 0,
      rejectedReasons: [],
    });
    expect(JSON.stringify(projection)).not.toContain("private-handle");
    expect(assessment).toEqual(original);
  });

  it("rejects action authorization, raw evidence, and inconsistent completeness", () => {
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        actions: [{ kind: "reap" }],
      }).success,
    ).toBe(false);
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        host: {
          ...preflight.host,
          terminals: [{ ...preflight.host.terminals[0], argv: ["secret"] }],
        },
      }).success,
    ).toBe(false);
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({ ...preflight, evidenceComplete: false })
        .success,
    ).toBe(false);
  });

  it("requires exact current Host build and protocol evidence", () => {
    const { buildIdentity: _omitted, ...missingIdentity } = preflight.host;
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        host: missingIdentity,
      }).success,
    ).toBe(false);
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        host: { ...preflight.host, protocolVersion: 7 },
      }).success,
    ).toBe(false);
  });

  it("rejects missing or mismatched hook coverage and terminal ownership", () => {
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        hookProviderIds: [],
        hooks: [],
      }).success,
    ).toBe(false);
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        hooks: [{ provider: "claude", status: "healthy" }],
      }).success,
    ).toBe(false);
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        terminalDispositions: [
          { ...preflight.terminalDispositions[0], sessionId: "different-session" },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires bounded parked-bridge counts and fails closed on unknown viability", () => {
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        parkedBridges: {
          status: "assessed",
          totalParkedCount: 1,
          unownedParkedCount: 2,
          adoptionRequiredCount: 2,
        },
      }).success,
    ).toBe(false);
    const unknown = {
      ...preflight,
      parkedBridges: {
        status: "unknown" as const,
        reason: "inspection-failed" as const,
        error: { tag: "UpdatePreflightError", code: "PARKED_UNKNOWN", message: "Unavailable." },
      },
      evidenceComplete: false,
    };
    expect(UpdateReapRecoveryPreflightSchema.parse(unknown)).toEqual(unknown);
    expect(updateReapEvidenceIsComplete(unknown)).toBe(false);
  });
});

function withUnknownSession(): UpdateReapRecoveryPreflight {
  const input: UpdateReapRecoveryPreflight = structuredClone(preflight);
  if (input.observer.status !== "exact" || input.observer.recovery.status !== "assessed")
    throw new Error("Expected assessment");
  input.observer.recovery.assessment.sessions.push({
    sessionId: "session-z",
    projectId: "project-z",
    worktreeId: "worktree-z",
    lifecycle: "open",
    disposition: "unknown",
    reasons: ["worktree_evidence_missing"],
    handleResolution: { kind: "unknown", reasons: ["worktree_evidence_missing"] },
  });
  input.evidenceComplete = false;
  return input;
}
