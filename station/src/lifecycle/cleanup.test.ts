import { describe, expect, it } from "bun:test";
import { settleCleanupSteps } from "./cleanup.js";

describe("Station cleanup settlement", () => {
  it("starts every release and aggregates synchronous and asynchronous failures", async () => {
    const order: string[] = [];
    const settlement = settleCleanupSteps(
      [
        () => {
          order.push("first");
          throw new Error("first failed");
        },
        async () => {
          order.push("second");
          throw new Error("second failed");
        },
        () => {
          order.push("third");
        },
      ],
      "cleanup failed",
    );

    expect(order).toEqual(["first", "second", "third"]);
    let failure: unknown;
    try {
      await settlement;
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure instanceof AggregateError).toBe(true);
    expect((failure as AggregateError).errors).toHaveLength(2);
  });
});
