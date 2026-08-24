import {
  UpdateReapRecoveryPreflightSchema,
  UpdateReapTerminalDispositionSchema,
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
  });

  it.each([
    {
      name: "recoverable recovery with a blocking reason",
      value: { ...preflight.terminalDispositions[0], reasons: ["session_non_resumable"] },
    },
    {
      name: "non-resumable recovery with an unknown reason",
      value: {
        ...preflight.terminalDispositions[0],
        reapRecovery: "non-resumable",
        reasons: ["session_recovery_unknown"],
      },
    },
    {
      name: "unknown recovery with a non-resumable reason",
      value: {
        ...preflight.terminalDispositions[0],
        reapRecovery: "unknown",
        reasons: ["session_non_resumable"],
      },
    },
    {
      name: "unknown handoff without its reason",
      value: { ...preflight.terminalDispositions[0], handoff: "unknown" },
    },
    {
      name: "known handoff with an unknown-handoff reason",
      value: { ...preflight.terminalDispositions[0], reasons: ["handoff_support_unknown"] },
    },
  ])("rejects $name", ({ value }) => {
    expect(UpdateReapTerminalDispositionSchema.safeParse(value).success).toBe(false);
  });

  it("binds normalized handoff and auxiliary recovery facts to Host evidence", () => {
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        terminalDispositions: [{ ...preflight.terminalDispositions[0], handoff: "preservable" }],
      }).success,
    ).toBe(false);

    const auxiliaryHost = {
      ...preflight.host,
      terminals: [{ ...preflight.host.terminals[0], kind: "aux" as const }],
    };
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({ ...preflight, host: auxiliaryHost }).success,
    ).toBe(false);
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        host: auxiliaryHost,
        terminalDispositions: [
          {
            ...preflight.terminalDispositions[0],
            reapRecovery: "non-resumable",
            reasons: ["session_non_resumable"],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      UpdateReapRecoveryPreflightSchema.safeParse({
        ...preflight,
        terminalDispositions: [
          {
            ...preflight.terminalDispositions[0],
            reapRecovery: "non-resumable",
            reasons: ["aux_terminal_not_resumable"],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
