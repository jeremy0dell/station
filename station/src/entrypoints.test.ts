import { describe, expect, it } from "bun:test";

const shutdownSignals = ["exit", "SIGINT", "SIGTERM"] as const;

describe("Station process entrypoints", () => {
  it("imports without starting renderers, clients, sockets, or shutdown handlers", async () => {
    await import("@opentui/core");
    const resourcesBefore = process.getActiveResourcesInfo();
    const listenersBefore = shutdownSignals.map((signal) => process.listenerCount(signal));

    const [station, dashboard, host] = await Promise.all([
      import("./main.js"),
      import("./dashboardRenderer/main.js"),
      import("./host/hostMain.js"),
    ]);

    expect(process.getActiveResourcesInfo()).toEqual(resourcesBefore);
    expect(shutdownSignals.map((signal) => process.listenerCount(signal))).toEqual(listenersBefore);
    expect(typeof station.runStationMain).toBe("function");
    expect(typeof dashboard.runDashboardMain).toBe("function");
    expect(typeof host.runStationHostMain).toBe("function");
  });
});
