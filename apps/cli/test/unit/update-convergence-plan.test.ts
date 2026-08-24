import {
  type UpdateConvergencePlanningInput,
  UpdateConvergencePlanningInputSchema,
  UpdateConvergencePlanSchema,
  type UpdateReapRecoveryPreflight,
  UpdateReapRecoveryPreflightSchema,
  updateReapEvidenceIsComplete,
} from "@station/contracts";
import { describe, expect, it } from "vitest";
import { deriveUpdateConvergencePlan } from "../../src/update/convergencePlan.js";

const buildIdentity = "b".repeat(64);
const incumbentBuildIdentity = "a".repeat(64);
const artifact = { version: "1.0.0", revision: "revision-1" };
const observerSelector = `${artifact.version}+station.${buildIdentity}`;

describe("deriveUpdateConvergencePlan", () => {
  it.each([
    {
      name: "no runtime",
      evidence: preflight(),
      expected: ["actionable", "start", "no-op", "no-op"],
    },
    {
      name: "healthy matching runtime",
      evidence: preflight({ observer: matchingObserver(), host: matchingHost() }),
      expected: ["converged", "no-op", "no-op", "no-op"],
    },
    {
      name: "unhealthy matching Observer",
      evidence: preflight({ observer: matchingObserver("degraded"), host: matchingHost() }),
      expected: ["actionable", "restart", "no-op", "no-op"],
    },
    {
      name: "older Observer",
      evidence: preflight({ observer: differentObserver("0.9.0"), host: matchingHost() }),
      expected: ["actionable", "restart", "no-op", "no-op"],
    },
    {
      name: "old idle Host",
      evidence: preflight({ observer: matchingObserver(), host: differentHost([]) }),
      expected: ["actionable", "no-op", "no-op", "replace-idle"],
    },
    {
      name: "old busy bridge-backed Host",
      evidence: preflight({
        observer: matchingObserver("healthy", "unknown"),
        host: differentHost([terminal("bridge-releasable")]),
        terminalDispositions: [disposition("preservable", "unknown")],
      }),
      expected: ["actionable", "no-op", "preserve-via-handoff", "handoff"],
    },
    {
      name: "old busy non-bridge Host",
      evidence: preflight({
        observer: matchingObserver(),
        host: differentHost([terminal("non-releasable")]),
        terminalDispositions: [disposition("non-preservable", "non-resumable")],
      }),
      expected: ["reap-required", "no-op", "reap-required", "await-reap"],
    },
    {
      name: "non-resumable auxiliary terminal",
      evidence: preflight({
        observer: matchingObserver(),
        host: differentHost([terminal("non-releasable", "aux")]),
        terminalDispositions: [
          disposition("non-preservable", "non-resumable", "1", ["aux_terminal_not_resumable"]),
        ],
      }),
      expected: ["reap-required", "no-op", "reap-required", "await-reap"],
    },
  ])("classifies $name", ({ evidence, expected }) => {
    const result = derive(input({ preflight: evidence }));
    expect([
      result.outcome,
      result.phases.observerConvergence.action,
      result.phases.terminalConvergence.action,
      result.phases.hostConvergence.action,
    ]).toEqual(expected);
  });

  it.each([
    {
      name: "idle",
      terminals: [],
      dispositions: [],
      expected: ["actionable", "no-op", "replace-idle"],
    },
    {
      name: "bridge-backed",
      terminals: [terminal("bridge-releasable")],
      dispositions: [disposition("preservable", "non-resumable")],
      expected: ["actionable", "preserve-via-handoff", "handoff"],
    },
    {
      name: "non-bridge",
      terminals: [terminal("non-releasable")],
      dispositions: [disposition("non-preservable", "non-resumable")],
      expected: ["reap-required", "reap-required", "await-reap"],
    },
  ])("treats same-display immutable Host drift as replacement-required for $name inventory", ({
    terminals,
    dispositions,
    expected,
  }) => {
    const result = derive(
      input({
        preflight: preflight({
          observer: matchingObserver(),
          host: sameDisplayDriftHost(terminals),
          terminalDispositions: dispositions,
        }),
      }),
    );
    expect([
      result.outcome,
      result.phases.terminalConvergence.action,
      result.phases.hostConvergence.action,
    ]).toEqual(expected);
  });

  it.each([
    {
      name: "different display",
      host: { ...differentHost([]), compatibility: "reuse" as const },
    },
    {
      name: "missing same-display identity",
      host: {
        status: "inspected" as const,
        buildVersion: artifact.version,
        protocolVersion: 8,
        relation: "different" as const,
        compatibility: "reuse" as const,
        terminals: [],
      },
    },
    {
      name: "self-contradictory exact identity",
      host: { ...sameDisplayDriftHost([]), buildIdentity },
    },
  ])("blocks contradictory reuse/different Host evidence with $name", ({ host }) => {
    const result = derive(input({ preflight: preflight({ observer: matchingObserver(), host }) }));
    expect(result.phases.hostConvergence).toEqual({
      action: "blocked",
      reason: "evidence-contradictory",
    });
  });

  it.each([
    {
      name: "candidate precedes",
      observer: differentObserver("1.0.0", incumbentBuildIdentity),
      expected: { outcome: "actionable", action: "restart", precedence: "candidate-precedes" },
    },
    {
      name: "incumbent precedes",
      observer: differentObserver("2.0.0"),
      expected: { outcome: "blocked", action: "blocked", precedence: "incumbent-precedes" },
    },
    {
      name: "same-version singleton refuses a higher incumbent selector",
      observer: differentObserver("1.0.0", "c".repeat(64)),
      expected: { outcome: "blocked", action: "blocked", precedence: "refused" },
    },
  ])("applies Observer build precedence when $name", ({ observer, expected }) => {
    const result = derive(input({ preflight: preflight({ observer, host: matchingHost() }) }));
    expect({ outcome: result.outcome, ...result.phases.observerConvergence }).toMatchObject(
      expected,
    );
  });

  it("reinspects target-dependent runtime after a different artifact is installed", () => {
    const changed = preflight({
      installed: { version: "0.9.0", revision: "revision-0" },
      observer: differentObserver("0.9.0"),
      host: differentHost([]),
    });
    const result = derive(
      input({
        preflight: changed,
        targetRuntime: { status: "not-yet-provable" },
      }),
    );

    expect(result.selectedTarget.artifact).toEqual(changed.target);
    expect(result.phases.artifactApplication.action).toBe("apply");
    expect(result.phases.observerConvergence.action).toBe("reinspect");
    expect(result.phases.terminalConvergence.action).toBe("reinspect");
    expect(result.phases.hostConvergence.action).toBe("reinspect");
    expect(result.phases.persistedStateReconcile).toEqual({
      action: "await-artifact",
      reason: "target-build-not-yet-provable",
    });
    expect(result.outcome).toBe("actionable");
  });

  it("reinspects an exact same-display Observer with a future-target relation", () => {
    const result = derive(
      input({
        targetRuntime: { status: "not-yet-provable" },
        preflight: preflight({
          installed: { version: "0.9.0", revision: "revision-0" },
          observer: { ...differentObserver(artifact.version), relation: "unknown" },
        }),
      }),
    );
    expect(result.phases.observerConvergence).toEqual({
      action: "reinspect",
      reason: "target-build-not-yet-provable",
    });
  });

  it("reinspects a same-display Host with a future-target relation unless handoff is disabled", () => {
    const evidence = preflight({
      installed: { version: "0.9.0", revision: "revision-0" },
      observer: differentObserver("0.9.0"),
      host: { ...sameDisplayDriftHost([]), relation: "unknown" },
    });
    const result = derive(
      input({ preflight: evidence, targetRuntime: { status: "not-yet-provable" } }),
    );
    expect(result.phases.hostConvergence).toEqual({
      action: "reinspect",
      reason: "target-build-not-yet-provable",
    });

    const differentRelation = derive(
      input({
        targetRuntime: { status: "not-yet-provable" },
        preflight: preflight({
          installed: { version: "0.9.0", revision: "revision-0" },
          observer: differentObserver("0.9.0"),
          host: sameDisplayDriftHost([]),
        }),
      }),
    );
    expect(differentRelation.phases.hostConvergence).toEqual({
      action: "reinspect",
      reason: "target-build-not-yet-provable",
    });

    const noHandoff = derive(
      input({
        preflight: evidence,
        targetRuntime: { status: "not-yet-provable" },
        handoff: { action: "leave-in-place" },
      }),
    );
    expect(noHandoff.phases.hostConvergence).toEqual({
      action: "leave-in-place",
      reason: "handoff-disabled",
    });
  });

  it.each([
    { name: "idle", terminals: [], terminalDispositions: [] },
    {
      name: "busy",
      terminals: [terminal("non-releasable")],
      terminalDispositions: [disposition("non-preservable", "non-resumable")],
    },
  ])("blocks future-target protocol refusal for an $name Host", ({
    terminals,
    terminalDispositions,
  }) => {
    const result = derive(
      input({
        targetRuntime: { status: "not-yet-provable" },
        preflight: preflight({
          installed: { version: "0.9.0", revision: "revision-0" },
          observer: differentObserver("0.9.0"),
          host: { ...differentHost(terminals), compatibility: "refuse" },
          terminalDispositions,
        }),
      }),
    );
    expect(result.outcome).toBe("blocked");
    expect(result.phases.hostConvergence).toEqual({
      action: "blocked",
      reason: "protocol-refused",
    });
  });

  it.each([
    {
      name: "old-display reuse with a non-bridge terminal",
      host: {
        ...differentHost([terminal("non-releasable")]),
        compatibility: "reuse" as const,
      },
      terminalDispositions: [disposition("non-preservable", "non-resumable")],
    },
    {
      name: "target-display replace",
      host: { ...sameDisplayDriftHost([]), compatibility: "replace" as const },
      terminalDispositions: [],
    },
    {
      name: "missing-display replace",
      host: {
        status: "inspected" as const,
        protocolVersion: 8,
        relation: "unknown" as const,
        compatibility: "replace" as const,
        terminals: [],
      },
      terminalDispositions: [],
    },
    {
      name: "matching-target relation",
      host: { ...sameDisplayDriftHost([]), relation: "matching-target" as const },
      terminalDispositions: [],
    },
  ])("blocks contradictory future-target Host producer evidence for $name", ({
    host,
    terminalDispositions,
  }) => {
    const result = derive(
      input({
        targetRuntime: { status: "not-yet-provable" },
        preflight: preflight({
          installed: { version: "0.9.0", revision: "revision-0" },
          observer: differentObserver("0.9.0"),
          host,
          terminalDispositions,
        }),
      }),
    );
    expect(result.outcome).toBe("blocked");
    expect(result.phases.hostConvergence).toEqual({
      action: "blocked",
      reason: "evidence-contradictory",
    });
  });

  it.each([
    {
      name: "default handoff",
      handoff: { action: "preserve" as const, fidelity: "processes" as const },
    },
    { name: "no-handoff", handoff: { action: "leave-in-place" as const } },
  ])("blocks target-display future evidence with missing identity and different relation under $name", ({
    handoff,
  }) => {
    const result = derive(
      input({
        handoff,
        targetRuntime: { status: "not-yet-provable" },
        preflight: preflight({
          installed: { version: "0.9.0", revision: "revision-0" },
          observer: differentObserver("0.9.0"),
          host: {
            status: "inspected",
            buildVersion: artifact.version,
            protocolVersion: 8,
            relation: "different",
            compatibility: "reuse",
            terminals: [],
          },
        }),
      }),
    );
    expect(result.outcome).toBe("blocked");
    expect(result.phases.hostConvergence).toEqual({
      action: "blocked",
      reason: "evidence-contradictory",
    });
  });

  it.each([
    "processes",
    "screen",
  ] as const)("carries exact %s fidelity through terminal and Host handoff decisions", (fidelity) => {
    const result = derive(
      input({
        handoff: { action: "preserve", fidelity },
        preflight: preflight({
          observer: matchingObserver(),
          host: differentHost([terminal("bridge-releasable")]),
          terminalDispositions: [disposition("preservable", "non-resumable")],
        }),
      }),
    );
    expect(result.phases.terminalConvergence).toMatchObject({
      action: "preserve-via-handoff",
      fidelity,
    });
    expect(result.phases.hostConvergence).toMatchObject({ action: "handoff", fidelity });
  });

  it("requires recovery only for non-preservable terminals in a mixed inventory", () => {
    const mixed = derive(
      input({
        preflight: preflight({
          observer: matchingObserverWithSessions([
            recoverySession("1", "unknown"),
            recoverySession("2", "non-resumable"),
          ]),
          host: differentHost([
            terminal("bridge-releasable", "agent", "1"),
            terminal("non-releasable", "agent", "2"),
          ]),
          terminalDispositions: [
            disposition("preservable", "unknown", "1"),
            disposition("non-preservable", "non-resumable", "2", ["session_non_resumable"]),
          ],
        }),
      }),
    );
    expect(mixed.outcome).toBe("reap-required");
    expect(mixed.phases.terminalConvergence).toMatchObject({
      action: "reap-required",
      terminals: [
        { terminalTargetId: "terminal-1", reapRecovery: "unknown" },
        { terminalTargetId: "terminal-2", reapRecovery: "non-resumable" },
      ],
    });

    const afterReap = derive(
      input({
        preflight: preflight({
          observer: matchingObserverWithSessions([recoverySession("1", "unknown")]),
          host: differentHost([terminal("bridge-releasable")]),
          terminalDispositions: [disposition("preservable", "unknown")],
        }),
      }),
    );
    expect(afterReap.outcome).toBe("actionable");
    expect(afterReap.phases.terminalConvergence.action).toBe("preserve-via-handoff");
  });

  it("blocks incomplete evidence only when it is relevant to the selected action", () => {
    const irrelevantRecovery = derive(
      input({
        preflight: preflight({
          observer: matchingObserver("healthy", "unknown"),
          host: differentHost([terminal("bridge-releasable")]),
          terminalDispositions: [disposition("preservable", "unknown")],
        }),
      }),
    );
    expect(irrelevantRecovery.outcome).toBe("actionable");

    const destructiveRecovery = derive(
      input({
        preflight: preflight({
          observer: matchingObserver("healthy", "unknown"),
          host: differentHost([terminal("non-releasable")]),
          terminalDispositions: [disposition("non-preservable", "unknown")],
        }),
      }),
    );
    expect(destructiveRecovery.outcome).toBe("blocked");
    expect(destructiveRecovery.phases.terminalConvergence).toMatchObject({
      action: "blocked",
      reason: "recovery-incomplete",
    });
  });

  it.each([
    {
      name: "Observer evidence",
      preflight: preflight({
        observer: {
          status: "unknown",
          reason: "identity-unavailable",
          error: safeError("OBSERVER_UNKNOWN"),
        },
        host: matchingHost(),
      }),
      phase: "observerConvergence" as const,
    },
    {
      name: "Host inventory",
      preflight: preflight({
        observer: matchingObserver(),
        host: {
          status: "unknown",
          reason: "inventory-failed",
          error: safeError("HOST_UNKNOWN"),
        },
      }),
      phase: "hostConvergence" as const,
    },
    {
      name: "terminal handoff support",
      preflight: preflight({
        observer: matchingObserver(),
        host: differentHost([terminal("unknown")]),
        terminalDispositions: [disposition("unknown", "non-resumable")],
      }),
      phase: "terminalConvergence" as const,
    },
  ])("blocks incomplete $name", (testCase) => {
    const result = derive(input({ preflight: testCase.preflight }));
    expect(result.outcome).toBe("blocked");
    expect(result.phases[testCase.phase].action).toBe("blocked");
  });

  it("keeps hook decisions provider-neutral, ordered, and action-relevant", () => {
    const result = derive(
      input({
        preflight: preflight({
          observer: matchingObserver(),
          host: matchingHost(),
          hookProviderIds: ["claude", "codex", "cursor", "pi"],
          hooks: [
            {
              provider: "claude",
              status: "configured-disabled",
              followUp: { action: "enable-hooks" },
            },
            { provider: "codex", status: "needs-repair", reason: "owned-drift" },
            { provider: "cursor", status: "unsupported" },
            {
              provider: "pi",
              status: "ownership-conflict",
              ownership: "different-owner",
              followUp: { action: "run-explicit-takeover" },
            },
          ],
        }),
      }),
    );

    expect(result.outcome).toBe("blocked");
    expect(result.phases.hookReconciliation).toEqual({
      action: "blocked",
      reason: "hook-evidence-blocked",
      providers: [
        { provider: "claude", action: "no-op", reason: "configured-disabled" },
        { provider: "codex", action: "reconcile", reason: "owned-drift" },
        { provider: "cursor", action: "no-op", reason: "unsupported" },
        { provider: "pi", action: "blocked", reason: "ownership-conflict" },
      ],
    });
  });

  it("reconciles healthy hooks after a selected artifact change", () => {
    const evidence = preflight({
      installed: { version: "0.9.0" },
      hookProviderIds: ["codex"],
      hooks: [{ provider: "codex", status: "healthy" }],
    });
    const result = derive(
      input({ preflight: evidence, targetRuntime: { status: "not-yet-provable" } }),
    );
    expect(result.phases.hookReconciliation).toMatchObject({
      action: "reconcile",
      providers: [{ provider: "codex", reason: "selected-artifact-change" }],
    });
  });

  it("represents explicit no-handoff as intentionally incomplete", () => {
    const result = derive(
      input({
        handoff: { action: "leave-in-place" },
        preflight: preflight({
          observer: matchingObserver(),
          host: differentHost([terminal("bridge-releasable")]),
          terminalDispositions: [disposition("preservable", "non-resumable")],
        }),
      }),
    );
    expect(result.outcome).toBe("intentionally-incomplete");
    expect(result.phases.hostConvergence.action).toBe("leave-in-place");
    expect(result.phases.finalVerification.action).toBe("not-planned");
  });

  it.each([
    { name: "old idle Host", host: differentHost([]) },
    {
      name: "unknown Host inventory",
      host: {
        status: "unknown" as const,
        reason: "inventory-failed" as const,
        error: safeError("HOST_UNKNOWN"),
      },
    },
    {
      name: "unknown Host relation",
      host: {
        status: "inspected" as const,
        buildVersion: artifact.version,
        protocolVersion: 8,
        relation: "unknown" as const,
        compatibility: "reuse" as const,
        terminals: [],
      },
    },
    {
      name: "protocol-refused Host",
      host: { ...differentHost([]), compatibility: "refuse" as const },
    },
  ])("leaves $name intentionally incomplete when handoff is disabled", ({ host }) => {
    const result = derive(
      input({
        handoff: { action: "leave-in-place" },
        preflight: preflight({ observer: matchingObserver(), host }),
      }),
    );
    expect(result.outcome).toBe("intentionally-incomplete");
    expect(result.phases.terminalConvergence.action).toBe("leave-in-place");
    expect(result.phases.hostConvergence.action).toBe("leave-in-place");
  });

  it.each([
    {
      name: "missing-display replace",
      host: {
        status: "inspected" as const,
        buildIdentity: incumbentBuildIdentity,
        protocolVersion: 8,
        relation: "different" as const,
        compatibility: "replace" as const,
        terminals: [],
      },
    },
    {
      name: "same-display replace",
      host: { ...sameDisplayDriftHost([]), compatibility: "replace" as const },
    },
    {
      name: "missing-display reuse",
      host: {
        status: "inspected" as const,
        protocolVersion: 8,
        relation: "unknown" as const,
        compatibility: "reuse" as const,
        terminals: [],
      },
    },
    {
      name: "exact-matching replace",
      host: { ...matchingHost(), compatibility: "replace" as const },
    },
  ])("blocks contradictory $name evidence before no-handoff", ({ host }) => {
    const result = derive(
      input({
        handoff: { action: "leave-in-place" },
        preflight: preflight({ observer: matchingObserver(), host }),
      }),
    );
    expect(result.outcome).toBe("blocked");
    expect(result.phases.hostConvergence).toEqual({
      action: "blocked",
      reason: "evidence-contradictory",
    });
  });

  it("honors no-handoff before future-target Host comparison", () => {
    const result = derive(
      input({
        handoff: { action: "leave-in-place" },
        targetRuntime: { status: "not-yet-provable" },
        preflight: preflight({
          installed: { version: "0.9.0", revision: "revision-0" },
          observer: differentObserver("0.9.0"),
          host: differentHost([]),
        }),
      }),
    );
    expect(result.outcome).toBe("intentionally-incomplete");
    expect(result.phases.hostConvergence.action).toBe("leave-in-place");
  });

  it.each([
    { name: "absent", host: { status: "absent" as const }, expected: "absent" },
    { name: "exact matching", host: matchingHost(), expected: "matching-target" },
  ])("keeps an $name Host no-op when handoff is disabled", ({ host, expected }) => {
    const result = derive(
      input({
        handoff: { action: "leave-in-place" },
        preflight: preflight({ observer: matchingObserver(), host }),
      }),
    );
    expect(result.phases.hostConvergence).toEqual({ action: "no-op", reason: expected });
  });

  it("keeps Observer uncertainty blocking when no-handoff makes Host evidence irrelevant", () => {
    const result = derive(
      input({
        handoff: { action: "leave-in-place" },
        preflight: preflight({
          observer: {
            status: "unknown",
            reason: "identity-unavailable",
            error: safeError("OBSERVER_UNKNOWN"),
          },
          host: {
            status: "unknown",
            reason: "inventory-failed",
            error: safeError("HOST_UNKNOWN"),
          },
        }),
      }),
    );
    expect(result.outcome).toBe("blocked");
    expect(result.phases.observerConvergence.action).toBe("blocked");
    expect(result.phases.hostConvergence.action).toBe("leave-in-place");
  });

  it.each([
    {
      name: "matching Host",
      host: { ...matchingHost(), terminals: [{ ...terminal("bridge-releasable"), alive: false }] },
      disposition: disposition("preservable", "non-resumable"),
    },
    {
      name: "different bridge Host",
      host: differentHost([{ ...terminal("bridge-releasable"), alive: false }]),
      disposition: disposition("preservable", "non-resumable"),
    },
    {
      name: "different non-bridge Host",
      host: differentHost([{ ...terminal("non-releasable"), alive: false }]),
      disposition: disposition("non-preservable", "non-resumable"),
    },
  ])("blocks dead entries in an inspected $name inventory", ({
    host,
    disposition: terminalDisposition,
  }) => {
    const result = derive(
      input({
        handoff: { action: "leave-in-place" },
        preflight: preflight({
          observer: matchingObserver(),
          host,
          terminalDispositions: [terminalDisposition],
        }),
      }),
    );
    expect(result.outcome).toBe("blocked");
    expect(result.phases.hostConvergence).toEqual({
      action: "blocked",
      reason: "evidence-contradictory",
    });
  });

  it.each([
    {
      name: "unknown Observer",
      evidence: preflight({
        installed: { version: "0.9.0", revision: "revision-0" },
        observer: {
          status: "unknown",
          reason: "inspection-failed",
          error: safeError("OBSERVER_UNKNOWN"),
        },
      }),
      expected: ["blocked", "blocked", "no-op", "no-op"],
    },
    {
      name: "unknown Host",
      evidence: preflight({
        installed: { version: "0.9.0", revision: "revision-0" },
        observer: differentObserver("0.9.0"),
        host: {
          status: "unknown",
          reason: "inventory-failed",
          error: safeError("HOST_UNKNOWN"),
        },
      }),
      expected: ["blocked", "reinspect", "blocked", "blocked"],
    },
    {
      name: "proven-different non-bridge Host",
      evidence: preflight({
        installed: { version: "0.9.0", revision: "revision-0" },
        observer: differentObserver("0.9.0"),
        host: differentHost([terminal("non-releasable")]),
        terminalDispositions: [disposition("non-preservable", "non-resumable")],
      }),
      expected: ["reap-required", "reinspect", "reap-required", "await-reap"],
    },
    {
      name: "proven-different bridge Host",
      evidence: preflight({
        installed: { version: "0.9.0", revision: "revision-0" },
        observer: differentObserver("0.9.0"),
        host: differentHost([terminal("bridge-releasable")]),
        terminalDispositions: [disposition("preservable", "non-resumable")],
      }),
      expected: ["actionable", "reinspect", "reinspect", "reinspect"],
    },
    {
      name: "proven-different idle Host",
      evidence: preflight({
        installed: { version: "0.9.0", revision: "revision-0" },
        observer: differentObserver("0.9.0"),
        host: differentHost([]),
      }),
      expected: ["actionable", "reinspect", "reinspect", "reinspect"],
    },
  ])("retains conclusive $name evidence before a future target build is provable", ({
    evidence,
    expected,
  }) => {
    const result = derive(
      input({ preflight: evidence, targetRuntime: { status: "not-yet-provable" } }),
    );
    expect([
      result.outcome,
      result.phases.observerConvergence.action,
      result.phases.terminalConvergence.action,
      result.phases.hostConvergence.action,
    ]).toEqual(expected);
  });

  it.each([
    {
      name: "unknown runtime evidence",
      evidence: preflight({
        observer: { status: "unknown", reason: "inspection-failed", error: safeError("UNKNOWN") },
      }),
    },
    {
      name: "complete reap consequences",
      evidence: preflight({
        observer: matchingObserver(),
        host: differentHost([terminal("non-releasable")]),
        terminalDispositions: [disposition("non-preservable", "non-resumable")],
      }),
    },
  ])("defers a changed package-manager target with $name retained", ({ evidence }) => {
    const deferredEvidence = UpdateReapRecoveryPreflightSchema.parse({
      ...evidence,
      installed: { version: "0.9.0", revision: "revision-0" },
    });
    const result = derive(
      input({
        preflight: deferredEvidence,
        targetRuntime: { status: "not-yet-provable" },
        installation: {
          whenRequired: "defer",
          owner: "homebrew",
          command: { kind: "manager", argv: ["brew", "upgrade", "station"] },
        },
      }),
    );
    expect(result.outcome).toBe("deferred");
    expect(result.phases.artifactApplication.action).toBe("defer");
    expect(result.phases.persistedStateReconcile).toEqual({
      action: "await-artifact",
      reason: "package-manager-deferred",
    });
    expect(result.phases.finalVerification).toEqual({
      action: "await-artifact",
      reason: "package-manager-deferred",
    });
  });

  it("does not defer when the selected artifact is already installed", () => {
    const result = derive(
      input({
        preflight: preflight({ observer: matchingObserver(), host: matchingHost() }),
        installation: {
          whenRequired: "defer",
          owner: "homebrew",
          command: { kind: "manager", argv: ["brew", "upgrade", "station"] },
        },
      }),
    );
    expect(result.outcome).toBe("converged");
    expect(result.phases.artifactApplication.action).toBe("no-op");
  });

  it("fails closed on contradictory selected-runtime and Host facts", () => {
    const invalidTarget = derive(
      input({
        targetRuntime: {
          status: "known",
          buildIdentity,
          observerSelector: `9.0.0+station.${buildIdentity}`,
        },
        preflight: preflight({ observer: matchingObserver(), host: matchingHost() }),
      }),
    );
    expect(invalidTarget.outcome).toBe("blocked");
    expect(invalidTarget.phases.observerConvergence).toMatchObject({
      action: "blocked",
      reason: "selected-target-identity-invalid",
    });

    const contradictoryHost = derive(
      input({
        preflight: preflight({
          observer: matchingObserver(),
          host: { ...matchingHost(), buildIdentity: incumbentBuildIdentity },
        }),
      }),
    );
    expect(contradictoryHost.phases.hostConvergence).toMatchObject({
      action: "blocked",
      reason: "evidence-contradictory",
    });
  });

  it.each([
    {
      name: "handoff",
      observer: matchingObserver(),
      host: differentHost([terminal("bridge-releasable")]),
      supplied: disposition("non-preservable", "non-resumable"),
      canonical: { handoff: "preservable", reapRecovery: "non-resumable" },
    },
    {
      name: "recovery",
      observer: matchingObserverWithSessions([recoverySession("1", "recoverable")]),
      host: differentHost([terminal("non-releasable")]),
      supplied: disposition("non-preservable", "non-resumable", "1", ["session_non_resumable"]),
      canonical: { handoff: "non-preservable", reapRecovery: "recoverable", reasons: [] },
    },
  ])("blocks a supplied $name disposition mismatch and publishes only canonical facts", ({
    observer,
    host,
    supplied,
    canonical,
  }) => {
    const result = derive(
      input({
        preflight: preflight({ observer, host, terminalDispositions: [supplied] }),
      }),
    );
    expect(result.outcome).toBe("blocked");
    expect(result.phases.hostConvergence).toEqual({
      action: "blocked",
      reason: "evidence-contradictory",
    });
    expect(result.phases.terminalConvergence.terminals[0]).toMatchObject(canonical);
    expect(result.phases.terminalConvergence.terminals[0]).not.toMatchObject(supplied);
  });

  it("retains exact optional artifact identity and emits no counts or authority", () => {
    const result = derive(input());
    expect(result.selectedTarget.artifact).toEqual(artifact);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Count");
    expect(serialized).not.toContain("processGroup");
    expect(serialized).not.toContain("signal");
    expect(result.authorization).toBe("none");
  });
});

