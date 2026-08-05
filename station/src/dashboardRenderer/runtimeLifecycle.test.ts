import { describe, expect, it } from "bun:test";
import {
  beginDashboardRendererHotDisposal,
  createDashboardRendererRuntimeLifecycle,
  type DashboardRendererHotSlots,
  waitForDashboardRendererHotDisposal,
} from "./runtimeLifecycle.js";

describe("standalone dashboard renderer lifecycle", () => {
  it("releases renderer resources synchronously and repeat-safely drains before client stop", async () => {
    const dashboard = deferred();
    const order: string[] = [];
    const lifecycle = createDashboardRendererRuntimeLifecycle({
      releaseRendererResources: () => order.push("release"),
      disposeWidgetWrites: async () => {
        order.push("widgets");
      },
      disposeDashboardRuntime: async () => {
        order.push("dashboard");
        await dashboard.promise;
      },
      disposeRuntimeCapabilities: () => {
        order.push("capabilities");
      },
      stopClient: async () => {
        order.push("client");
      },
    });

    const first = lifecycle.dispose();
    const second = lifecycle.dispose();

    expect(second).toBe(first);
    expect(order).toEqual(["release", "dashboard", "widgets"]);
    dashboard.resolve();
    await first;
    expect(order).toEqual(["release", "dashboard", "widgets", "capabilities", "client"]);
  });

  it("starts every cleanup immediately on the non-extendable process exit path", () => {
    const order: string[] = [];
    const lifecycle = createDashboardRendererRuntimeLifecycle({
      releaseRendererResources: () => order.push("release"),
      disposeWidgetWrites: async () => {
        order.push("widgets");
      },
      disposeDashboardRuntime: async () => {
        order.push("dashboard");
      },
      disposeRuntimeCapabilities: () => {
        order.push("capabilities");
      },
      stopClient: async () => {
        order.push("client");
      },
    });

    lifecycle.disposeForProcessExit();

    expect(order).toEqual(["release", "dashboard", "widgets", "capabilities", "client"]);
  });

  it("awaits the prior HMR disposer and keeps a newer hot slot when an old disposer settles", async () => {
    const slots = {} as DashboardRendererHotSlots;
    const oldGate = deferred();
    const newGate = deferred();
    const oldDisposal = beginDashboardRendererHotDisposal(slots, () => oldGate.promise);
    let priorSettled = false;
    void observeSettlement(waitForDashboardRendererHotDisposal(slots), () => {
      priorSettled = true;
    });
    await Promise.resolve();
    expect(priorSettled).toBe(false);

    const newDisposal = beginDashboardRendererHotDisposal(slots, () => newGate.promise);
    oldGate.resolve();
    await oldDisposal;
    expect(slots.__stationDashboardHotDispose).toBe(newDisposal);

    newGate.resolve();
    await newDisposal;
    await Promise.resolve();
    expect(slots.__stationDashboardHotDispose).toBeUndefined();
  });
});

async function observeSettlement(
  settlement: Promise<void>,
  observe: () => void,
): Promise<void> {
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
