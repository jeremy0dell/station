import {
  UpdateConvergencePlanSchema,
  UpdateHostConvergenceCommandResultSchema,
  UpdateHostConvergenceCommandSchema,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const terminal = (id: string) => ({
  terminalTargetId: `native:wt-${id}`,
  ptyId: `pty-${id}`,
  ptyInstanceId: `ptyi-${id}`,
  sessionId: `ses-${id}`,
});

describe("update Host convergence schema", () => {
  it("requires matching fidelity on the strict Host and terminal handoff decisions", () => {
    const plan = handoffPlan("processes");
    expect(UpdateConvergencePlanSchema.parse(plan)).toMatchObject({
      components: {
        host: { action: "handoff", fidelity: "processes" },
        terminals: { action: "preserve-via-handoff", fidelity: "processes" },
      },
    });
    expect(
      UpdateConvergencePlanSchema.safeParse({
        ...plan,
        components: {
          ...plan.components,
          host: { ...plan.components.host, fidelity: "screen" },
        },
      }).success,
    ).toBe(false);
    const { fidelity: _omitted, ...hostWithoutFidelity } = plan.components.host;
    expect(
      UpdateConvergencePlanSchema.safeParse({
        ...plan,
        components: { ...plan.components, host: hostWithoutFidelity },
      }).success,
    ).toBe(false);
  });

  it("strictly binds constrained idle replacement and handoff to the exact planned inventory", () => {
    const target = { buildVersion: "2.0.0", buildIdentity: "b".repeat(64) };
    const idleCommitment = {
      incumbent: {
        buildVersion: { status: "known" as const, value: "1.0.0" },
        buildIdentity: { status: "known" as const, value: "a".repeat(64) },
        protocolVersion: 8,
        inventory: { terminals: [] },
      },
      target,
    };
    const busyCommitment = {
      ...idleCommitment,
      incumbent: {
        ...idleCommitment.incumbent,
        inventory: { terminals: [terminal("1"), terminal("2")] },
      },
    };

    expect(
      UpdateHostConvergenceCommandSchema.parse({
        schemaVersion: 1,
        action: "replace-idle",
        commitment: idleCommitment,
      }),
    ).toMatchObject({ action: "replace-idle" });
    expect(
      UpdateHostConvergenceCommandResultSchema.parse({
        schemaVersion: 1,
        action: "update-converge",
        requestedAction: "handoff",
        requestedFidelity: "screen",
        status: "completed",
        receipt: {
          ensuredBy: "handoff",
          fidelity: "screen",
          validatedCommitment: busyCommitment,
          actualInventory: busyCommitment.incumbent.inventory,
          handoffReceipt: busyCommitment.incumbent.inventory,
        },
      }),
    ).toMatchObject({ status: "completed", receipt: { ensuredBy: "handoff" } });
    expect(
      UpdateHostConvergenceCommandResultSchema.parse({
        schemaVersion: 1,
        action: "update-converge",
        requestedAction: "handoff",
        requestedFidelity: "screen",
        status: "already-converged",
        validatedCommitment: busyCommitment,
        actualInventory: busyCommitment.incumbent.inventory,
      }),
    ).toMatchObject({ status: "already-converged" });
  });

  it("rejects action switching, same-count wrong identities, and private receipt extensions", () => {
    const authorized = [terminal("1"), terminal("2")];
    const commitment = {
      incumbent: {
        buildVersion: { status: "known" as const, value: "1.0.0" },
        buildIdentity: { status: "known" as const, value: "a".repeat(64) },
        protocolVersion: 8,
        inventory: { terminals: authorized },
      },
      target: { buildVersion: "2.0.0", buildIdentity: "b".repeat(64) },
    };
    const result = {
      schemaVersion: 1,
      action: "update-converge",
      requestedAction: "handoff",
      requestedFidelity: "processes",
      status: "completed",
      receipt: {
        ensuredBy: "handoff",
        fidelity: "processes",
        validatedCommitment: commitment,
        actualInventory: { terminals: [terminal("1"), terminal("3")] },
        handoffReceipt: { terminals: [terminal("1"), terminal("3")] },
      },
    };

    expect(UpdateHostConvergenceCommandResultSchema.safeParse(result).success).toBe(false);
    expect(
      UpdateHostConvergenceCommandResultSchema.safeParse({
        ...result,
        requestedAction: "replace-idle",
        receipt: {
          ensuredBy: "idle-replace",
          validatedCommitment: commitment,
          actualInventory: { terminals: authorized },
        },
      }).success,
    ).toBe(false);
    expect(
      UpdateHostConvergenceCommandResultSchema.safeParse({
        ...result,
        receipt: {
          ...result.receipt,
          actualInventory: commitment.incumbent.inventory,
          handoffReceipt: commitment.incumbent.inventory,
          processGroups: [4242],
        },
      }).success,
    ).toBe(false);
    expect(
      UpdateHostConvergenceCommandResultSchema.safeParse({
        schemaVersion: 1,
        action: "update-converge",
        requestedAction: "handoff",
        requestedFidelity: "processes",
        status: "already-converged",
        validatedCommitment: commitment,
        actualInventory: { terminals: [terminal("1"), terminal("3")] },
      }).success,
    ).toBe(false);
    expect(
      UpdateHostConvergenceCommandResultSchema.safeParse({
        ...result,
        receipt: { ...result.receipt, fidelity: "screen" },
      }).success,
    ).toBe(false);
    expect(
      UpdateHostConvergenceCommandResultSchema.safeParse({
        ...result,
        receipt: {
          ...result.receipt,
          actualInventory: commitment.incumbent.inventory,
          handoffReceipt: {
            terminals: authorized.map((identity) => ({
              ...identity,
              sessionId: `${identity.sessionId}-replacement`,
            })),
          },
        },
      }).success,
    ).toBe(false);
  });
});

function handoffPlan(fidelity: "processes" | "screen") {
  return {
    schemaVersion: 1 as const,
    selectedTarget: {
      artifact: { version: "2.0.0" },
      buildIdentity: { status: "known" as const, value: "b".repeat(64) },
    },
    installation: { owner: "installer-binary" as const, action: "no-op" as const },
    status: "actionable" as const,
    digest: {
      algorithm: "sha256" as const,
      canonicalizationVersion: 1 as const,
      value: "c".repeat(64),
    },
    components: {
      hooks: [],
      observer: { action: "no-op" as const, reason: "matching-healthy" as const },
      terminals: {
        action: "preserve-via-handoff" as const,
        reason: "all-bridge-releasable" as const,
        fidelity,
        liveCount: 1,
        recoverableCount: 1,
        nonResumableCount: 0,
        unknownRecoveryCount: 0,
      },
      host: { action: "handoff" as const, reason: "busy-handoff" as const, fidelity },
      recovery: { relevance: "not-required" as const, status: "not-required" as const },
      reconcile: { action: "run" as const, reason: "runtime-change" as const },
      verification: { action: "reinspect" as const, reason: "reinspect-after-actions" as const },
    },
    phases: [
      {
        id: "artifact-application" as const,
        action: "no-op" as const,
        reason: "already-selected" as const,
      },
      { id: "hook-reconciliation" as const, action: "no-op" as const, reason: "healthy" as const },
      {
        id: "observer-convergence" as const,
        action: "no-op" as const,
        reason: "matching-healthy" as const,
      },
      {
        id: "terminal-convergence" as const,
        action: "preserve-via-handoff" as const,
        reason: "all-bridge-releasable" as const,
      },
      {
        id: "host-convergence" as const,
        action: "handoff" as const,
        reason: "busy-handoff" as const,
      },
      {
        id: "runtime-reconcile" as const,
        action: "run" as const,
        reason: "runtime-change" as const,
      },
      {
        id: "verification" as const,
        action: "reinspect" as const,
        reason: "reinspect-after-actions" as const,
      },
    ],
  };
}
