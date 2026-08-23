import {
  UpdateHostConvergenceCommandResultSchema,
  UpdateHostConvergenceCommandSchema,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const terminal = (id: string) => ({
  terminalTargetId: `native:wt-${id}`,
  ptyId: `pty-${id}`,
  ptyInstanceId: `ptyi-${id}`,
});

describe("update Host convergence schema", () => {
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
        status: "completed",
        receipt: {
          ensuredBy: "handoff",
          validatedCommitment: busyCommitment,
          actualInventory: busyCommitment.incumbent.inventory,
          handoffReceipt: busyCommitment.incumbent.inventory,
        },
      }),
    ).toMatchObject({ status: "completed", receipt: { ensuredBy: "handoff" } });
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
      status: "completed",
      receipt: {
        ensuredBy: "handoff",
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
  });
});
