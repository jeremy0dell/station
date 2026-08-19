import { describe, expect, it } from "vitest";
import { dashboardRowIds } from "../../../../src/selectors/dashboardTree.js";
import { createInitialTuiState, replaceSnapshot } from "../../../../src/state/screen.js";
import {
  activateSessionGroupMenuAction,
  GROUP_MENU_ITEMS,
  handleGroupMenuAction,
  handleGroupMenuKey,
  openGroupMenu,
} from "../../../../src/state/screens/groupMenu.js";
import { handleTuiKey } from "../../../../src/state/transition.js";
import type { DashboardState } from "../../../../src/state/types.js";
import { createGroupedDashboardSnapshot } from "../../../fixtures/snapshots.js";

describe("Group menu", () => {
  it("owns Q/N/S/R order and keyboard shortcuts", () => {
    expect(GROUP_MENU_ITEMS).toEqual([
      expect.objectContaining({ id: "quickSession", shortcut: "Q" }),
      expect.objectContaining({ id: "newSession", shortcut: "N" }),
      expect.objectContaining({ id: "settings", shortcut: "S" }),
      expect.objectContaining({ id: "remove", shortcut: "R", danger: true }),
    ]);
  });

  it("opens on Quick Session, wraps focus, and closes to the Group menu cell", () => {
    const opened = openGroupMenu(baseState(), "group_active");
    const wrapped = handleGroupMenuKey(opened, { input: "", upArrow: true }).state;
    const closed = handleGroupMenuAction(opened, "cancel").state;

    expect(opened.screen).toEqual({
      name: "groupMenu",
      projectId: "web",
      groupId: "group_active",
      focus: "quickSession",
    });
    expect(wrapped.screen).toMatchObject({ name: "groupMenu", focus: "remove" });
    expect(closed.screen).toEqual({ name: "dashboard" });
    expect(closed.dashboardFocus).toEqual({
      rowId: dashboardRowIds.group("group_active"),
      cellId: "menu",
    });
  });

  it("routes Q and focused Enter through the same Group Quick Session operation", () => {
    const opened = openGroupMenu(baseState(), "group_active");
    const direct = handleGroupMenuKey(opened, { input: "Q" });
    const focused = handleGroupMenuKey(opened, { input: "\r", return: true });

    for (const transition of [direct, focused]) {
      expect(transition.state.screen).toEqual({ name: "dashboard" });
      expect(transition.state.dashboardFocus).toEqual({
        rowId: dashboardRowIds.group("group_active"),
        cellId: "menu",
      });
      expect(transition.operations).toEqual([
        expect.objectContaining({
          type: "quickCreateSessionInGroup",
          groupId: "group_active",
          fallbackCell: "menu",
        }),
      ]);
    }
  });

  it("opens New Session with a current root Group preselected", () => {
    const transition = handleGroupMenuKey(openGroupMenu(baseState(), "group_active"), {
      input: "N",
    });

    expect(transition.state.screen).toMatchObject({
      name: "newSession",
      flow: {
        selectedProjectId: "web",
        groupSelection: { kind: "existing", groupId: "group_active" },
      },
    });
    expect(transition.state.dashboardFocus).toEqual({
      rowId: dashboardRowIds.group("group_active"),
      cellId: "menu",
    });
  });

  it("fails closed instead of opening an ungrouped New Session for a nested Group", () => {
    const transition = activateSessionGroupMenuAction(baseState(), {
      projectId: "web",
      groupId: "group_build",
      actionId: "newSession",
    });

    expect(transition.state.screen).toEqual({ name: "dashboard" });
    expect(transition.state.toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: "Nested Groups cannot receive a new session.",
    });
  });

  it("opens General and Remove Group through existing Group Settings state", () => {
    for (const [actionId, section] of [
      ["settings", "general"],
      ["remove", "remove"],
    ] as const) {
      const transition = handleGroupMenuAction(
        openGroupMenu(baseState(), "group_active"),
        actionId,
      );
      expect(transition.state.screen).toMatchObject({
        name: "groupSettings",
        projectId: "web",
        groupId: "group_active",
        section,
        ...(actionId === "remove"
          ? { focus: "detail", detailFocus: "removeConfirm" }
          : { focus: "list" }),
      });
      if (actionId === "remove") {
        const typed = handleTuiKey(transition.state, { input: "d" }).state;
        expect(groupSettingsScreen(typed).removeDraft.value).toBe("d");
      }
    }
  });

  it("rejects stale and cross-project native targets", () => {
    const stale = activateSessionGroupMenuAction(baseState(), {
      projectId: "web",
      groupId: "missing",
      actionId: "settings",
    });
    const mismatched = activateSessionGroupMenuAction(baseState(), {
      projectId: "api",
      groupId: "group_active",
      actionId: "settings",
    });

    expect(stale.state.screen).toEqual({ name: "dashboard" });
    expect(stale.state.toasts.at(-1)?.toast.message).toBe("The selected Group no longer exists.");
    expect(mismatched.state.toasts.at(-1)?.toast.message).toBe(
      "The selected Group belongs to another project.",
    );
  });

  it("does not let a delayed native action clobber another active screen", () => {
    const state = { ...baseState(), screen: { name: "help" as const } };

    expect(
      activateSessionGroupMenuAction(state, {
        projectId: "web",
        groupId: "group_active",
        actionId: "remove",
      }),
    ).toEqual({ state });
  });

  it("closes an open menu when canonical state removes its Group", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const opened = openGroupMenu(
      createInitialTuiState({ initialSnapshot: snapshot }),
      "group_active",
    );
    const withoutGroup = {
      ...snapshot,
      sessionGroups: snapshot.sessionGroups.filter((group) => group.id !== "group_active"),
    };

    expect(replaceSnapshot(opened, withoutGroup).screen).toEqual({ name: "dashboard" });
  });
});

function groupSettingsScreen(state: DashboardState) {
  if (state.screen.name !== "groupSettings") throw new Error("expected Group Settings");
  return state.screen;
}

function baseState() {
  return createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() });
}
