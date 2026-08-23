import type { UpdateReapRecoveryPreflight } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { planUpdateConvergence } from "../../src/update/convergencePlan.js";

const buildIdentity = "a".repeat(64);
const artifact = { version: "1.0.0", revision: "revision-1" };

describe("update convergence planning policy", () => {
  it.each([
    {
      name: "no runtime starts Observer despite irrelevant incomplete recovery evidence",
      preflight: preflight(),
      expected: ["actionable", "start", "no-op"],
    },
    {
      name: "healthy matching runtime is converged",
      preflight: preflight({ observer: matchingObserver(), host: matchingHost() }),
      expected: ["converged", "no-op", "no-op"],
    },
    {
      name: "unhealthy matching Observer restarts",
      preflight: preflight({
        observer: matchingObserver("degraded"),
        host: matchingHost(),
      }),
      expected: ["actionable", "restart", "no-op"],
    },
    {
      name: "old Observer restarts",
      preflight: preflight({ observer: differentObserver(), host: matchingHost() }),
      expected: ["actionable", "restart", "no-op"],
    },
    {
      name: "installed executable drift uses the health-pinned explicit Observer restart",
      preflight: preflight({ observer: restartableObserverDrift(), host: matchingHost() }),
      expected: ["actionable", "restart", "no-op"],
    },
    {
      name: "old idle Host is replaced",
      preflight: preflight({ observer: matchingObserver(), host: differentHost([]) }),
      expected: ["actionable", "no-op", "replace-idle"],
    },
    {
      name: "old busy bridge Host uses handoff without recovery handle evidence",
      preflight: preflight({
        observer: matchingObserver("healthy", "unknown"),
        host: differentHost([terminal("bridge-releasable")]),
        terminalDispositions: [disposition("preservable", "unknown")],
      }),
      expected: ["actionable", "no-op", "handoff"],
    },
    {
      name: "old busy non-bridge Host emits reap-required only with complete consequences",
      preflight: preflight({
        observer: matchingObserver(),
        host: differentHost([terminal("non-releasable")]),
        terminalDispositions: [disposition("non-preservable", "non-resumable")],
      }),
      expected: ["reap-required", "no-op", "await-reap"],
    },
    {
      name: "unknown destructive recovery consequence blocks reap-required",
      preflight: preflight({
        observer: matchingObserver("healthy", "unknown"),
        host: differentHost([terminal("non-releasable")]),
        terminalDispositions: [disposition("non-preservable", "unknown")],
      }),
      expected: ["blocked", "no-op", "blocked"],
    },
    {
      name: "unknown Observer identity blocks only the Observer decision",
      preflight: preflight({
        observer: {
          status: "unknown",
          reason: "identity-unavailable",
          error: { tag: "UpdatePreflightError", code: "OBSERVER_UNKNOWN", message: "Unknown." },
        },
        host: matchingHost(),
      }),
      expected: ["blocked", "blocked", "no-op"],
    },
    {
      name: "unknown Host inventory blocks Host and terminal decisions",
      preflight: preflight({
        observer: matchingObserver(),
        host: {
          status: "unknown",
          reason: "inventory-failed",
          error: { tag: "UpdatePreflightError", code: "HOST_UNKNOWN", message: "Unknown." },
        },
      }),
      expected: ["blocked", "no-op", "blocked"],
    },
    {
      name: "auxiliary PTYs require reap when they cannot hand off",
      preflight: preflight({
        observer: matchingObserver(),
        host: differentHost([terminal("non-releasable", "aux")]),
        terminalDispositions: [disposition("non-preservable", "non-resumable")],
      }),
      expected: ["reap-required", "no-op", "await-reap"],
    },
  ])("$name", ({ preflight: evidence, expected }) => {
    const result = evaluate(evidence);
    expect([
      result.status,
      result.components.observer.action,
      result.components.host.action,
    ]).toEqual(expected);
  });

  it.each([
    {
      admission: "candidate-wins" as const,
      expected: { status: "actionable", action: "restart", reason: "different-build" },
    },
    {
      admission: "incumbent-wins" as const,
      expected: { status: "blocked", action: "blocked", reason: "singleton-refused" },
    },
    {
      admission: "refused" as const,
      expected: { status: "blocked", action: "blocked", reason: "singleton-refused" },
    },
  ])("applies exact singleton admission $admission independently from different-build relation", ({
    admission,
    expected,
  }) => {
    const result = evaluate(
      preflight({ observer: differentObserver(admission), host: matchingHost() }),
    );
    expect({
      status: result.status,
      action: result.components.observer.action,
      reason: result.components.observer.reason,
    }).toEqual(expected);
  });

  it("assigns an uninstalled target Observer to successor reinspection without restart authority", () => {
    const evidence = preflight({
      observer: differentObserver("not-yet-provable"),
    });
    evidence.installed = { version: "0.9.0", revision: "revision-0" };
    const result = planUpdateConvergence({
      selectedTarget: { artifact, buildIdentity: { status: "not-yet-provable" } },
      artifactAction: "apply",
      preflight: evidence,
    });

    expect(result).toMatchObject({
      status: "actionable",
      components: {
        observer: { action: "reinspect", reason: "target-artifact-may-change" },
      },
      phases: expect.arrayContaining([
        {
          id: "observer-convergence",
          action: "reinspect",
          reason: "target-artifact-may-change",
        },
      ]),
    });
  });

  it.each([
    {
      name: "unknown runtime evidence",
      preflight: preflight({
        observer: {
          status: "unknown",
          reason: "identity-unavailable",
          error: { tag: "UpdatePreflightError", code: "OBSERVER_UNKNOWN", message: "Unknown." },
        },
      }),
      componentAction: "blocked",
    },
    {
      name: "busy bridge Host evidence",
      preflight: preflight({
        observer: matchingObserver(),
        host: differentHost([terminal("bridge-releasable")]),
        terminalDispositions: [disposition("preservable", "recoverable")],
      }),
      componentAction: "handoff",
    },
    {
      name: "complete reap-required evidence",
      preflight: preflight({
        observer: matchingObserver(),
        host: differentHost([terminal("non-releasable")]),
        terminalDispositions: [disposition("non-preservable", "non-resumable")],
      }),
      componentAction: "await-reap",
    },
  ])("keeps $name visible while artifact deferral controls status", (testCase) => {
    const result = planUpdateConvergence({
      selectedTarget: { artifact, buildIdentity: { status: "known", value: buildIdentity } },
      artifactAction: "defer",
      handoffFidelity: "processes",
      preflight: testCase.preflight,
    });

    expect(result.status).toBe("deferred");
    expect(result.phases[0]).toMatchObject({ id: "artifact-application", action: "defer" });
    expect([result.components.observer.action, result.components.host.action]).toContain(
      testCase.componentAction,
    );
  });

  it("represents explicit no-handoff as an intentionally incomplete non-mutating plan", () => {
    const evidence = preflight({
      observer: matchingObserver(),
      host: differentHost([terminal("bridge-releasable")]),
      terminalDispositions: [disposition("preservable", "recoverable")],
    });
    const result = planUpdateConvergence({
      selectedTarget: { artifact, buildIdentity: { status: "known", value: buildIdentity } },
      artifactAction: "no-op",
      preflight: evidence,
    });
    expect(result.status).toBe("intentionally-incomplete");
    expect(result.components.host.action).toBe("leave-in-place");
  });

  it("requires recovery completeness only when executable drift coexists with destructive reap", () => {
    const bridge = evaluate(
      preflight({
        observer: restartableObserverDrift(),
        host: differentHost([terminal("bridge-releasable")]),
        terminalDispositions: [disposition("preservable", "unknown")],
      }),
    );
    expect(bridge.status).toBe("actionable");
    expect(bridge.components.observer.action).toBe("restart");
    expect(bridge.components.host.action).toBe("handoff");

    const destructive = evaluate(
      preflight({
        observer: restartableObserverDrift(),
        host: differentHost([terminal("non-releasable")]),
        terminalDispositions: [disposition("non-preservable", "unknown")],
      }),
    );
    expect(destructive.status).toBe("blocked");
    expect(destructive.components.observer.action).toBe("restart");
    expect(destructive.components.host).toEqual({
      action: "blocked",
      reason: "recovery-incomplete",
    });
  });

  it("requires recovery only for the exact non-preservable terminals in a mixed inventory", () => {
    const mixed = evaluate(
      preflight({
        observer: matchingObserver(),
        host: differentHost([
          terminal("bridge-releasable", "agent", "1"),
          terminal("non-releasable", "agent", "2"),
        ]),
        terminalDispositions: [
          disposition("preservable", "unknown", "1"),
          disposition("non-preservable", "non-resumable", "2"),
        ],
      }),
    );

    expect(mixed.status).toBe("reap-required");
    expect(mixed.components.host).toEqual({ action: "await-reap", reason: "non-releasable" });
    expect(mixed.components.terminals).toMatchObject({
      action: "reap-required",
      liveCount: 2,
      nonResumableCount: 1,
      unknownRecoveryCount: 1,
    });
    expect(mixed.components.recovery).toEqual({
      relevance: "destructive-follow-up",
      status: "complete",
    });

    const afterNonPreservableReap = evaluate(
      preflight({
        observer: matchingObserver(),
        host: differentHost([terminal("bridge-releasable", "agent", "1")]),
        terminalDispositions: [disposition("preservable", "unknown", "1")],
      }),
    );

    expect(afterNonPreservableReap.status).toBe("actionable");
    expect(afterNonPreservableReap.components.host).toEqual({
      action: "handoff",
      reason: "busy-handoff",
      fidelity: "processes",
    });
    expect(afterNonPreservableReap.components.terminals.fidelity).toBe("processes");
    expect(afterNonPreservableReap.components.recovery).toEqual({
      relevance: "not-required",
      status: "not-required",
    });
  });

  it("blocks unknown handoff evidence even when another terminal has complete reap recovery", () => {
    const result = evaluate(
      preflight({
        observer: matchingObserver(),
        host: differentHost([
          terminal("unknown", "agent", "1"),
          terminal("non-releasable", "agent", "2"),
        ]),
        terminalDispositions: [
          disposition("unknown", "unknown", "1"),
          disposition("non-preservable", "non-resumable", "2"),
        ],
      }),
    );

    expect(result.status).toBe("blocked");
    expect(result.components.host).toEqual({
      action: "blocked",
      reason: "recovery-incomplete",
    });
  });

  it.each([
    {
      name: "missing disposition",
      hostTerminals: [terminal("non-releasable", "agent", "1")],
      dispositions: [],
    },
    {
      name: "duplicate identities",
      hostTerminals: [
        terminal("non-releasable", "agent", "1"),
        terminal("non-releasable", "agent", "1"),
      ],
      dispositions: [
        disposition("non-preservable", "non-resumable", "1"),
        disposition("non-preservable", "non-resumable", "1"),
      ],
    },
    {
      name: "mismatched identity sets",
      hostTerminals: [terminal("non-releasable", "agent", "1")],
      dispositions: [disposition("non-preservable", "non-resumable", "2")],
    },
    {
      name: "mismatched handoff classification",
      hostTerminals: [terminal("bridge-releasable", "agent", "1")],
      dispositions: [disposition("non-preservable", "non-resumable", "1")],
    },
  ])("blocks $name before terminal authorization", (testCase) => {
    const result = evaluate(
      preflight({
        observer: matchingObserver(),
        host: differentHost(testCase.hostTerminals),
        terminalDispositions: testCase.dispositions,
      }),
    );

    expect(result.status).toBe("blocked");
    expect(result.components.host).toEqual({
      action: "blocked",
      reason: "inventory-incomplete",
    });
    expect(result.components.terminals).toMatchObject({
      action: "blocked",
      reason: "inventory-incomplete",
    });
    expect(result.components.recovery).toEqual({
      relevance: "destructive-follow-up",
      status: "incomplete",
    });
  });

  it("makes same-version hook drift actionable and blocks hook ownership uncertainty", () => {
    const drift = evaluate(
      preflight({
        observer: matchingObserver(),
        host: matchingHost(),
        hookProviderIds: ["codex"],
        hooks: [{ provider: "codex", status: "needs-repair", reason: "owned-drift" }],
      }),
    );
    expect(drift.components.hooks).toEqual([
      { provider: "codex", action: "reconcile", reason: "owned-drift" },
    ]);
    expect(drift.status).toBe("actionable");

    const unknown = evaluate(
      preflight({
        observer: matchingObserver(),
        host: matchingHost(),
        hookProviderIds: ["codex"],
        hooks: [
          {
            provider: "codex",
            status: "inspection-failed",
            error: { tag: "UpdatePreflightError", code: "HOOK_UNKNOWN", message: "Unknown." },
            followUp: { action: "run-doctor" },
          },
        ],
      }),
    );
    expect(unknown.status).toBe("blocked");
    expect(unknown.components.hooks[0]?.action).toBe("blocked");
  });
});

