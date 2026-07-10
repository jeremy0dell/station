import { describe, expect, it } from "vitest";

describe("process entrypoints", () => {
  it("imports without startup and exposes callable runners", async () => {
    const signalListeners = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };

    const [cli, observer, ingress, observerRuntime] = await Promise.all([
      import("../../src/main.js"),
      import("../../src/observerMain.js"),
      import("../../src/ingressMain.js"),
      import("../../../observer/src/runtime/main.js"),
    ]);

    expect(cli.runCliMain).toBeTypeOf("function");
    expect(cli.runCli).toBeTypeOf("function");
    expect(observer.runCliObserverMain).toBeTypeOf("function");
    expect(ingress.runCliIngressMain).toBeTypeOf("function");
    expect(observerRuntime.runObserverMain).toBeTypeOf("function");
    expect(process.listenerCount("SIGINT")).toBe(signalListeners.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(signalListeners.sigterm);

    await expect(cli.runCli(["--help"])).resolves.toMatchObject({ code: 0 });
  });
});
