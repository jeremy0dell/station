import { describe, expect, it } from "bun:test";
import { createDashboardRendererRuntimeLifecycle } from "./runtimeLifecycle.js";

describe("standalone dashboard renderer lifecycle", () => {
  it("releases renderer resources synchronously and repeat-safely drains before client stop", async () => {
    const dashboard = deferred();
    const order: string[] = [];
    const lifecycle = createDashboardRendererRuntimeLifecycle({
      releaseRendererResources: [() => {
        order.push("release");
      }],
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
    expect(order).toEqual(["release", "dashboard", "widgets", "capabilities"]);
    dashboard.resolve();
    await first;
    expect(order).toEqual(["release", "dashboard", "widgets", "capabilities", "client"]);
  });

  it("disposes capabilities immediately so they can settle admitted dashboard work", async () => {
    const popupRequest = deferred();
    const order: string[] = [];
    const lifecycle = createDashboardRendererRuntimeLifecycle({
      releaseRendererResources: [() => {
        order.push("release");
      }],
      disposeWidgetWrites: async () => {
        order.push("widgets");
      },
      disposeDashboardRuntime: async () => {
        order.push("dashboard");
        try {
          await popupRequest.promise;
        } catch {
          order.push("popup-rejected");
        }
        order.push("dashboard-settled");
      },
      disposeRuntimeCapabilities: () => {
        order.push("capabilities");
        popupRequest.reject(new Error("popup request disposed"));
      },
      stopClient: async () => {
        order.push("client");
      },
    });

    await lifecycle.dispose();

    expect(order).toEqual([
      "release",
      "dashboard",
      "widgets",
      "capabilities",
      "popup-rejected",
      "dashboard-settled",
      "client",
    ]);
  });

  it("isolates failures, returns one aggregate settlement, and still stops the client", async () => {
    const order: string[] = [];
    const lifecycle = createDashboardRendererRuntimeLifecycle({
      releaseRendererResources: [
        () => {
          order.push("release");
          throw new Error("release failed");
        },
        () => {
          order.push("release-after-failure");
        },
      ],
      disposeWidgetWrites: async () => {
        order.push("widgets");
        throw new Error("widgets failed");
      },
      disposeDashboardRuntime: async () => {
        order.push("dashboard");
        throw new Error("dashboard failed");
      },
      disposeRuntimeCapabilities: () => {
        order.push("capabilities");
        throw new Error("capabilities failed");
      },
      stopClient: async () => {
        order.push("client");
        throw new Error("client failed");
      },
    });

    const first = lifecycle.dispose();
    const second = lifecycle.dispose();

    expect(second).toBe(first);
    let failure: unknown;
    try {
      await first;
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure instanceof AggregateError).toBe(true);
    expect(order).toEqual([
      "release",
      "release-after-failure",
      "dashboard",
      "widgets",
      "capabilities",
      "client",
    ]);
  });

  it("starts every cleanup despite synchronous throws on the non-extendable process exit path", async () => {
    const order: string[] = [];
    const lifecycle = createDashboardRendererRuntimeLifecycle({
      releaseRendererResources: [
        () => {
          order.push("release");
          throw new Error("release failed");
        },
        () => {
          order.push("release-after-failure");
        },
      ],
      disposeWidgetWrites: async () => {
        order.push("widgets");
        throw new Error("widgets failed");
      },
      disposeDashboardRuntime: async () => {
        order.push("dashboard");
        throw new Error("dashboard failed");
      },
      disposeRuntimeCapabilities: () => {
        order.push("capabilities");
        throw new Error("capabilities failed");
      },
      stopClient: async () => {
        order.push("client");
        throw new Error("client failed");
      },
    });

    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", observeUnhandled);
    try {
      expect(() => lifecycle.disposeForProcessExit()).not.toThrow();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(order).toEqual([
      "release",
      "release-after-failure",
      "dashboard",
      "widgets",
      "capabilities",
      "client",
    ]);
  });
});

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