function evaluate(evidence: UpdateReapRecoveryPreflight) {
  return planUpdateConvergence({
    selectedTarget: { artifact, buildIdentity: { status: "known", value: buildIdentity } },
    artifactAction: "no-op",
    handoffFidelity: "processes",
    preflight: evidence,
  });
}

function preflight(
  overrides: Partial<UpdateReapRecoveryPreflight> = {},
): UpdateReapRecoveryPreflight {
  return {
    schemaVersion: 2,
    boundary: { authorization: "none", actions: "not-included", digest: "not-included" },
    installed: artifact,
    target: artifact,
    observer: { status: "absent" },
    host: { status: "absent" },
    hookProviderIds: [],
    hooks: [],
    terminalDispositions: [],
    evidenceComplete: false,
    ...overrides,
  };
}

function matchingObserver(
  health: "healthy" | "degraded" | "unavailable" = "healthy",
  recovery: "assessed" | "unknown" = "assessed",
): UpdateReapRecoveryPreflight["observer"] {
  return {
    status: "exact",
    buildVersion: `1.0.0+station.${buildIdentity}`,
    relation: "matching-target",
    replacementAdmission: "exact-build",
    health,
    recovery:
      recovery === "assessed"
        ? {
            status: "assessed",
            assessment: {
              schemaVersion: 1,
              resumeEnabled: true,
              providerCapabilities: [],
              sessions: [],
            },
          }
        : {
            status: "unknown",
            reason: "api-unavailable",
            error: { tag: "UpdatePreflightError", code: "RECOVERY_UNKNOWN", message: "Unknown." },
          },
  };
}

