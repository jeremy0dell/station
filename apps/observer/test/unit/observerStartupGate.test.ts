import { describe, expect, it, vi } from "vitest";
import { createObserverStartupGate } from "../../src/runtime/main.js";

describe("observer startup gate", () => {
  it("keeps a pre-ready stop terminal while allowing shutdown to await startup settlement", async () => {
    const gate = createObserverStartupGate();
    let shutdownReleased = false;
    void gate.waitUntilSettled().then(() => {
      shutdownReleased = true;
    });

    gate.requestStop();
    await Promise.resolve();
    expect(shutdownReleased).toBe(false);

    expect(gate.settleReady()).toBe(false);
    await gate.waitUntilSettled();
    expect(shutdownReleased).toBe(true);
  });

  it("releases health only when startup becomes ready", async () => {
    const gate = createObserverStartupGate();
    const health = vi.fn(async () => "healthy");
    const healthResult = gate.runHealth(health);

    expect(health).not.toHaveBeenCalled();
    expect(gate.settleReady()).toBe(true);

    await expect(healthResult).resolves.toBe("healthy");
    expect(health).toHaveBeenCalledOnce();
  });
});