function derive(value: UpdateConvergencePlanningInput) {
  const result = deriveUpdateConvergencePlan(value);
  expect(UpdateConvergencePlanSchema.parse(result)).toEqual(result);
  return result;
}

function input(overrides: Partial<UpdateConvergencePlanningInput> = {}) {
  return UpdateConvergencePlanningInputSchema.parse({
    preflight: preflight(),
    targetRuntime: { status: "known", buildIdentity, observerSelector },
    installation: {
      whenRequired: "apply",
      owner: "installer-binary",
      command: { kind: "none" },
    },
    handoff: { action: "preserve", fidelity: "processes" },
    ...overrides,
  });
}

function preflight(
  overrides: Partial<UpdateReapRecoveryPreflight> = {},
): UpdateReapRecoveryPreflight {
  const evidence = {
    observer: { status: "absent" as const },
    host: { status: "absent" as const },
    hookProviderIds: [],
    hooks: [],
    terminalDispositions: [],
    ...overrides,
  };
  return UpdateReapRecoveryPreflightSchema.parse({
    schemaVersion: 1,
    boundary: { authorization: "none", actions: "not-included", digest: "not-included" },
    installed: artifact,
    target: artifact,
    ...evidence,
    evidenceComplete: updateReapEvidenceIsComplete(evidence),
  });
}

