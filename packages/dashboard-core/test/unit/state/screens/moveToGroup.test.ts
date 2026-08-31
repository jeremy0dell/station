import { describe, expect, it } from "vitest";
import {
  selectMoveToGroupChoices,
  selectMoveToGroupSessionContext,
} from "../../../../src/selectors/sessionGroupChoices.js";
import { createInitialTuiState } from "../../../../src/state/screen.js";
import {
  openMoveToGroupForRow,
  selectMoveToGroupDestination,
} from "../../../../src/state/screens/moveToGroup.js";
import { handleTuiKey } from "../../../../src/state/transition.js";
import { createGroupedDashboardSnapshot } from "../../../fixtures/snapshots.js";

describe("Move to Group screen", () => {
  it("opens from M, then uses the shared canonical session chooser", () => {
    const state = createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() });
    const opened = handleTuiKey(state, { input: "M" }).state;
    expect(opened.screen).toEqual({ name: "moveToGroup", step: "chooseSlot" });

    const chosen = handleTuiKey(opened, { input: "", downArrow: true }).state;
    expect(chosen.dashboardFocus?.rowId).toBe("session:ses_wt_web_attention");
    expect(handleTuiKey(chosen, { input: "\r", return: true }).state.screen).toMatchObject({
      name: "moveToGroup",
      step: "chooseDestination",
      sessionId: "ses_wt_web_attention",
      submitting: false,
    });
  });

  it("lists only same-Project root Groups while retaining nested membership as context", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const state = openMoveToGroupForRow(
      createInitialTuiState({ initialSnapshot: snapshot }),
      "ses_wt_web_working",
    );

    expect(
      selectMoveToGroupSessionContext(snapshot, "ses_wt_web_working")?.currentGroup,
    ).toMatchObject({
      id: "group_build",
      parentGroupId: "group_active",
    });
    expect(
      selectMoveToGroupChoices(snapshot, "ses_wt_web_working").map((choice) => choice.value.id),
    ).toEqual(["group_active", "group_empty"]);
    expect(state.selection.get("moveToGroupDestination")).toBe("moveToGroup:ungrouped");
  });

  it("builds Group-to-Group and Group-to-Ungrouped commands with canonical expectations", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const grouped = openMoveToGroupForRow(
      createInitialTuiState({ initialSnapshot: snapshot }),
      "ses_wt_web_attention",
    );

    expect(selectMoveToGroupDestination(grouped, "group_empty").operations).toEqual([
      {
        type: "moveSessionToGroup",
        sessionId: "ses_wt_web_attention",
        projectId: "web",
        expectedCurrentGroupId: "group_active",
        destinationGroupId: "group_empty",
        command: {
          type: "sessionGroup.updateMembership",
          payload: {
            projectId: "web",
            groupId: "group_empty",
            expectedVersion: 1,
            add: [{ sessionId: "ses_wt_web_attention", expectedGroupId: "group_active" }],
          },
        },
      },
    ]);
    expect(selectMoveToGroupDestination(grouped, null).operations?.[0]).toMatchObject({
      command: {
        payload: {
          groupId: "group_active",
          expectedVersion: 1,
          remove: [{ sessionId: "ses_wt_web_attention", expectedGroupId: "group_active" }],
        },
      },
    });
  });

  it("closes without a command for the current destination", () => {
    const state = openMoveToGroupForRow(
      createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() }),
      "ses_wt_web_attention",
    );
    const transition = selectMoveToGroupDestination(state, "group_active");
    expect(transition.operations).toBeUndefined();
    expect(transition.state.screen).toEqual({ name: "dashboard" });
  });

  it("supports U, N, name entry, submit, Escape, and duplicate-submit suppression", () => {
    const initial = openMoveToGroupForRow(
      createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() }),
      "ses_wt_web_idle",
    );
    expect(handleTuiKey(initial, { input: "U" }).operations?.[0]).toMatchObject({
      type: "moveSessionToGroup",
      destinationGroupId: null,
    });

    const create = handleTuiKey(initial, { input: "N" }).state;
    expect(create.screen).toMatchObject({ name: "moveToGroup", step: "createGroup" });
    const named = handleTuiKey(create, { input: "Fresh" }).state;
    const submitted = handleTuiKey(named, { input: "\r", return: true });
    expect(submitted.operations?.[0]).toMatchObject({
      type: "createSessionGroupForMove",
      sessionId: "ses_wt_web_idle",
      projectId: "web",
      name: "Fresh",
    });
    expect(submitted.state.screen).toMatchObject({ submitting: true });
    expect(handleTuiKey(submitted.state, { input: "\r", return: true }).operations).toBeUndefined();
    expect(handleTuiKey(submitted.state, { input: "", escape: true }).state).toBe(submitted.state);
    expect(handleTuiKey(create, { input: "", escape: true }).state.screen).toMatchObject({
      step: "chooseDestination",
    });
  });
});
