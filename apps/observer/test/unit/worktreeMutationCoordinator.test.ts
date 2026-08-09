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
});
