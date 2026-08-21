import type {
  ObserverRecoveryAssessment,
  ProviderHookHealth,
  UpdateReapHostEvidence,
  UpdateReapObserverEvidence,
} from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  renderUpdateRecoveryPreflight,
  runUpdateRecoveryPreflight,
  type UpdateRecoveryPreflightPorts,
} from "../../src/update/recoveryPreflight";

const now = "2026-08-21T12:00:00.000Z";

describe("runUpdateRecoveryPreflight", () => {
  it("settles, sorts, and composes every terminal with retained-session recovery", async () => {
    const observer = observerEvidence(
      assessment([
        sessionAssessment("session-a", "recoverable", []),
        sessionAssessment("session-z", "non-resumable", ["global_resume_disabled"]),
      ]),
    );
    const host = hostEvidence([
      terminal("terminal-z", "session-z", "bridge-releasable"),
      terminal("terminal-missing", "session-missing", "non-releasable"),
      terminal("terminal-a", "session-a", "non-releasable"),
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
    const text = renderUpdateRecoveryPreflight(result);
    expect(text).toContain("reapRecovery=NON-RESUMABLE");
    expect(text).toContain("session-z: NON-RESUMABLE");
    expect(text).toContain("actions: not included (#640)");
    expect(text).not.toContain("/private/worktree");
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
});

function observerEvidence(value: ObserverRecoveryAssessment): UpdateReapObserverEvidence {
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

function assessment(sessions: ObserverRecoveryAssessment["sessions"]): ObserverRecoveryAssessment {
  return {
    schemaVersion: 1,
    inventory: {
      schemaVersion: 1,
      sessions: sessions.map((session) => ({
        id: session.sessionId,
        projectId: session.projectId,
        worktreeId: session.worktreeId,
        lifecycle: session.lifecycle,
        harnessProvider: "codex",
        createdAt: now,
        lastSeenAt: now,
      })),
      recoveryHandles: sessions.flatMap((session) =>
        session.handleResolution.kind === "selected"
          ? [
              {
                id: session.handleResolution.selectedHandleId,
                provider: "codex",
                projectId: session.projectId,
                worktreeId: session.worktreeId,
                sessionId: session.sessionId,
                targetKind: "native-session" as const,
                observedAt: now,
                lastSeenAt: now,
              },
            ]
          : [],
      ),
    },
    resumeEnabled: true,
    providerCapabilities: [{ provider: "codex", status: "enabled" }],
    sessions,
  };
}

function sessionAssessment(
  sessionId: string,
  disposition: "recoverable" | "non-resumable",
  reasons: ObserverRecoveryAssessment["sessions"][number]["reasons"],
): ObserverRecoveryAssessment["sessions"][number] {
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
            selectedHandleId: `handle-${sessionId}`,
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
