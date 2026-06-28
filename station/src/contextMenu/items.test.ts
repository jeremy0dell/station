import { describe, expect, it } from "bun:test";
import { createInitialTuiState } from "@station/dashboard-core";
import { createStationStore } from "../state/store.js";
import { agentWorktreePaneId, MAIN_PANE_ID, type StationState } from "../state/types.js";
import { manyProjectsSnapshot } from "../station/fixtures/scenarios.js";
import type { Automation } from "../config/stationConfig.js";
import { buildContextMenuItems, resolveContextMenuAction } from "./items.js";

describe("buildContextMenuItems", () => {
  it("builds pane menu items with split actions enabled", () => {
    const store = createStationStore();
    store.actions.createPane("pane-second");

    const items = buildContextMenuItems({ kind: "pane", paneId: "pane-second" }, store.getState());

    expect(items.map((item) => item.label)).toEqual(["Split Right", "Split Below", "Close Pane"]);
    expect(items[0]?.disabled).toBeUndefined();
    expect(items[1]?.disabled).toBeUndefined();
    expect(items[2]?.disabled).toBeUndefined();
    expect(resolveContextMenuAction(items[0])).toEqual({
      kind: "splitPane",
      paneId: "pane-second",
      direction: "right",
    });
    expect(resolveContextMenuAction(items[1])).toEqual({
      kind: "splitPane",
      paneId: "pane-second",
      direction: "below",
    });
    expect(resolveContextMenuAction(items[2])).toEqual({
      kind: "closePane",
      paneId: "pane-second",
    });
  });

  it("lists enabled automations after the split actions and hides disabled ones", () => {
    const store = createStationStore();
    store.actions.createPane("pane-second");
    const automations: readonly Automation[] = [
      {
        id: "see-diff",
        label: "See diff (split right)",
        enabled: true,
        steps: [
          { split: "right", anchor: "origin", command: "git diff | diffnav", run: "execute", focus: true },
        ],
      },
      {
        id: "off",
        label: "Hidden",
        enabled: false,
        steps: [{ split: "right", anchor: "origin", command: "x", run: "execute", focus: false }],
      },
    ];

    const items = buildContextMenuItems(
      { kind: "pane", paneId: "pane-second" },
      store.getState(),
      undefined,
      automations,
    );

    expect(items.map((item) => item.label)).toEqual([
      "Split Right",
      "Split Below",
      "See diff (split right)",
      "Close Pane",
    ]);
    // Split Right stays index 0 (the default-Enter target); the automation sits
    // after the splits and before the danger Close action.
    expect(resolveContextMenuAction(items[0])).toEqual({
      kind: "splitPane",
      paneId: "pane-second",
      direction: "right",
    });
    expect(resolveContextMenuAction(items[2])).toEqual({
      kind: "runAutomation",
      automationId: "see-diff",
      paneId: "pane-second",
    });
  });

  it("keeps split enabled for the main/last pane while close stays disabled", () => {
    const store = createStationStore(); // only MAIN_PANE_ID exists

    const items = buildContextMenuItems({ kind: "pane", paneId: MAIN_PANE_ID }, store.getState());

    expect(items[0]?.disabled).toBeUndefined();
    expect(items[1]?.disabled).toBeUndefined();
    expect(items[2]?.disabled).toBe(true);
    expect(resolveContextMenuAction(items[0])).toEqual({
      kind: "splitPane",
      paneId: MAIN_PANE_ID,
      direction: "right",
    });
  });

  it("adds rename before pane-management actions for primary-agent panes", () => {
    const store = createStationStore();
    const paneId = agentWorktreePaneId("wt_station_idle");
    store.actions.createPane(paneId, { role: "primary-agent" });

    const items = buildContextMenuItems({ kind: "pane", paneId }, store.getState());

    expect(items.map((item) => item.label)).toEqual([
      "Rename",
      "Split Right",
      "Split Below",
      "Close Pane",
    ]);
    expect(resolveContextMenuAction(items[0])).toEqual({
      kind: "renameSession",
      rowId: "wt_station_idle",
    });
  });

  it("disables close pane for main, last, and unknown panes", () => {
    const mainOnly = createStationStore();
    expect(closeDisabled(MAIN_PANE_ID, mainOnly.getState())).toBe(true);
    expect(closeDisabled("pane-missing", mainOnly.getState())).toBe(true);

    const withSecond = createStationStore();
    withSecond.actions.createPane("pane-second");
    expect(closeDisabled(MAIN_PANE_ID, withSecond.getState())).toBe(true);
    expect(closeDisabled("pane-second", withSecond.getState())).toBe(false);
  });

  it("returns an inert item for header targets", () => {
    const store = createStationStore();
    expect(buildContextMenuItems({ kind: "header" }, store.getState())).toEqual([
      {
        id: "station.noActions",
        label: "No Actions Available",
        disabled: true,
        action: { kind: "noop" },
      },
    ]);
  });

  it("builds STATION row actions for dashboard rows", () => {
    const store = createStationStore();
    const stationState = createInitialTuiState({ initialSnapshot: manyProjectsSnapshot() });

    expect(
      buildContextMenuItems(
        { kind: "station", target: { kind: "row", rowId: "wt_station_idle" } },
        store.getState(),
        stationState,
      ),
    ).toEqual([
      {
        id: "station.renameSession",
        label: "Rename Session",
        action: { kind: "renameSession", rowId: "wt_station_idle" },
      },
      {
        id: "station.forkSession",
        label: "Fork Session",
        action: { kind: "forkSession", rowId: "wt_station_idle" },
      },
      {
        id: "station.removeWorktree",
        label: "Delete Session",
        danger: true,
        action: { kind: "removeWorktree", rowId: "wt_station_idle" },
      },
    ]);
  });

  it("offers remove-worktree for rows without a current session", () => {
    const store = createStationStore();
    const stationState = createInitialTuiState({ initialSnapshot: manyProjectsSnapshot() });

    expect(
      buildContextMenuItems(
        { kind: "station", target: { kind: "row", rowId: "wt_station_none" } },
        store.getState(),
        stationState,
      ),
    ).toEqual([
      {
        id: "station.forkSession",
        label: "Fork Session",
        action: { kind: "forkSession", rowId: "wt_station_none" },
      },
      {
        id: "station.removeWorktree",
        label: "Delete Session",
        danger: true,
        action: { kind: "removeWorktree", rowId: "wt_station_none" },
      },
    ]);
  });

  it("hides remove-worktree for project root rows", () => {
    const store = createStationStore();
    const snapshot = manyProjectsSnapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === "station");
    if (project === undefined) throw new Error("fixture is missing the station project");
    const stationState = createInitialTuiState({
      initialSnapshot: {
        ...snapshot,
        rows: snapshot.rows.map((row) =>
          row.id === "wt_station_idle" ? { ...row, path: project.root } : row,
        ),
      },
    });

    expect(
      buildContextMenuItems(
        { kind: "station", target: { kind: "row", rowId: "wt_station_idle" } },
        store.getState(),
        stationState,
      ),
    ).toEqual([
      {
        id: "station.renameSession",
        label: "Rename Session",
        action: { kind: "renameSession", rowId: "wt_station_idle" },
      },
      {
        id: "station.forkSession",
        label: "Fork Session",
        action: { kind: "forkSession", rowId: "wt_station_idle" },
      },
    ]);
  });

  it("keeps STATION non-row targets inert", () => {
    const store = createStationStore();
    const stationState = createInitialTuiState({ initialSnapshot: manyProjectsSnapshot() });

    for (const target of [
      { kind: "openShellForRow", rowId: "wt_station_idle" } as const,
      { kind: "projectHeader", projectId: "station" } as const,
      { kind: "body" } as const,
    ]) {
      expect(
        buildContextMenuItems({ kind: "station", target }, store.getState(), stationState)[0]?.disabled,
      ).toBe(true);
    }
  });

  it("keeps STATION row actions inert off the dashboard screen", () => {
    const store = createStationStore();
    const stationState = {
      ...createInitialTuiState({ initialSnapshot: manyProjectsSnapshot() }),
      screen: { name: "search", value: "" } as const,
    };

    expect(
      buildContextMenuItems(
        { kind: "station", target: { kind: "row", rowId: "wt_station_idle" } },
        store.getState(),
        stationState,
      )[0]?.disabled,
    ).toBe(true);
  });
});

function closeDisabled(paneId: string, state: StationState): boolean {
  return buildContextMenuItems({ kind: "pane", paneId }, state)[2]?.disabled === true;
}