function matchingObserver(
  health: "healthy" | "degraded" | "unavailable" = "healthy",
  recovery: "assessed" | "unknown" = "assessed",
): UpdateReapRecoveryPreflight["observer"] {
  return {
    status: "exact",
    buildVersion: observerSelector,
    relation: "matching-target",
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
        : { status: "unknown", reason: "api-unavailable", error: safeError("RECOVERY_UNKNOWN") },
  };
}

function matchingObserverWithSessions(
  sessions: ReturnType<typeof recoverySession>[],
): UpdateReapRecoveryPreflight["observer"] {
  return {
    ...matchingObserver(),
    recovery: {
      status: "assessed",
      assessment: {
        schemaVersion: 1,
        resumeEnabled: true,
        providerCapabilities: [],
        sessions,
      },
    },
  };
}

function recoverySession(
  identity: string,
  disposition: "recoverable" | "non-resumable" | "unknown",
) {
  const reason = disposition === "unknown" ? "worktree_evidence_missing" : "global_resume_disabled";
  return {
    sessionId: `session-${identity}`,
    projectId: `project-${identity}`,
    worktreeId: `worktree-${identity}`,
    lifecycle: "open" as const,
    harnessProvider: "codex",
    disposition,
    reasons: disposition === "recoverable" ? [] : ([reason] as const),
    handleResolution:
      disposition === "recoverable"
        ? {
            kind: "selected" as const,
            eligibleHandleCount: 1,
            rejectedHandleCount: 0,
            rejectedReasons: [],
          }
        : disposition === "unknown"
          ? { kind: "unknown" as const, reasons: [reason] as const }
          : {
              kind: "none" as const,
              eligibleHandleCount: 0 as const,
              rejectedHandleCount: 0,
              reasons: ["no_recovery_handles" as const],
            },
  };
}

