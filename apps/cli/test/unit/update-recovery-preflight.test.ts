import type {
  ProviderHookHealth,
  UpdateReapHostEvidence,
  UpdateReapObserverEvidence,
  UpdateReapRecoveryAssessment,
} from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  runUpdateRecoveryPreflight,
  type UpdateRecoveryPreflightPorts,
} from "../../src/update/recoveryPreflight";

describe("runUpdateRecoveryPreflight", () => {
  it("reports a matching target with no live runtime without inferring persisted recovery", async () => {
    const readHookHealth = vi.fn(async () => ({ provider: "codex", status: "healthy" as const }));
    const result = await runUpdateRecoveryPreflight({
      installed: { version: "1.1.0", revision: "same-build" },
      target: { version: "1.1.0", revision: "same-build" },
      ports: {
        inspectObserver: async () => ({ status: "absent" }),
        inspectHost: async () => ({ status: "absent" }),
        hookProviderIds: ["codex"],
        readHookHealth,
      },
    });

    expect(result).toMatchObject({
      boundary: {
        authorization: "none",
        actions: "not-included",
        digest: "not-included",
      },
      installed: { version: "1.1.0", revision: "same-build" },
      target: { version: "1.1.0", revision: "same-build" },
      observer: { status: "absent" },
      host: { status: "absent" },
      hooks: [{ provider: "codex", status: "healthy" }],
      terminalDispositions: [],
      evidenceComplete: false,
    });
    expect(readHookHealth).toHaveBeenCalledOnce();
  });

  it("settles and composes every canonical terminal with retained-session recovery", async () => {
    const observer = observerEvidence(
      assessment([
        sessionAssessment("session-a", "recoverable", []),
        sessionAssessment("session-z", "non-resumable", ["global_resume_disabled"]),
      ]),
    );
    const host = hostEvidence([
      terminal("terminal-a", "session-a", "non-releasable"),
      terminal("terminal-missing", "session-missing", "non-releasable"),
      terminal("terminal-z", "session-z", "bridge-releasable"),
    ]);
    const readHookHealth = vi.fn(
      async (provider: string): Promise<ProviderHookHealth> =>
        provider === "codex"
          ? { provider, status: "needs-repair", reason: "owned-drift" }
          : { provider, status: "healthy" },
    );

    const result = await runUpdateRecoveryPreflight({
      installed: { version: "1.0.0" },
      target: { version: "1.1.0" },
      ports: {
        inspectObserver: async () => observer,
        inspectHost: async () => host,
        hookProviderIds: ["claude"],
        readHookHealth,
      },
    });

    expect(readHookHealth.mock.calls.map(([provider]) => provider)).toEqual(["claude", "codex"]);
    expect(result.hooks.map((hook) => hook.provider)).toEqual(["claude", "codex"]);
    expect(result.terminalDispositions).toMatchObject([
      {
        terminalTargetId: "terminal-a",
        handoff: "non-preservable",
        reapRecovery: "recoverable",
        reasons: [],
      },
      {
        terminalTargetId: "terminal-missing",
        handoff: "non-preservable",
        reapRecovery: "non-resumable",
        reasons: ["retained_session_missing"],
      },
      {
        terminalTargetId: "terminal-z",
        handoff: "preservable",
        reapRecovery: "non-resumable",
        reasons: ["session_non_resumable"],
      },
    ]);
    expect(result.evidenceComplete).toBe(true);
  });

  it("reports every throwing source with redacted SafeErrors in one pass", async () => {
    const ports: UpdateRecoveryPreflightPorts = {
      inspectObserver: async () => {
        throw new Error("secret /private/observer argv --token abc");
      },
      inspectHost: async () => {
        throw new Error("secret /private/host argv");
      },
      hookProviderIds: ["codex"],
      readHookHealth: async () => {
        throw new Error("secret /private/hook/providerData");
      },
    };

    const result = await runUpdateRecoveryPreflight({
      installed: { version: "1.0.0" },
      target: { version: "1.1.0" },
      ports,
    });

    expect(result).toMatchObject({
      observer: {
        status: "unknown",
        reason: "inspection-failed",
        error: { code: "UPDATE_PREFLIGHT_OBSERVER_INSPECTION_FAILED" },
      },
      host: {
        status: "unknown",
        reason: "health-failed",
        error: { code: "UPDATE_PREFLIGHT_HOST_INSPECTION_FAILED" },
      },
      hooks: [
        {
          provider: "codex",
          status: "inspection-failed",
          error: { code: "UPDATE_PREFLIGHT_HOOK_INSPECTION_FAILED" },
        },
      ],
      evidenceComplete: false,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("providerData");
  });

  it("keeps partial runtime evidence and marks terminal consequences unknown", async () => {
    const result = await runUpdateRecoveryPreflight({
      installed: { version: "1.0.0" },
      target: { version: "1.1.0" },
      ports: {
        inspectObserver: async () => ({
          status: "exact",
          buildVersion: "1.0.0",
          relation: "different",
          health: "degraded",
          recovery: {
            status: "unknown",
            reason: "api-unavailable",
            error: {
              tag: "UpdatePreflightError",
              code: "UPDATE_PREFLIGHT_RECOVERY_API_UNAVAILABLE",
              message: "Observer recovery assessment is unavailable.",
            },
          },
        }),
        inspectHost: async () => hostEvidence([terminal("terminal-a", "session-a", "unknown")]),
        hookProviderIds: [],
        readHookHealth: async () => ({ provider: "codex", status: "healthy" }),
      },
    });

    expect(result).toMatchObject({
      observer: { status: "exact", recovery: { status: "unknown" } },
      terminalDispositions: [
        {
          terminalTargetId: "terminal-a",
          handoff: "unknown",
          reapRecovery: "unknown",
          reasons: ["handoff_support_unknown", "session_recovery_unknown"],
        },
      ],
      evidenceComplete: false,
    });
  });

  it("fails closed on hook provider substitution", async () => {
    const result = await runUpdateRecoveryPreflight({
      installed: { version: "1.0.0" },
      target: { version: "1.1.0" },
      ports: {
        inspectObserver: async () => ({ status: "absent" }),
        inspectHost: async () => ({ status: "absent" }),
        hookProviderIds: ["claude"],
        readHookHealth: async () => ({ provider: "codex", status: "healthy" }),
      },
    });

    expect(result.hookProviderIds).toEqual(["claude"]);
    expect(result.hooks).toMatchObject([
      {
        provider: "claude",
        status: "inspection-failed",
        error: { code: "UPDATE_PREFLIGHT_HOOK_INSPECTION_FAILED" },
      },
    ]);
    expect(result.evidenceComplete).toBe(false);
  });

  it("does not treat auxiliary or identity-mismatched terminals as resumable sessions", async () => {
    const observer = observerEvidence(
      assessment([sessionAssessment("session-a", "recoverable", [])]),
    );
    const mismatched = { ...terminal("terminal-agent", "session-a", "bridge-releasable") };
    mismatched.projectId = "project-other";
    const auxiliary = {
      ...terminal("terminal-aux", "session-a", "bridge-releasable"),
      kind: "aux" as const,
    };
    const result = await runUpdateRecoveryPreflight({
      installed: { version: "1.0.0" },
      target: { version: "1.1.0" },
      ports: {
        inspectObserver: async () => observer,
        inspectHost: async () => hostEvidence([mismatched, auxiliary]),
        hookProviderIds: ["codex"],
        readHookHealth: async () => ({ provider: "codex", status: "healthy" }),
      },
    });

    expect(result.terminalDispositions).toMatchObject([
      {
        terminalTargetId: "terminal-agent",
        reapRecovery: "unknown",
        reasons: ["retained_session_identity_mismatch"],
      },
      {
        terminalTargetId: "terminal-aux",
        reapRecovery: "non-resumable",
        reasons: ["aux_terminal_not_resumable"],
      },
    ]);
    expect(result.evidenceComplete).toBe(false);
  });

  it("uses code-unit ordering for provider and terminal evidence", async () => {
    const injectedId = "terminal\n\u001b[31m";
    const result = await runUpdateRecoveryPreflight({
      installed: { version: "1.0.0", revision: "revision\n\u001b]8;;bad" },
      target: { version: "1.1.0" },
      ports: {
        inspectObserver: async () => ({ status: "absent" }),
        inspectHost: async () =>
          hostEvidence([
            terminal("Z", "session-z", "bridge-releasable"),
            terminal("a", "session-a", "bridge-releasable"),
            terminal(injectedId, "session-control", "bridge-releasable"),
          ]),
        hookProviderIds: ["a", "Z"],
        readHookHealth: async (provider) => ({ provider, status: "healthy" }),
      },
    });

    expect(result.hooks.map((hook) => hook.provider)).toEqual(["Z", "a"]);
    expect(result.terminalDispositions.map((terminal) => terminal.terminalTargetId)).toEqual([
      "Z",
      "a",
      injectedId,
    ]);
  });
});

function observerEvidence(value: UpdateReapRecoveryAssessment): UpdateReapObserverEvidence {
  return {
    status: "exact",
    buildVersion: "1.0.0",
    relation: "different",
    health: "healthy",
    recovery: { status: "assessed", assessment: value },
  };
}

function hostEvidence(
  terminals: Extract<UpdateReapHostEvidence, { status: "inspected" }>["terminals"],
): UpdateReapHostEvidence {
  return {
    status: "inspected",
    buildVersion: "1.0.0",
    buildIdentity: "a".repeat(64),
    protocolVersion: 8,
    relation: "different",
    compatibility: "replace",
    terminals,
  };
}

function terminal(
  terminalTargetId: string,
  sessionId: string,
  handoffSupport: "bridge-releasable" | "non-releasable" | "unknown",
) {
  return {
    kind: "agent" as const,
    terminalTargetId,
    ptyId: `pty-${terminalTargetId}`,
    ptyInstanceId: `instance-${terminalTargetId}`,
    projectId: "project-a",
    worktreeId: "worktree-a",
    sessionId,
    harnessProvider: "codex",
    alive: true,
    handoffSupport,
  };
}

function assessment(
  sessions: UpdateReapRecoveryAssessment["sessions"],
): UpdateReapRecoveryAssessment {
  return {
    schemaVersion: 1,
    resumeEnabled: true,
    providerCapabilities: [{ provider: "codex", status: "enabled" }],
    sessions,
  };
}

function sessionAssessment(
  sessionId: string,
  disposition: "recoverable" | "non-resumable",
  reasons: UpdateReapRecoveryAssessment["sessions"][number]["reasons"],
): UpdateReapRecoveryAssessment["sessions"][number] {
  return {
    sessionId,
    projectId: "project-a",
    worktreeId: "worktree-a",
    lifecycle: "open",
    harnessProvider: "codex",
    disposition,
    reasons,
    handleResolution:
      disposition === "recoverable"
        ? {
            kind: "selected",
            eligibleHandleCount: 1,
            rejectedHandleCount: 0,
            rejectedReasons: [],
          }
        : {
            kind: "none",
            eligibleHandleCount: 0,
            rejectedHandleCount: 0,
            reasons: ["no_recovery_handles"],
          },
  };
}
