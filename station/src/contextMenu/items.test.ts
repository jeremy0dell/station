import { describe, expect, it } from "bun:test";
import { dashboardRowIds } from "@station/dashboard-core/selectors";
import { createInitialTuiState } from "@station/dashboard-core/state";
import { createStationStore } from "../state/store.js";
import { agentWorktreePaneId, MAIN_PANE_ID, type StationState } from "../state/types.js";
import {
  externalAgentSnapshot,
  manyProjectsSnapshot,
} from "../station/fixtures/scenarios.js";
import type { Automation } from "../config/stationConfig.js";
import { buildContextMenuItems, resolveContextMenuAction } from "./items.js";

const STATION_IDLE_SESSION_ID = "ses_wt_station_idle";

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
          { split: "right", anchor: "origin", command: "echo automation", run: "execute", focus: true },
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
        { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.session(STATION_IDLE_SESSION_ID), cellId: "identity" } },
        store.getState(),
        stationState,
      ),
    ).toEqual([
      {
        id: "station.renameSession",
        label: "Rename Session",
        action: { kind: "renameSession", rowId: STATION_IDLE_SESSION_ID },
      },
      {
        id: "station.moveToGroup",
        label: "Move to Group…",
        action: { kind: "moveToGroup", rowId: STATION_IDLE_SESSION_ID },
      },
      {
        id: "station.forkSession",
        label: "Fork Session",
        action: { kind: "forkSession", rowId: STATION_IDLE_SESSION_ID },
      },
      {
        id: "station.removeWorktree",
        label: "Delete Session",
        danger: true,
        action: { kind: "removeWorktree", rowId: STATION_IDLE_SESSION_ID },
      },
    ]);
  });

  it("keeps collapse-hidden and pending dashboard sessions inert", () => {
    const store = createStationStore();
    const snapshot = manyProjectsSnapshot();
    const session = snapshot.sessions.find(({ id }) => id === STATION_IDLE_SESSION_ID);
    if (session === undefined) throw new Error("fixture is missing the Station session");
    const baseLocalRows = {
      pendingCreate: [],
      failedCreate: [],
      pendingRemove: [],
      pendingStart: [],
    };
    const states = [
      createInitialTuiState({ initialSnapshot: snapshot, collapsedProjectIds: ["station"] }),
      createInitialTuiState({
        initialSnapshot: snapshot,
        localRows: {
          ...baseLocalRows,
          pendingStart: [
            {
              localId: `start:${session.worktreeId}`,
              projectId: session.projectId,
              worktreeId: session.worktreeId,
              branch: "pending-start",
              createdAt: "2026-08-10T00:00:00.000Z",
            },
          ],
        },
      }),
      createInitialTuiState({
        initialSnapshot: snapshot,
        localRows: {
          ...baseLocalRows,
          pendingRemove: [
            {
              localId: `remove:${session.worktreeId}`,
              projectId: session.projectId,
              worktreeId: session.worktreeId,
              branch: "pending-remove",
              createdAt: "2026-08-10T00:00:00.000Z",
            },
          ],
        },
      }),
    ];

    for (const stationState of states) {
      expect(
        buildContextMenuItems(
          {
            kind: "station",
            target: {
              kind: "dashboardCell",
              rowId: dashboardRowIds.session(STATION_IDLE_SESSION_ID),
              cellId: "identity",
            },
          },
          store.getState(),
          stationState,
        ).map(({ id }) => id),
      ).toEqual(["station.noActions"]);
    }
  });

  it("rejects cells that do not belong to the targeted dashboard row", () => {
    const store = createStationStore();
    const stationState = createInitialTuiState({ initialSnapshot: manyProjectsSnapshot() });

    expect(
      buildContextMenuItems(
        {
          kind: "station",
          target: {
            kind: "dashboardCell",
            rowId: dashboardRowIds.session(STATION_IDLE_SESSION_ID),
            cellId: "shell",
          },
        },
        store.getState(),
        stationState,
      ).map(({ id }) => id),
    ).toEqual(["station.noActions"]);
  });

  it("keeps retained Station sessions actionable without a current agent", () => {
    const store = createStationStore();
    const stationState = createInitialTuiState({ initialSnapshot: manyProjectsSnapshot() });

    expect(
      buildContextMenuItems(
        { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.session("ses_wt_station_none"), cellId: "identity" } },
        store.getState(),
        stationState,
      ),
    ).toEqual([
      {
        id: "station.renameSession",
        label: "Rename Session",
        action: { kind: "renameSession", rowId: "ses_wt_station_none" },
      },
      {
        id: "station.moveToGroup",
        label: "Move to Group…",
        action: { kind: "moveToGroup", rowId: "ses_wt_station_none" },
      },
      {
        id: "station.forkSession",
        label: "Fork Session",
        action: { kind: "forkSession", rowId: "ses_wt_station_none" },
      },
      {
        id: "station.removeWorktree",
        label: "Delete Session",
        danger: true,
        action: { kind: "removeWorktree", rowId: "ses_wt_station_none" },
      },
    ]);
  });

  it("keeps bare worktrees out of dashboard row actions", () => {
    const store = createStationStore();
    const stationState = createInitialTuiState({ initialSnapshot: manyProjectsSnapshot() });

    expect(
      buildContextMenuItems(
        { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.session("wt_scripts_none"), cellId: "identity" } },
        store.getState(),
        stationState,
      ),
    ).toEqual([
      {
        id: "station.noActions",
        label: "No Actions Available",
        disabled: true,
        action: { kind: "noop" },
      },
    ]);
  });

  it("labels unstoppable-agent removal as a worktree action", () => {
    const store = createStationStore();
    const stationState = createInitialTuiState({ initialSnapshot: externalAgentSnapshot() });

    const items = buildContextMenuItems(
      { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.session("run_wt_station_idle"), cellId: "identity" } },
      store.getState(),
      stationState,
    );

    expect(items).toEqual([
      {
        id: "station.moveToGroup",
        label: "Move to Group…",
        action: { kind: "moveToGroup", rowId: "run_wt_station_idle" },
      },
      {
        id: "station.forkSession",
        label: "Fork Session",
        action: { kind: "forkSession", rowId: "run_wt_station_idle" },
      },
      {
        id: "station.removeWorktree",
        label: "Delete Worktree…",
        danger: true,
        action: { kind: "removeWorktree", rowId: "run_wt_station_idle" },
      },
    ]);
  });

  it("keeps management actions session-specific when Station and external sessions share a checkout", () => {
    const store = createStationStore();
    const external = externalAgentSnapshot();
    const retained = manyProjectsSnapshot().sessions.find(
      (session) => session.id === STATION_IDLE_SESSION_ID,
    );
    if (retained === undefined) throw new Error("fixture is missing the retained Station session");
    const stationState = createInitialTuiState({
      initialSnapshot: { ...external, sessions: [retained, ...external.sessions] },
    });

    const stationItems = buildContextMenuItems(
      { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.session(retained.id), cellId: "identity" } },
      store.getState(),
      stationState,
    );
    const externalItems = buildContextMenuItems(
      { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.session("run_wt_station_idle"), cellId: "identity" } },
      store.getState(),
      stationState,
    );

    expect(stationItems.map((item) => item.label)).toEqual([
      "Rename Session",
      "Move to Group…",
      "Fork Session",
      "Delete Worktree…",
    ]);
    expect(externalItems.map((item) => item.label)).toEqual([
      "Move to Group…",
      "Fork Session",
      "Delete Worktree…",
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
        { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.session(STATION_IDLE_SESSION_ID), cellId: "identity" } },
        store.getState(),
        stationState,
      ),
    ).toEqual([
      {
        id: "station.renameSession",
        label: "Rename Session",
        action: { kind: "renameSession", rowId: STATION_IDLE_SESSION_ID },
      },
      {
        id: "station.moveToGroup",
        label: "Move to Group…",
        action: { kind: "moveToGroup", rowId: STATION_IDLE_SESSION_ID },
      },
      {
        id: "station.forkSession",
        label: "Fork Session",
        action: { kind: "forkSession", rowId: STATION_IDLE_SESSION_ID },
      },
    ]);
  });

  it("keeps STATION non-row, non-project targets inert", () => {
    const store = createStationStore();
    const stationState = createInitialTuiState({ initialSnapshot: manyProjectsSnapshot() });

    for (const target of [
      { kind: "openShellForRow", rowId: STATION_IDLE_SESSION_ID } as const,
      { kind: "body" } as const,
    ]) {
      expect(
        buildContextMenuItems({ kind: "station", target }, store.getState(), stationState)[0]?.disabled,
      ).toBe(true);
    }
  });

  it("builds project actions for project-header targets", () => {
    const store = createStationStore();
    const stationState = createInitialTuiState({ initialSnapshot: manyProjectsSnapshot() });

    const items = buildContextMenuItems(
      { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.project("station"), cellId: "identity" } },
      store.getState(),
      stationState,
    );

    expect(items.map((item) => item.label)).toEqual([
      "Quick Group",
      "New Group…",
      "Set Default Agent",
      "Project Settings…",
    ]);
    expect(items[0]?.disabled).toBeUndefined();
    expect(resolveContextMenuAction(items[0])).toEqual({
      kind: "quickGroup",
      projectId: "station",
    });
    expect(resolveContextMenuAction(items[1])).toEqual({
      kind: "newGroup",
      projectId: "station",
    });
    expect(resolveContextMenuAction(items[2])).toEqual({
      kind: "setProjectDefaultAgent",
      projectId: "station",
    });
    expect(resolveContextMenuAction(items[3])).toEqual({
      kind: "openProjectSettings",
      projectId: "station",
    });
  });

  it("builds the same Q/N/S/R actions for every Group-header target", () => {
    const store = createStationStore();
    const snapshot = manyProjectsSnapshot();
    const session = snapshot.sessions.find(({ id }) => id === STATION_IDLE_SESSION_ID);
    if (session === undefined) throw new Error("fixture is missing the Station session");
    const stationState = createInitialTuiState({
      initialSnapshot: {
        ...snapshot,
        sessionGroups: [
          {
            id: "grp_station_active",
            projectId: session.projectId,
            name: "Active work",
            sessionIds: [session.id],
            version: 1,
            createdAt: snapshot.generatedAt,
            updatedAt: snapshot.generatedAt,
          },
        ],
      },
    });

    for (const cellId of ["identity", "quickSession", "menu"] as const) {
      const items = buildContextMenuItems(
        {
          kind: "station",
          target: {
            kind: "dashboardCell",
            rowId: dashboardRowIds.group("grp_station_active"),
            cellId,
          },
        },
        store.getState(),
        stationState,
      );

      expect(items.map(({ id }) => id)).toEqual([
        "group.quickSession",
        "group.newSession",
        "group.openSettings",
        "group.remove",
      ]);
      expect(items.map(({ label }) => label)).toEqual([
        "Quick session",
        "New session…",
        "Group settings…",
        "Remove Group…",
      ]);
      expect(items.map(({ shortcut }) => shortcut)).toEqual(["Q", "N", "S", "R"]);
      expect(items[2]?.separatorBefore).toBe(true);
      expect(items[3]).toMatchObject({ separatorBefore: true, danger: true });
      expect(resolveContextMenuAction(items[3])).toEqual({
        kind: "groupMenuAction",
        projectId: "station",
        groupId: "grp_station_active",
        actionId: "remove",
      });
    }
  });

  it("keeps STATION row actions inert off the dashboard screen", () => {
    const store = createStationStore();
    const stationState = {
      ...createInitialTuiState({ initialSnapshot: manyProjectsSnapshot() }),
      screen: {
        name: "persistentFilter",
        draft: { value: "", cursor: 0 },
        draftConditions: [],
      } as const,
    };

    expect(
      buildContextMenuItems(
        { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.session(STATION_IDLE_SESSION_ID), cellId: "identity" } },
        store.getState(),
        stationState,
      )[0]?.disabled,
    ).toBe(true);
  });
});

function closeDisabled(paneId: string, state: StationState): boolean {
  return buildContextMenuItems({ kind: "pane", paneId }, state)[2]?.disabled === true;
}
