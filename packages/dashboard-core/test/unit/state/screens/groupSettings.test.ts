import { describe, expect, it } from "vitest";
import { createEditableTextInputState } from "../../../../src/components/EditableTextInput/editing.js";
import { createInitialTuiState, replaceSnapshot } from "../../../../src/state/screen.js";
import {
  cancelGroupSettings,
  openGroupSettings,
  removeSessionGroupConfirmPhrase,
  selectGroupSettingsSection,
  submitGroupSettings,
  toggleGroupSettingsSession,
} from "../../../../src/state/screens/groupSettings.js";
import { handleTuiKey } from "../../../../src/state/transition.js";
import type { DashboardState } from "../../../../src/state/types.js";
import { createGroupedDashboardSnapshot } from "../../../fixtures/snapshots.js";

function opened(section: "general" | "sessions" | "remove" = "general"): DashboardState {
  return openGroupSettings(
    createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() }),
    "group_active",
    section,
  );
}

describe("Group Settings screen", () => {
  it("opens by stable identity and anchors dashboard focus to the Group menu", () => {
    const state = opened();
    expect(state.screen).toMatchObject({
      name: "groupSettings",
      projectId: "web",
      groupId: "group_active",
      section: "general",
      focus: "list",
      expectedVersion: 1,
      baselineName: "Active work",
    });
    expect(state.dashboardFocus).toEqual({ rowId: "group:group_active", cellId: "menu" });
  });

  it("keeps a draft at a navigation bound and reseeds it only after changing sections", () => {
    const editing: DashboardState = {
      ...opened(),
      screen: {
        ...groupScreen(opened()),
        nameDraft: createEditableTextInputState("Abandoned"),
      },
    };
    const clamped = handleTuiKey(editing, { input: "", upArrow: true }).state;
    expect(groupScreen(clamped).nameDraft.value).toBe("Abandoned");

    const sessions = handleTuiKey(clamped, { input: "S" }).state;
    expect(groupScreen(sessions)).toMatchObject({ section: "sessions", focus: "list" });
    const general = handleTuiKey(sessions, { input: "G" }).state;
    expect(groupScreen(general).nameDraft.value).toBe("Active work");
  });

  it("moves focus without changing staged membership", () => {
    const state = selectGroupSettingsSection(opened(), "sessions");
    const before = groupScreen(state);
    const moved = handleTuiKey(state, { input: "", downArrow: true }).state;
    const after = groupScreen(moved);

    expect(after.sessionCursor).not.toBe(before.sessionCursor);
    expect(after.desiredSessionIds).toEqual(before.desiredSessionIds);
  });

  it("stages one atomic add/remove delta with original assignment expectations", () => {
    let state = selectGroupSettingsSection(opened(), "sessions");
    state = toggleGroupSettingsSession(state, "ses_wt_web_attention");
    state = toggleGroupSettingsSession(state, "ses_wt_web_working");

    const transition = submitGroupSettings(state);

    expect(transition.operations).toEqual([
      {
        type: "updateSessionGroupMembership",
        projectId: "web",
        groupId: "group_active",
        command: {
          type: "sessionGroup.updateMembership",
          payload: {
            projectId: "web",
            groupId: "group_active",
            expectedVersion: 1,
            add: [
              {
                sessionId: "ses_wt_web_working",
                expectedGroupId: "group_build",
              },
            ],
            remove: [
              {
                sessionId: "ses_wt_web_attention",
                expectedGroupId: "group_active",
              },
            ],
          },
        },
      },
    ]);
    expect(groupScreen(transition.state)).toMatchObject({
      pending: "membership",
      detailFocus: "membershipSave",
    });
  });

  it("allows empty desired membership and emits no command for an unchanged selection", () => {
    const unchanged = selectGroupSettingsSection(opened(), "sessions");
    expect(submitGroupSettings(unchanged).operations).toBeUndefined();

    let empty = unchanged;
    empty = toggleGroupSettingsSession(empty, "ses_wt_web_attention");
    empty = toggleGroupSettingsSession(empty, "ses_wt_web_idle");
    const command = submitGroupSettings(empty).operations?.[0];
    expect(command).toMatchObject({
      type: "updateSessionGroupMembership",
      command: {
        payload: {
          remove: [
            { sessionId: "ses_wt_web_attention", expectedGroupId: "group_active" },
            { sessionId: "ses_wt_web_idle", expectedGroupId: "group_active" },
          ],
        },
      },
    });
  });

  it("builds one rename command and retains the settings surface pending", () => {
    const state: DashboardState = {
      ...selectGroupSettingsSection(opened(), "general"),
      screen: {
        ...groupScreen(selectGroupSettingsSection(opened(), "general")),
        nameDraft: createEditableTextInputState("Renamed Group"),
        detailFocus: "name",
      },
    };
    const transition = handleTuiKey(state, { input: "\r", return: true });
    expect(transition.operations).toEqual([
      {
        type: "renameSessionGroup",
        projectId: "web",
        groupId: "group_active",
        command: {
          type: "sessionGroup.rename",
          payload: {
            projectId: "web",
            groupId: "group_active",
            expectedVersion: 1,
            name: "Renamed Group",
          },
        },
      },
    ]);
    expect(groupScreen(transition.state)).toMatchObject({
      pending: "rename",
      nameDraft: { value: "Renamed Group" },
    });
  });

  it("requires the typed Group name and dispatches only Group deletion", () => {
    const base = selectGroupSettingsSection(opened("remove"), "remove");
    const unarmed = handleTuiKey(base, { input: "\n", return: true });
    expect(unarmed.operations).toBeUndefined();
    expect(groupScreen(unarmed.state).removeDraft.value).toBe("");
    const phrase = removeSessionGroupConfirmPhrase("Active work");
    const armed: DashboardState = {
      ...base,
      screen: {
        ...groupScreen(base),
        removeDraft: createEditableTextInputState(phrase),
      },
    };
    const deleted = handleTuiKey(armed, { input: "\r", return: true });
    expect(deleted.operations).toEqual([
      {
        type: "deleteSessionGroup",
        projectId: "web",
        groupId: "group_active",
        command: {
          type: "sessionGroup.delete",
          payload: {
            projectId: "web",
            groupId: "group_active",
            expectedVersion: 1,
          },
        },
      },
    ]);
    expect(groupScreen(deleted.state)).toMatchObject({
      pending: "delete",
      removeDraft: { value: phrase },
    });
  });

  it("makes keys and cancellation inert while a mutation is pending", () => {
    const state: DashboardState = {
      ...opened(),
      screen: { ...groupScreen(opened()), pending: "rename" },
    };
    expect(handleTuiKey(state, { input: "S" }).state).toBe(state);
    expect(cancelGroupSettings(state)).toBe(state);
  });

  it("preserves drafts, prunes removed sessions, and closes generically when Group disappears", () => {
    let state = selectGroupSettingsSection(opened(), "sessions");
    state = toggleGroupSettingsSession(state, "ses_wt_web_working");
    const snapshot = createGroupedDashboardSnapshot();
    const prunedSnapshot = {
      ...snapshot,
      sessions: snapshot.sessions.filter((session) => session.id !== "ses_wt_web_working"),
    };
    const pruned = replaceSnapshot(state, prunedSnapshot);
    expect(groupScreen(pruned).baselineAssignments.has("ses_wt_web_working")).toBe(false);
    expect(groupScreen(pruned).desiredSessionIds.has("ses_wt_web_working")).toBe(false);

    const removed = replaceSnapshot(pruned, {
      ...prunedSnapshot,
      sessionGroups: prunedSnapshot.sessionGroups.filter((group) => group.id !== "group_active"),
    });
    expect(removed.screen.name).toBe("dashboard");
  });
});

function groupScreen(state: DashboardState) {
  if (state.screen.name !== "groupSettings") throw new Error("expected Group Settings");
  return state.screen;
}
