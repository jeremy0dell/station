import {
  type UpdateConvergencePlan,
  UpdateConvergencePlanningInputSchema,
  UpdateConvergencePlanSchema,
} from "@station/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";

const buildIdentity = "a".repeat(64);
const artifact = { version: "1.0.0", revision: "revision-1" };

describe("UpdateConvergencePlanningInputSchema", () => {
  it("parses one current strict planning input with preflight.target as the artifact source", () => {
    expect(UpdateConvergencePlanningInputSchema.parse(planningInput())).toEqual(planningInput());
  });

  it("requires target runtime knowledge exactly when the target artifact is installed", () => {
    expect(
      UpdateConvergencePlanningInputSchema.safeParse({
        ...planningInput(),
        targetRuntime: { status: "not-yet-provable" },
      }).success,
    ).toBe(false);

    const changed = planningInput({
      preflight: preflight({ installed: { version: "0.9.0", revision: "revision-0" } }),
      targetRuntime: { status: "not-yet-provable" },
    });
    expect(UpdateConvergencePlanningInputSchema.safeParse(changed).success).toBe(true);
    expect(
      UpdateConvergencePlanningInputSchema.safeParse({
        ...changed,
        targetRuntime: {
          status: "known",
          buildIdentity,
          observerSelector: `${artifact.version}+station.${buildIdentity}`,
        },
      }).success,
    ).toBe(false);
  });

  it("keeps manager commands and handoff fidelity in only their owning variants", () => {
    expect(
      UpdateConvergencePlanningInputSchema.safeParse({
        ...planningInput(),
        installation: { whenRequired: "defer", owner: "homebrew", command: { kind: "none" } },
      }).success,
    ).toBe(false);
    expect(
      UpdateConvergencePlanningInputSchema.safeParse({
        ...planningInput(),
        handoff: { action: "leave-in-place", fidelity: "screen" },
      }).success,
    ).toBe(false);
    expect(
      UpdateConvergencePlanningInputSchema.safeParse({
        ...planningInput(),
        installation: {
          whenRequired: "apply",
          owner: "npm-global",
          command: { kind: "manager", argv: ["npm", "install", "@station/cli@1.0.0"] },
        },
        handoff: { action: "preserve", fidelity: "screen" },
      }).success,
    ).toBe(true);
  });

  it("rejects invalid build identities, unknown fields, and a duplicated target artifact", () => {
    expect(
      UpdateConvergencePlanningInputSchema.safeParse({
        ...planningInput(),
        targetRuntime: {
          status: "known",
          buildIdentity: "not-a-build-identity",
          observerSelector: "1.0.0",
        },
      }).success,
    ).toBe(false);
    expect(
      UpdateConvergencePlanningInputSchema.safeParse({ ...planningInput(), schemaVersion: 1 })
        .success,
    ).toBe(false);
    expect(
      UpdateConvergencePlanningInputSchema.safeParse({
        ...planningInput(),
        selectedTarget: { artifact },
      }).success,
    ).toBe(false);
  });
});