function differentObserver(
  replacementAdmission:
    | "candidate-wins"
    | "incumbent-wins"
    | "refused"
    | "not-yet-provable" = "candidate-wins",
): UpdateReapRecoveryPreflight["observer"] {
  return {
    ...matchingObserver(),
    buildVersion: "0.9.0",
    relation: "different",
    replacementAdmission,
  };
}

function restartableObserverDrift(): UpdateReapRecoveryPreflight["observer"] {
  return {
    status: "unknown",
    reason: "restartable-executable-drift",
    buildVersion: `1.0.0+station.${"a".repeat(64)}`,
    error: {
      tag: "UpdatePreflightError",
      code: "UPDATE_PREFLIGHT_OBSERVER_EXECUTABLE_DRIFT_RESTARTABLE",
      message: "The incumbent is pinned for explicit restart.",
    },
  };
}

function matchingHost(): UpdateReapRecoveryPreflight["host"] {
  return {
    status: "inspected",
    buildVersion: artifact.version,
    buildIdentity,
    protocolVersion: 8,
    relation: "matching-target",
    compatibility: "reuse",
    terminals: [],
  };
}

function differentHost(
  terminals: Extract<UpdateReapRecoveryPreflight["host"], { status: "inspected" }>["terminals"],
): UpdateReapRecoveryPreflight["host"] {
  return {
    status: "inspected",
    buildVersion: "0.9.0",
    buildIdentity: "b".repeat(64),
    protocolVersion: 8,
    relation: "different",
    compatibility: "replace",
    terminals,
  };
}

