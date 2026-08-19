import { describe, expect, it } from "vitest";
import { createWorktreeMutationCoordinator } from "../../src/worktreeMutationCoordinator";

describe("createWorktreeMutationCoordinator", () => {
  it("serializes one worktree while unrelated worktrees continue", async () => {
    const coordinator = createWorktreeMutationCoordinator();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = coordinator.run("project", "wt_a", async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const second = coordinator.run("project", "wt_a", async () => {
      order.push("second");
    });
    await coordinator.run("project", "wt_b", async () => {
      order.push("other");
    });

    expect(order).toEqual(["first:start", "other"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "other", "first:end", "second"]);
  });

  it("holds a reserved worktree until the exact consumer settles", async () => {
    const coordinator = createWorktreeMutationCoordinator({ reservationId: () => "lease_1" });
    const order: string[] = [];
    const reservation = await coordinator.reserve("project", "wt_a", async () => {
      order.push("validated");
      return { generation: 1 };
    });
    const launch = coordinator.run("project", "wt_a", async () => {
      order.push("launch");
    });
    await Promise.resolve();
    expect(order).toEqual(["validated"]);

    await coordinator.consume<{ generation: number }, void>(
      reservation.id,
      "project",
      "wt_a",
      async (value) => {
        expect(value).toEqual({ generation: 1 });
        order.push("remove");
      },
    );
    await launch;
    expect(order).toEqual(["validated", "remove", "launch"]);
  });

  it("does not let reservation expiry release a mutation already consuming it", async () => {
    const coordinator = createWorktreeMutationCoordinator({
      reservationId: () => "lease_1",
      reservationTimeoutMs: 1,
    });
    const reservation = await coordinator.reserve("project", "wt_a", async () => "validated");
    let finishRemove!: () => void;
    const removeGate = new Promise<void>((resolve) => {
      finishRemove = resolve;
    });
    const remove = coordinator.consume(reservation.id, "project", "wt_a", async () => {
      await removeGate;
    });
    let launchStarted = false;
    const launch = coordinator.run("project", "wt_a", async () => {
      launchStarted = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(launchStarted).toBe(false);
    finishRemove();
    await Promise.all([remove, launch]);
    expect(launchStarted).toBe(true);
  });

  it("refuses an unreserved removal while reservation validation is still running", async () => {
    const coordinator = createWorktreeMutationCoordinator({ reservationId: () => "lease_1" });
    let finishValidation!: () => void;
    let markValidationStarted!: () => void;
    const validation = new Promise<void>((resolve) => {
      finishValidation = resolve;
    });
    const validationStarted = new Promise<void>((resolve) => {
      markValidationStarted = resolve;
    });
    const preparing = coordinator.reserve("project", "wt_a", async () => {
      markValidationStarted();
      await validation;
      return "validated";
    });
    await validationStarted;

    await expect(
      coordinator.runUnreserved("project", "wt_a", async () => undefined),
    ).rejects.toMatchObject({ code: "WORKTREE_MUTATION_RESERVED" });
    finishValidation();
    const reservation = await preparing;
    expect(coordinator.cancel(reservation.id)).toBe(true);
  });

  it("refuses an unreserved removal instead of deadlocking its reserved successor", async () => {
    const coordinator = createWorktreeMutationCoordinator({ reservationId: () => "lease_1" });
    const reservation = await coordinator.reserve("project", "wt_a", async () => "validated");

    await expect(
      coordinator.runUnreserved("project", "wt_a", async () => undefined),
    ).rejects.toMatchObject({ code: "WORKTREE_MUTATION_RESERVED" });
    await expect(
      coordinator.consume(reservation.id, "project", "wt_a", async () => "removed"),
    ).resolves.toBe("removed");
  });

  it("cancels an unused reservation and rejects later consumption", async () => {
    const coordinator = createWorktreeMutationCoordinator({ reservationId: () => "lease_1" });
    const reservation = await coordinator.reserve("project", "wt_a", async () => "validated");
    expect(coordinator.cancel(reservation.id)).toBe(true);
    await expect(
      coordinator.consume(reservation.id, "project", "wt_a", async () => undefined),
    ).rejects.toMatchObject({ code: "WORKTREE_REMOVAL_RESERVATION_INVALID" });
  });
});