describe("UpdateConvergencePlanSchema", () => {
  it("parses a strict non-authorizing converged plan", () => {
    expect(UpdateConvergencePlanSchema.parse(convergedPlan())).toEqual(convergedPlan());
  });

  it("parses exact terminal consequences without destructive authority", () => {
    const plan = convergedPlan({
      outcome: "reap-required",
      phases: {
        ...convergedPlan().phases,
        terminalConvergence: {
          action: "reap-required",
          reason: "non-preservable-terminals",
          terminals: [terminalFact()],
        },
        hostConvergence: { action: "await-reap", reason: "non-preservable-terminals" },
        persistedStateReconcile: { action: "await-reap", reason: "reap-required" },
        finalVerification: { action: "await-reap", reason: "reap-required" },
      },
    });
    expect(UpdateConvergencePlanSchema.parse(plan)).toEqual(plan);
    expect(JSON.stringify(plan)).not.toContain("processGroup");
    expect(JSON.stringify(plan)).not.toContain("signal");
  });

  it("requires handoff fidelity only for both handoff decisions and requires equality", () => {
    const handoff = convergedPlan({
      outcome: "actionable",
      phases: {
        ...convergedPlan().phases,
        terminalConvergence: {
          action: "preserve-via-handoff",
          reason: "bridge-preservation",
          fidelity: "processes",
          terminals: [
            terminalFact({
              handoff: "preservable",
              reapRecovery: "unknown",
              reasons: ["session_recovery_unknown"],
            }),
          ],
        },
        hostConvergence: {
          action: "handoff",
          reason: "busy-different-host",
          fidelity: "processes",
        },
        persistedStateReconcile: { action: "run", reason: "runtime-change" },
        finalVerification: { action: "inspect", reason: "after-actions" },
      },
    });
    expect(UpdateConvergencePlanSchema.safeParse(handoff).success).toBe(true);
    expect(
      UpdateConvergencePlanSchema.safeParse({
        ...handoff,
        phases: {
          ...handoff.phases,
          hostConvergence: { ...handoff.phases.hostConvergence, fidelity: "screen" },
        },
      }).success,
    ).toBe(false);
    expect(
      UpdateConvergencePlanSchema.safeParse({
        ...handoff,
        phases: {
          ...handoff.phases,
          hostConvergence: { action: "no-op", reason: "absent", fidelity: "processes" },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects action-reason and manager-command combinations outside their strict variants", () => {
    const plan = convergedPlan();
    expect(
      UpdateConvergencePlanSchema.safeParse({
        ...plan,
        phases: {
          ...plan.phases,
          observerConvergence: {
            action: "restart",
            reason: "target-precedes",
            precedence: "exact-build",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      UpdateConvergencePlanSchema.safeParse({
        ...plan,
        phases: {
          ...plan.phases,
          artifactApplication: {
            action: "defer",
            reason: "package-manager-deferred",
            before: artifact,
            owner: "homebrew",
            command: { kind: "none" },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("infers exact conditional fields without adding reap authority", () => {
    type Deferred = Extract<
      UpdateConvergencePlan["phases"]["artifactApplication"],
      { action: "defer" }
    >;
    type Handoff = Extract<
      UpdateConvergencePlan["phases"]["hostConvergence"],
      { action: "handoff" }
    >;
    type Reap = Extract<
      UpdateConvergencePlan["phases"]["terminalConvergence"],
      { action: "reap-required" }
    >;

    expectTypeOf<Deferred["reason"]>().toEqualTypeOf<"package-manager-deferred">();
    expectTypeOf<Deferred["command"]["kind"]>().toEqualTypeOf<"manager">();
    expectTypeOf<Handoff["fidelity"]>().toEqualTypeOf<"processes" | "screen">();
    expectTypeOf<Reap>().not.toHaveProperty("authorization");
    expectTypeOf<UpdateConvergencePlan["authorization"]>().toEqualTypeOf<"none">();
  });

  it("rejects duplicate or unsorted provider and terminal decisions", () => {
    const plan = convergedPlan();
    expect(
      UpdateConvergencePlanSchema.safeParse({
        ...plan,
        phases: {
          ...plan.phases,
          hookReconciliation: {
            action: "no-op",
            reason: "healthy",
            providers: [
              { provider: "codex", action: "no-op", reason: "healthy" },
              { provider: "codex", action: "no-op", reason: "healthy" },
            ],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      UpdateConvergencePlanSchema.safeParse({
        ...plan,
        phases: {
          ...plan.phases,
          terminalConvergence: {
            action: "reap-required",
            reason: "non-preservable-terminals",
            terminals: [terminalFact("2"), terminalFact("1")],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("uses canonical physical PTY identity for terminal uniqueness", () => {
    const duplicatePhysicalPty = [terminalFact(), terminalFact({ sessionId: "session-different" })];
    expect(
      UpdateConvergencePlanSchema.safeParse(
        convergedPlan({
          outcome: "reap-required",
          phases: {
            ...convergedPlan().phases,
            terminalConvergence: {
              action: "reap-required",
              reason: "non-preservable-terminals",
              terminals: duplicatePhysicalPty,
            },
          },
        }),
      ).success,
    ).toBe(false);

    const separatorCollision = [
      terminalFact({
        terminalTargetId: "a",
        ptyId: "b\0c",
        ptyInstanceId: "d",
        sessionId: "session-a",
      }),
      terminalFact({
        terminalTargetId: "a\0b",
        ptyId: "c",
        ptyInstanceId: "d",
        sessionId: "session-b",
      }),
    ];
    const plan = convergedPlan({
      outcome: "reap-required",
      phases: {
        ...convergedPlan().phases,
        terminalConvergence: {
          action: "reap-required",
          reason: "non-preservable-terminals",
          terminals: separatorCollision,
        },
      },
    });
    expect(UpdateConvergencePlanSchema.safeParse(plan).success).toBe(true);
    expect(
      UpdateConvergencePlanSchema.safeParse({
        ...plan,
        phases: {
          ...plan.phases,
          terminalConvergence: {
            ...plan.phases.terminalConvergence,
            terminals: [...separatorCollision].reverse(),
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects local auxiliary recovery contradictions in either direction", () => {
    const plan = convergedPlan({
      outcome: "reap-required",
      phases: {
        ...convergedPlan().phases,
        terminalConvergence: {
          action: "reap-required",
          reason: "non-preservable-terminals",
          terminals: [
            terminalFact({
              kind: "aux",
              reapRecovery: "non-resumable",
              reasons: ["aux_terminal_not_resumable"],
            }),
          ],
        },
      },
    });
    expect(UpdateConvergencePlanSchema.safeParse(plan).success).toBe(true);

    const auxiliaryWithoutItsReason = {
      ...plan,
      phases: {
        ...plan.phases,
        terminalConvergence: {
          ...plan.phases.terminalConvergence,
          terminals: [terminalFact({ kind: "aux", reapRecovery: "non-resumable", reasons: [] })],
        },
      },
    };
    expect(UpdateConvergencePlanSchema.safeParse(auxiliaryWithoutItsReason).success).toBe(false);

    const recoverableAuxiliary = {
      ...plan,
      phases: {
        ...plan.phases,
        terminalConvergence: {
          ...plan.phases.terminalConvergence,
          terminals: [
            terminalFact({
              kind: "aux",
              reapRecovery: "recoverable",
              reasons: ["aux_terminal_not_resumable"],
            }),
          ],
        },
      },
    };
    expect(UpdateConvergencePlanSchema.safeParse(recoverableAuxiliary).success).toBe(false);

    const agentWithAuxiliaryReason = {
      ...plan,
      phases: {
        ...plan.phases,
        terminalConvergence: {
          ...plan.phases.terminalConvergence,
          terminals: [terminalFact({ reasons: ["aux_terminal_not_resumable"] })],
        },
      },
    };
    expect(UpdateConvergencePlanSchema.safeParse(agentWithAuxiliaryReason).success).toBe(false);
  });

  it.each([
    {
      name: "recoverable terminal with a blocking recovery reason",
      terminal: terminalFact({
        reapRecovery: "recoverable",
        reasons: ["session_non_resumable"],
      }),
    },
    {
      name: "known handoff with the unknown-support reason",
      terminal: terminalFact({
        reasons: ["handoff_support_unknown", "session_non_resumable"],
      }),
    },
    {
      name: "unknown handoff without the unknown-support reason",
      terminal: terminalFact({ handoff: "unknown" }),
    },
  ])("rejects a produced fact with $name", ({ terminal }) => {
    const plan = convergedPlan({
      outcome: "reap-required",
      phases: {
        ...convergedPlan().phases,
        terminalConvergence: {
          action: "reap-required",
          reason: "non-preservable-terminals",
          terminals: [terminal],
        },
      },
    });
    expect(UpdateConvergencePlanSchema.safeParse(plan).success).toBe(false);
  });

  it.each([
    ["schemaVersion", 4],
    ["digest", { algorithm: "sha256", value: buildIdentity }],
    ["components", {}],
    ["result", { kind: "preview" }],
    ["actionAudit", []],
    ["evaluator", "incumbent-cli"],
    ["evidence", { preflight: preflight() }],
  ])("rejects obsolete or out-of-scope top-level field %s", (field, value) => {
    expect(
      UpdateConvergencePlanSchema.safeParse({ ...convergedPlan(), [field]: value }).success,
    ).toBe(false);
  });

  it("rejects a phase array and unknown outcome discriminators", () => {
    expect(UpdateConvergencePlanSchema.safeParse({ ...convergedPlan(), phases: [] }).success).toBe(
      false,
    );
    expect(
      UpdateConvergencePlanSchema.safeParse({ ...convergedPlan(), outcome: "planned" }).success,
    ).toBe(false);
  });
});

function planningInput(overrides: Record<string, unknown> = {}) {
  return {
    preflight: preflight(),
    targetRuntime: {
      status: "known" as const,
      buildIdentity,
      observerSelector: `${artifact.version}+station.${buildIdentity}`,
    },
    installation: {
      whenRequired: "apply" as const,
      owner: "installer-binary" as const,
      command: { kind: "none" as const },
    },
    handoff: { action: "preserve" as const, fidelity: "processes" as const },
    ...overrides,
  };
}

function preflight(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    boundary: {
      authorization: "none" as const,
      actions: "not-included" as const,
      digest: "not-included" as const,
    },
    installed: artifact,
    target: artifact,
    observer: { status: "absent" as const },
    host: { status: "absent" as const },
    hookProviderIds: [],
    hooks: [],
    terminalDispositions: [],
    evidenceComplete: false,
    ...overrides,
  };
}

function convergedPlan(overrides: Record<string, unknown> = {}) {
  return {
    authorization: "none" as const,
    selectedTarget: {
      artifact,
      runtimeBuild: {
        status: "known" as const,
        buildIdentity,
        observerSelector: `${artifact.version}+station.${buildIdentity}`,
      },
    },
    outcome: "converged" as const,
    phases: {
      artifactApplication: {
        action: "no-op" as const,
        reason: "selected-artifact-current" as const,
        before: artifact,
        owner: "installer-binary" as const,
        command: { kind: "none" as const },
      },
      hookReconciliation: { action: "no-op" as const, reason: "healthy" as const, providers: [] },
      observerConvergence: {
        action: "no-op" as const,
        reason: "matching-healthy" as const,
        precedence: "exact-build" as const,
      },
      terminalConvergence: {
        action: "no-op" as const,
        reason: "matching-host" as const,
        terminals: [],
      },
      hostConvergence: { action: "no-op" as const, reason: "matching-target" as const },
      persistedStateReconcile: { action: "no-op" as const, reason: "no-runtime-change" as const },
      finalVerification: {
        action: "satisfied" as const,
        reason: "initial-inspection-converged" as const,
      },
    },
    ...overrides,
  };
}

function terminalFact(overrides: Record<string, unknown> | string = {}) {
  const identity = typeof overrides === "string" ? overrides : "1";
  const fields = typeof overrides === "string" ? {} : overrides;
  return {
    kind: "agent" as const,
    alive: true,
    terminalTargetId: `terminal-${identity}`,
    ptyId: `pty-${identity}`,
    ptyInstanceId: `pty-instance-${identity}`,
    sessionId: `session-${identity}`,
    handoff: "non-preservable" as const,
    reapRecovery: "non-resumable" as const,
    reasons: ["session_non_resumable" as const],
    ...fields,
  };
}