function terminal(
  handoffSupport: "bridge-releasable" | "non-releasable" | "unknown",
  kind: "agent" | "aux" = "agent",
  identity = "1",
) {
  return {
    kind,
    terminalTargetId: `terminal-${identity}`,
    ptyId: `pty-${identity}`,
    ptyInstanceId: `pty-instance-${identity}`,
    projectId: `project-${identity}`,
    worktreeId: `worktree-${identity}`,
    sessionId: `session-${identity}`,
    harnessProvider: "codex",
    alive: true,
    handoffSupport,
  };
}

function disposition(
  handoff: "preservable" | "non-preservable" | "unknown",
  reapRecovery: "recoverable" | "non-resumable" | "unknown",
  identity = "1",
) {
  const reasons: UpdateReapRecoveryPreflight["terminalDispositions"][number]["reasons"] = [];
  if (handoff === "unknown") reasons.push("handoff_support_unknown");
  if (reapRecovery === "unknown") reasons.push("session_recovery_unknown");
  if (reapRecovery === "non-resumable") reasons.push("session_non_resumable");
  return {
    terminalTargetId: `terminal-${identity}`,
    ptyId: `pty-${identity}`,
    ptyInstanceId: `pty-instance-${identity}`,
    sessionId: `session-${identity}`,
    handoff,
    reapRecovery,
    reasons,
  };
}
