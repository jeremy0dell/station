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

    const releaseClaim = vi.fn();
    expect(gate.settleReady(releaseClaim)).toEqual({ status: "stopped" });
    expect(releaseClaim).not.toHaveBeenCalled();
    await gate.waitUntilSettled();
    expect(shutdownReleased).toBe(true);
  });

  it("releases health only when startup becomes ready", async () => {
    const gate = createObserverStartupGate();
    const health = vi.fn(async () => "healthy");
    const healthResult = gate.runHealth(health);
    const order: string[] = [];

    expect(health).not.toHaveBeenCalled();
    expect(
      gate.settleReady(() => {
        order.push("claim-released");
        return { status: "released" };
      }),
    ).toEqual({ status: "ready", claimRelease: { status: "released" } });

    await expect(
      healthResult.then((result) => {
        order.push("health-returned");
        return result;
      }),
    ).resolves.toBe("healthy");
    expect(health).toHaveBeenCalledOnce();
    expect(order).toEqual(["claim-released", "health-returned"]);
  });

  it("keeps health blocked when synchronous claim release fails", async () => {
    const gate = createObserverStartupGate();
    const health = vi.fn(async () => "healthy");
    void gate.runHealth(health);
    const releaseError = new Error("release failed");

    expect(() =>
      gate.settleReady(() => {
        throw releaseError;
      }),
    ).toThrow(releaseError);
    await gate.waitUntilSettled();
    await Promise.resolve();
    expect(health).not.toHaveBeenCalled();
  });

  it("keeps committed health available when claim release reports a partial failure", async () => {
    const gate = createObserverStartupGate();
    const health = vi.fn(async () => "healthy");
    const healthResult = gate.runHealth(health);
    const releaseError = Object.assign(new Error("close failed"), {
      tag: "ObserverBootClaimError",
      code: "OBSERVER_BOOT_CLAIM_RELEASE_FAILED",
    });

    const commit = gate.settleReady(() => ({ status: "failed", error: releaseError }));

    expect(commit).toEqual({
      status: "ready",
      claimRelease: { status: "failed", error: releaseError },
    });
    await expect(healthResult).resolves.toBe("healthy");
    expect(health).toHaveBeenCalledOnce();
  });
});
