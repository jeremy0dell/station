import type { StationSnapshot } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ObserverCore } from "../../src/reconcile/core";
import { createObserverApi } from "../../src/runtime/api";
import { createObserverEventBus } from "../../src/runtime/eventBus";
import {
  emptyStationSnapshot,
  fakeObserverCommandQueue,
  fakeObserverPersistence,
} from "../support/testObserver";

const now = "2026-05-20T12:00:00.000Z";

describe("observer startup reconcile join", () => {
  it("joins startup reasons onto the in-flight startup scan and rewraps the reason", async () => {
    const { core, scans } = controllableCore();
    const api = createJoinApi(core);

    const startup = api.reconcile("observer.startup");
    const joined = api.reconcile("tui-startup");
    const popup = api.reconcile("popup-open");

    await vi.waitFor(() => expect(scans).toHaveLength(1));
    scans[0]?.resolve(scans[0].snapshot);

    const [startupReceipt, joinedReceipt, popupReceipt] = await Promise.all([
      startup,
      joined,
      popup,
    ]);

    expect(scans.map((scan) => scan.reason)).toEqual(["observer.startup"]);
    expect(startupReceipt.reason).toBe("observer.startup");
    expect(joinedReceipt.reason).toBe("tui-startup");
    expect(popupReceipt.reason).toBe("popup-open");
    expect(joinedReceipt.snapshot).toBe(startupReceipt.snapshot);
    expect(popupReceipt.snapshot).toBe(startupReceipt.snapshot);
    expect(joinedReceipt.reconciledAt).toBe(startupReceipt.reconciledAt);
  });

  it("never joins bare or scheduler reasons and stops joining once the flight settles", async () => {
    const { core, scans } = controllableCore();
    const api = createJoinApi(core);

    const startup = api.reconcile("observer.startup");
    const interval = api.reconcile("interval");
    const unnamed = api.reconcile();
    // Non-joinable reconciles run their own scans while startup is pending
    // (a bare reconcile reaches the core with the "manual" default).
    await vi.waitFor(() => expect(scans).toHaveLength(3));
    expect(scans.map((scan) => scan.reason).sort()).toEqual([
      "interval",
      "manual",
      "observer.startup",
    ]);

    for (const scan of scans) {
      scan.resolve(scan.snapshot);
    }
    const [startupReceipt, intervalReceipt, unnamedReceipt] = await Promise.all([
      startup,
      interval,
      unnamed,
    ]);
    expect(intervalReceipt.reason).toBe("interval");
    expect(intervalReceipt.snapshot).not.toBe(startupReceipt.snapshot);
    expect(unnamedReceipt.snapshot).not.toBe(startupReceipt.snapshot);

    // Let the settled flight's clear handler run before the late reconcile.
    await new Promise((resolve) => setImmediate(resolve));
    const late = api.reconcile("tui-startup");
    await vi.waitFor(() => expect(scans.map((scan) => scan.reason)).toContain("tui-startup"));
    const lateScan = scans.find((scan) => scan.reason === "tui-startup");
    lateScan?.resolve(lateScan.snapshot);
    const lateReceipt = await late;
    expect(lateReceipt.reason).toBe("tui-startup");
    expect(lateReceipt.snapshot).not.toBe(startupReceipt.snapshot);
  });
});

type ControlledScan = {
  reason: string | undefined;
  snapshot: StationSnapshot;
  resolve: (value: StationSnapshot) => void;
};

function controllableCore(): { core: ObserverCore; scans: ControlledScan[] } {
  const scans: ControlledScan[] = [];
  const core: ObserverCore = {
    reconcile: (reason) =>
      new Promise<StationSnapshot>((resolve) => {
        scans.push({ reason, snapshot: emptyStationSnapshot(now), resolve });
      }),
    projectHarnessEventStatus: async () => ({ projected: false, events: [] }),
    clearTurnReadiness: () => undefined,
    updateConfig: () => undefined,
    getProjects: () => [],
    getSnapshot: () => emptyStationSnapshot(now),
    getHealth: () => ({
      status: "healthy",
      startedAt: now,
      providerHealth: {},
    }),
  };
  return { core, scans };
}

function createJoinApi(core: ObserverCore) {
  return createObserverApi({
    core,
    persistence: fakeObserverPersistence(),
    persistenceHealth: {
      health: () => ({
        path: ":memory:",
        open: true,
        status: "healthy",
        schemaVersion: 0,
        lastCheckedAt: now,
      }),
    },
    commandQueue: fakeObserverCommandQueue(),
    eventBus: createObserverEventBus(),
    clock: { now: () => new Date(now) },
    metadataRefresh: {
      refresh: async () => undefined,
      shutdown: async () => undefined,
    },
  });
}
