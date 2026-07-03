import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { createTuiStore, type TuiStore } from "@station/dashboard-core";
import type { StationSnapshot } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { manyProjectsSnapshot } from "../station/fixtures/scenarios.js";
import { FakeTuiObserverService } from "../station/test/support/fakeObserverService.js";
import { FakeStationSource } from "../station/test/support/fakeStationSource.js";
import { useMergeCelebration } from "./useMergeCelebration.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const SURFACE = { width: 30, height: 4 };

function CelebrationProbe({
  store,
  ttlMs,
}: {
  store: StoreApi<TuiStore>;
  ttlMs: number;
}) {
  const celebration = useMergeCelebration(store, ttlMs);
  return <text>{celebration === undefined ? "quiet" : `pr:${celebration.prNumber}`}</text>;
}

function withMergedPr(snapshot: StationSnapshot, worktreeId: string): StationSnapshot {
  return {
    ...snapshot,
    rows: snapshot.rows.map((row) => {
      const pr = row.worktree.pr;
      if (row.id !== worktreeId || pr === undefined) {
        return row;
      }
      return { ...row, worktree: { ...row.worktree, pr: { ...pr, state: "merged" as const } } };
    }),
  };
}

describe("useMergeCelebration", () => {
  it("celebrates a PR flipping to merged, then quiets after the TTL", async () => {
    const snapshot = manyProjectsSnapshot();
    const source = new FakeStationSource(snapshot);
    const store = createTuiStore({
      source,
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
    });
    // Snapshots flow from the source only once the store is started.
    const detach = store.getState().start();
    const setup = await testRender(<CelebrationProbe store={store} ttlMs={60} />, SURFACE);
    try {
      await setup.flush();
      // Let the hook's effect mount and seed its baseline from the initial
      // snapshot before any update arrives.
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The initial snapshot already holds a merged PR (wt_station_idle #73):
      // first sight never celebrates.
      expect(setup.captureCharFrame()).toContain("quiet");

      source.setSnapshot(withMergedPr(snapshot, "wt_station_working"));
      // The state update commits on the next macrotask beat.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("pr:76");

      await new Promise((resolve) => setTimeout(resolve, 120));
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("quiet");
    } finally {
      detach();
      setup.renderer.destroy();
    }
  });
});
