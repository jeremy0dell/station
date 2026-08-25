import { describe, expect, it } from "bun:test";
import {
  layoutWorktreeRowGrid,
  selectDashboardTree,
} from "@station/dashboard-core/selectors";
import { createInitialTuiState } from "@station/dashboard-core/state";
import { groupedManyProjectsSnapshot } from "../fixtures/scenarios.js";
import { createDashboardRowGridProjector } from "./dashboardRowGridProjection.js";

describe("dashboard row-grid projection", () => {
  it("does not renegotiate all leaf widths for renderer-only visibility updates", () => {
    const snapshot = groupedManyProjectsSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const tree = selectDashboardTree(snapshot, state, state.screen);
    let layoutCalls = 0;
    const projector = createDashboardRowGridProjector((input) => {
      layoutCalls += 1;
      return layoutWorktreeRowGrid(input);
    });

    const first = projector.project(tree, 100);
    for (let update = 0; update < 200; update += 1) {
      expect(projector.project(tree, 100)).toBe(first);
    }

    // One full-width and one Group-frame-width negotiation initialize the cache.
    expect(layoutCalls).toBe(2);
    expect(projector.project(tree, 80)).not.toBe(first);
    expect(layoutCalls).toBe(4);

    const filteredTree = selectDashboardTree(
      snapshot,
      { ...state, persistentFilter: { query: "runtime" } },
      state.screen,
    );
    expect(projector.project(filteredTree, 80)).not.toBe(first);
    expect(layoutCalls).toBe(6);
  });
});
