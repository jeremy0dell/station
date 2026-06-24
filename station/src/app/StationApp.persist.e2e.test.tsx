import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStation, StationApp } from "./createStation.js";
import { NO_OP_CLIPBOARD_EFFECTS } from "../copy/testing.js";
import { readLayoutSnapshotSync, writeLayoutSnapshotSync } from "../state/layout/layoutPersistence.js";
import { planLayoutRestoreColdShells } from "../state/layout/restoreLayout.js";
import { createStationStore } from "../state/store.js";
import { MAIN_PANE_ID } from "../state/types.js";
import { createScriptedTerminal } from "../terminal/testing/scriptedTerminal.js";
import { waitFor } from "../terminal/testing/waitFor.js";
import { manyProjectsSnapshot } from "../station/fixtures/scenarios.js";
import { FakeStationSource } from "../station/test/support/fakeStationSource.js";
import { FakeTuiObserverService } from "../station/test/support/fakeObserverService.js";
import type { StationStore } from "../state/store.js";

const SURFACE = { width: 100, height: 28 };
const teardowns: Array<() => void> = [];

afterEach(() => {
  for (const teardown of teardowns.splice(0)) {
    teardown();
  }
});

// A composition wired with real layout persistence to `layoutPath` + the real
// OpenTUI test renderer, so input chords drive the production write path.
async function bootStation(layoutPath: string, store: StationStore) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  const source = new FakeStationSource(manyProjectsSnapshot());
  const scripted = createScriptedTerminal();
  const composition = createStation({
    store,
    clipboardEffects: NO_OP_CLIPBOARD_EFFECTS,
    stationClient: {
      state: source,
      service: new FakeTuiObserverService(manyProjectsSnapshot()),
      start: () => source.start(),
      stop: () => source.stop(),
    },
    shutdown: () => {},
    createTerminal: () => scripted.terminal,
    layout: { path: layoutPath, debounceMs: 5 },
  });
  const setup = await testRender(<StationApp {...composition.viewProps} />, {
    ...SURFACE,
    prependInputHandlers: [composition.stationInput.handleSequence],
    kittyKeyboard: false,
  });
  teardowns.push(() => {
    composition.dispose();
    setup.renderer.destroy();
  });
  composition.start();
  await setup.flush();
  return { composition, setup, store };
}

describe("Station layout persistence end-to-end (renderer + disk + restart)", () => {
  it("persists a real split chord and restores the geometry on a cold restart", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "station-persist-e2e-"));
    const layoutPath = join(stateDir, "layout.json");
    try {
      // --- boot 1: split the boot pane via the production input handler ---
      const first = await bootStation(layoutPath, createStationStore());
      first.composition.stationInput.handleSequence("\x1c"); // Ctrl-\ → split right
      first.composition.stationInput.handleSequence("\x1e"); // Ctrl-^ → split below

      // The debounced writer flushes the new geometry to disk.
      await waitFor(() => {
        const snapshot = readLayoutSnapshotSync(layoutPath);
        return snapshot?.panes.length === 3;
      });
      const persisted = readLayoutSnapshotSync(layoutPath);
      expect(persisted?.panes.map((p) => p.id)).toEqual([MAIN_PANE_ID, "pane-split-0", "pane-split-1"]);
      expect(persisted?.activePaneId).toBe("pane-split-1");

      // Tear down boot 1 (real process exit would flush; dispose() does too).
      for (const teardown of teardowns.splice(0)) {
        teardown();
      }

      // --- boot 2: cold restart reads the file and restores the geometry ---
      const restored = readLayoutSnapshotSync(layoutPath);
      expect(restored).not.toBeUndefined();
      const plan = planLayoutRestoreColdShells(restored!);
      const restoredStore = createStationStore({ initialWorkspace: plan.workspace });
      const second = await bootStation(layoutPath, restoredStore);

      // All three shells are back, in order, with their splits and active pane.
      const panes = second.store.getState().workspace.panes;
      expect(panes.map((p) => p.id)).toEqual([MAIN_PANE_ID, "pane-split-0", "pane-split-1"]);
      expect(panes[1]?.split).toEqual({ anchorPaneId: MAIN_PANE_ID, direction: "right" });
      expect(panes[2]?.split).toEqual({ anchorPaneId: "pane-split-0", direction: "below" });
      expect(second.store.getState().workspace.activePaneId).toBe("pane-split-1");

      // A fresh split after restore does not collide with the restored ids.
      second.composition.stationInput.handleSequence("\x1c");
      expect(second.store.getState().workspace.panes.map((p) => p.id)).toContain("pane-split-2");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
