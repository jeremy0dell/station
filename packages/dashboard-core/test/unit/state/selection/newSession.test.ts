import { describe, expect, it } from "vitest";
import { createInitialTuiState, replaceSnapshot } from "../../../../src/state/screen.js";
import { openNewSession } from "../../../../src/state/screens/dashboard.js";
import {
  NEW_SESSION_CREATE_GROUP_CHOICE_ID,
  NEW_SESSION_GROUP_LIST_ID,
  NEW_SESSION_UNGROUPED_CHOICE_ID,
  newSessionExistingGroupChoiceId,
  newSessionPickGroupListSpec,
} from "../../../../src/state/selection/specs/newSession.js";
import { handleTuiKey } from "../../../../src/state/transition.js";
import { createGroupedDashboardSnapshot } from "../../../fixtures/snapshots.js";

describe("New Session Group selection", () => {
  it("lists only same-project root Groups and commits slots, direct keys, and the cursor", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const review = openNewSession(createInitialTuiState({ initialSnapshot: snapshot })).state;
    const picker = handleTuiKey(review, { input: "G" }).state;

    expect(newSessionPickGroupListSpec.rows(picker)).toEqual([
      { selectable: true, id: NEW_SESSION_UNGROUPED_CHOICE_ID },
      { selectable: true, id: newSessionExistingGroupChoiceId("group_active") },
      { selectable: true, id: newSessionExistingGroupChoiceId("group_empty") },
      { selectable: true, id: NEW_SESSION_CREATE_GROUP_CHOICE_ID },
    ]);
    expect(picker.selection.get(NEW_SESSION_GROUP_LIST_ID)).toBe(NEW_SESSION_UNGROUPED_CHOICE_ID);

    const bySlot = handleTuiKey(picker, { input: "1" }).state;
    expect(bySlot.screen).toMatchObject({
      name: "newSession",
      flow: {
        mode: "review",
        reviewFocus: "group",
        groupSelection: { kind: "existing", groupId: "group_active" },
      },
    });

    const preselected = openNewSession(createInitialTuiState({ initialSnapshot: snapshot }), {
      projectId: "web",
      groupId: "group_active",
    }).state;
    const preselectedPicker = handleTuiKey(preselected, { input: "G" }).state;
    const moved = handleTuiKey(preselectedPicker, { input: "", downArrow: true }).state;
    expect(moved.selection.get(NEW_SESSION_GROUP_LIST_ID)).toBe(
      newSessionExistingGroupChoiceId("group_empty"),
    );
    expect(handleTuiKey(moved, { input: "\r", return: true }).state.screen).toMatchObject({
      flow: { groupSelection: { kind: "existing", groupId: "group_empty" } },
    });

    expect(handleTuiKey(preselectedPicker, { input: "U" }).state.screen).toMatchObject({
      flow: { groupSelection: { kind: "ungrouped" } },
    });
  });

  it("edits an inline Group in place and repairs a stale picker cursor", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const preselected = openNewSession(createInitialTuiState({ initialSnapshot: snapshot }), {
      projectId: "web",
      groupId: "group_active",
    }).state;
    const picker = handleTuiKey(preselected, { input: "G" }).state;
    const editing = handleTuiKey(picker, { input: "N" }).state;
    expect(editing.screen).toMatchObject({
      name: "newSession",
      flow: { mode: "editGroupDraft" },
    });

    const typed = " Release "
      .split("")
      .reduce((state, input) => handleTuiKey(state, { input }).state, editing);
    expect(handleTuiKey(typed, { input: "\r", return: true }).state.screen).toMatchObject({
      flow: {
        mode: "review",
        reviewFocus: "group",
        groupSelection: { kind: "create", name: "Release" },
      },
    });

    const removed = {
      ...snapshot,
      sessionGroups: snapshot.sessionGroups.filter((group) => group.id !== "group_active"),
    };
    const repaired = replaceSnapshot(picker, removed);
    expect(repaired.screen).toMatchObject({
      flow: { mode: "pickGroup", groupSelection: { kind: "ungrouped" } },
    });
    expect(repaired.selection.get(NEW_SESSION_GROUP_LIST_ID)).toBe(NEW_SESSION_UNGROUPED_CHOICE_ID);
  });
});