function differentObserver(
  version: string,
  identity = incumbentBuildIdentity,
): UpdateReapRecoveryPreflight["observer"] {
  return {
    ...matchingObserver(),
    buildVersion: `${version}+station.${identity}`,
    relation: "different",
  };
}

function matchingHost(): Extract<UpdateReapRecoveryPreflight["host"], { status: "inspected" }> {
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
): Extract<UpdateReapRecoveryPreflight["host"], { status: "inspected" }> {
  return {
    status: "inspected",
    buildVersion: "0.9.0",
    buildIdentity: incumbentBuildIdentity,
    protocolVersion: 8,
    relation: "different",
    compatibility: "replace",
    terminals,
  };
}

function sameDisplayDriftHost(
  terminals: Extract<UpdateReapRecoveryPreflight["host"], { status: "inspected" }>["terminals"],
): Extract<UpdateReapRecoveryPreflight["host"], { status: "inspected" }> {
  return {
    status: "inspected",
    buildVersion: artifact.version,
    buildIdentity: incumbentBuildIdentity,
    protocolVersion: 8,
    relation: "different",
    compatibility: "reuse",
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
  explicitReasons: UpdateReapRecoveryPreflight["terminalDispositions"][number]["reasons"] = [],
) {
  const reasons = [...explicitReasons];
  if (handoff === "unknown") reasons.push("handoff_support_unknown");
  if (reapRecovery === "unknown") reasons.push("session_recovery_unknown");
  if (reapRecovery === "non-resumable" && reasons.length === 0) {
    reasons.push("retained_session_missing");
  }
  reasons.sort();
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

function safeError(code: string) {
  return { tag: "UpdatePreflightError", code, message: "Evidence unavailable." };
}
