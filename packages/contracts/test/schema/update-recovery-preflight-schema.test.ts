import {
  UpdateReapRecoveryPreflightSchema,
  UpdateReapRecoveryPreflightV1Schema,
  updateReapEvidenceIsComplete,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const preflight = {
  schemaVersion: 2 as const,
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
    replacementAdmission: "not-yet-provable" as const,
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

  it("keeps legacy v1 fieldless admission separate from strict v2 evidence", () => {
    const legacy = {
      ...preflight,
      schemaVersion: 1 as const,
      observer: {
        status: "exact" as const,
        buildVersion: preflight.observer.buildVersion,
        relation: preflight.observer.relation,
        health: preflight.observer.health,
        recovery: preflight.observer.recovery,
      },
    };

    expect(UpdateReapRecoveryPreflightV1Schema.parse(legacy)).toEqual(legacy);
    expect(UpdateReapRecoveryPreflightSchema.safeParse(legacy).success).toBe(false);
    expect(UpdateReapRecoveryPreflightV1Schema.safeParse(preflight).success).toBe(false);
  });

  it("strictly admits restartable installed-executable drift without treating it as complete", () => {
    const restartable = {
      ...preflight,
      observer: {
        status: "unknown" as const,
        reason: "restartable-executable-drift" as const,
        buildVersion: `1.0.0+station.${"a".repeat(64)}`,
        error: {
          tag: "UpdatePreflightError",
          code: "UPDATE_PREFLIGHT_OBSERVER_EXECUTABLE_DRIFT_RESTARTABLE",
          message: "The incumbent is pinned for explicit restart.",
        },
      },
      host: { status: "absent" as const },
      terminalDispositions: [],
      evidenceComplete: false,
    };

    expect(UpdateReapRecoveryPreflightSchema.parse(restartable)).toEqual(restartable);
    expect(updateReapEvidenceIsComplete(restartable)).toBe(false);
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...restartable,
        observer: { ...restartable.observer, buildVersion: undefined },
      }).success,
    ).toBe(false);
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...restartable,
        observer: {
          ...restartable.observer,
          reason: "identity-mismatch",
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["matching-target", "candidate-wins"],
    ["different", "exact-build"],
    ["unknown", "incumbent-wins"],
  ] as const)("rejects contradictory Observer relation %s and replacement admission %s", (relation, replacementAdmission) => {
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        observer: { ...preflight.observer, relation, replacementAdmission },
      }).success,
    ).toBe(false);
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
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        terminalDispositions: [],
        evidenceComplete: false,
      }).success,
    ).toBe(false);
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        host: {
          ...preflight.host,
          terminals: [preflight.host.terminals[0], preflight.host.terminals[0]],
        },
        terminalDispositions: [
          preflight.terminalDispositions[0],
          preflight.terminalDispositions[0],
        ],
        evidenceComplete: false,
      }).success,
    ).toBe(false);
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        terminalDispositions: [
          { ...preflight.terminalDispositions[0], ptyInstanceId: "different-instance" },
        ],
        evidenceComplete: false,
      }).success,
    ).toBe(false);
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        terminalDispositions: [{ ...preflight.terminalDispositions[0], handoff: "preservable" }],
        evidenceComplete: false,
      }).success,
    ).toBe(false);
  });
});
