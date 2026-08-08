import { describe, expect, it, vi } from "vitest";
import { createDashboardRuntimeEffectScope } from "../../../src/state/runtimeEffectScope.js";

describe("dashboard runtime effect scope", () => {
  it("closes admission immediately and returns one in-flight settlement", async () => {
    const scope = createDashboardRuntimeEffectScope();
    const gate = deferred();
    const completed: string[] = [];

    expect(
      scope.run(async () => {
        await gate.promise;
        completed.push("settled");
      }),
    ).toBe(true);

    const first = scope.dispose();
    const second = scope.dispose();
    expect(second).toBe(first);
    expect(scope.isOpen()).toBe(false);
    expect(
      scope.run(async () => {
        completed.push("late");
      }),
    ).toBe(false);

    let disposed = false;
    void observeSettlement(first, () => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    gate.resolve();
    await first;
    expect(completed).toEqual(["settled"]);
  });

  it("cancels every owned timeout and blocks late commits", async () => {
    vi.useFakeTimers();
    try {
      const scope = createDashboardRuntimeEffectScope();
      const effects: string[] = [];
      scope.setTimeout(() => {
        effects.push("timer");
      }, 10);
      scope.commit(() => {
        effects.push("open");
      });

      await scope.dispose();
      scope.commit(() => {
        effects.push("closed");
      });
      await vi.runAllTimersAsync();

      expect(effects).toEqual(["open"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains a timer callback admitted immediately before disposal", async () => {
    vi.useFakeTimers();
    try {
      const scope = createDashboardRuntimeEffectScope();
      const gate = deferred();
      const completed: string[] = [];
      scope.setTimeout(async () => {
        await gate.promise;
        completed.push("timer-settled");
      }, 10);

      await vi.advanceTimersByTimeAsync(10);
      const disposal = scope.dispose();
      let disposed = false;
      void observeSettlement(disposal, () => {
        disposed = true;
      });
      await Promise.resolve();
      expect(disposed).toBe(false);

      gate.resolve();
      await disposal;
      expect(completed).toEqual(["timer-settled"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps admitted continuations owned while rejecting separately admitted follow-up work", async () => {
    const scope = createDashboardRuntimeEffectScope();
    const firstGate = deferred();
    const followUpGate = deferred();
    const completed: string[] = [];
    let followUpAdmitted: boolean | undefined;
    scope.run(async () => {
      await firstGate.promise;
      followUpAdmitted = scope.run(() => {
        completed.push("separate-follow-up");
      });
      await followUpGate.promise;
      completed.push("admitted-continuation");
    });

    const disposal = scope.dispose();
    firstGate.resolve();
    await Promise.resolve();
    expect(followUpAdmitted).toBe(false);

    let disposed = false;
    void observeSettlement(disposal, () => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    followUpGate.resolve();
    await disposal;
    expect(completed).toEqual(["admitted-continuation"]);
  });
});

async function observeSettlement(settlement: Promise<void>, observe: () => void): Promise<void> {
  await settlement;
  observe();
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
