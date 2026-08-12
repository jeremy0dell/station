import type { ProjectId, SessionGroupId } from "@station/contracts";
import {
  chooseNewSessionAgentById,
  chooseNewSessionGroupById,
  chooseNewSessionProjectById,
  chooseNewSessionUngrouped,
  createNewSessionNameToken,
  transitionNewSessionFlow,
} from "../../../flows/newSession.js";
import {
  selectNewSessionGroupChoices,
  selectNewSessionProject,
  selectNewSessionProjectChoices,
} from "../../../selectors/selectors.js";
import type { DashboardState } from "../../types.js";
import { flatPickerSpec } from "../flatPicker.js";
import { defineList, type ListRow } from "../types.js";
import { harnessPickerSpec } from "./harnessPicker.js";

export const NEW_SESSION_GROUP_LIST_ID = "newSessionPickGroup";
export const NEW_SESSION_UNGROUPED_CHOICE_ID = "newSessionGroup:ungrouped";
export const NEW_SESSION_CREATE_GROUP_CHOICE_ID = "newSessionGroup:create";

export function newSessionExistingGroupChoiceId(groupId: SessionGroupId): string {
  return `newSessionGroup:existing:${groupId}`;
}

export const newSessionPickProjectListSpec = flatPickerSpec<ProjectId>({
  listId: "newSessionPickProject",
  choices: (state) => {
    if (
      state.screen.name !== "newSession" ||
      state.screen.flow.mode !== "pickProject" ||
      state.snapshot === undefined
    ) {
      return [];
    }
    return selectNewSessionProjectChoices(state.snapshot).map((choice) => ({
      key: choice.key,
      value: choice.value.id,
    }));
  },
  commit: (state, projectId) => {
    if (
      state.screen.name !== "newSession" ||
      state.screen.flow.mode !== "pickProject" ||
      state.snapshot === undefined
    ) {
      return { state };
    }
    const flow = chooseNewSessionProjectById(
      state.screen.flow,
      state.snapshot,
      projectId,
      createNewSessionNameToken(),
    );
    return { state: { ...state, screen: { name: "newSession", flow } } };
  },
});

export const newSessionPickAgentListSpec = harnessPickerSpec({
  listId: "newSessionPickAgent",
  resolveProject: (snapshot, state) => {
    if (state.screen.name !== "newSession" || state.screen.flow.mode !== "pickAgent") {
      return undefined;
    }
    return selectNewSessionProject(snapshot, state.screen.flow.selectedProjectId);
  },
  commit: (state, agentId) => {
    if (
      state.screen.name !== "newSession" ||
      state.screen.flow.mode !== "pickAgent" ||
      state.snapshot === undefined
    ) {
      return { state };
    }
    const flow = chooseNewSessionAgentById(state.screen.flow, state.snapshot, agentId);
    return { state: { ...state, screen: { name: "newSession", flow } } };
  },
});

export const newSessionPickGroupListSpec = defineList({
  listId: NEW_SESSION_GROUP_LIST_ID,
  cursor: true,
  rows: (state): readonly ListRow<string>[] => {
    if (
      state.screen.name !== "newSession" ||
      state.screen.flow.mode !== "pickGroup" ||
      state.snapshot === undefined
    ) {
      return [];
    }
    return [
      { selectable: true, id: NEW_SESSION_UNGROUPED_CHOICE_ID },
      ...selectNewSessionGroupChoices(state.snapshot, state.screen.flow.selectedProjectId).map(
        (choice) => ({
          selectable: true as const,
          id: newSessionExistingGroupChoiceId(choice.value.id),
        }),
      ),
      { selectable: true, id: NEW_SESSION_CREATE_GROUP_CHOICE_ID },
    ];
  },
  slots: (state) => {
    if (
      state.screen.name !== "newSession" ||
      state.screen.flow.mode !== "pickGroup" ||
      state.snapshot === undefined
    ) {
      return [];
    }
    return selectNewSessionGroupChoices(state.snapshot, state.screen.flow.selectedProjectId).map(
      (choice) => ({
        key: choice.key,
        value: newSessionExistingGroupChoiceId(choice.value.id),
      }),
    );
  },
  commit: (state, id) => {
    if (
      state.screen.name !== "newSession" ||
      state.screen.flow.mode !== "pickGroup" ||
      state.snapshot === undefined
    ) {
      return { state };
    }
    if (id === NEW_SESSION_UNGROUPED_CHOICE_ID) {
      return {
        state: {
          ...state,
          screen: { name: "newSession", flow: chooseNewSessionUngrouped(state.screen.flow) },
        },
      };
    }
    if (id === NEW_SESSION_CREATE_GROUP_CHOICE_ID) {
      const flow = transitionNewSessionFlow(state.screen.flow, { type: "editGroupDraft" });
      if (flow === undefined) return { state };
      return {
        state: {
          ...state,
          screen: {
            name: "newSession",
            flow,
          },
        },
      };
    }
    const group = selectNewSessionGroupChoices(
      state.snapshot,
      state.screen.flow.selectedProjectId,
    ).find((choice) => newSessionExistingGroupChoiceId(choice.value.id) === id)?.value;
    if (group === undefined) return { state };
    return {
      state: {
        ...state,
        screen: {
          name: "newSession",
          flow: chooseNewSessionGroupById(state.screen.flow, state.snapshot, group.id),
        },
      },
    };
  },
});

/** Seed the pick-step cursor to the current selection when entering it. */
export function seedNewSessionPickerCursor(state: DashboardState): DashboardState {
  if (state.screen.name !== "newSession") {
    return state;
  }
  const flow = state.screen.flow;
  if (flow.mode === "pickProject") {
    const selection = new Map(state.selection);
    selection.set("newSessionPickProject", flow.selectedProjectId);
    return { ...state, selection };
  }
  if (flow.mode === "pickAgent") {
    const selection = new Map(state.selection);
    selection.set("newSessionPickAgent", flow.selectedHarness);
    return { ...state, selection };
  }
  if (flow.mode === "pickGroup") {
    const selection = new Map(state.selection);
    const selectedId =
      flow.groupSelection.kind === "existing"
        ? newSessionExistingGroupChoiceId(flow.groupSelection.groupId)
        : flow.groupSelection.kind === "create"
          ? NEW_SESSION_CREATE_GROUP_CHOICE_ID
          : NEW_SESSION_UNGROUPED_CHOICE_ID;
    const validIds = newSessionPickGroupListSpec
      .rows(state)
      .flatMap((row) => (row.selectable ? [row.id] : []));
    selection.set(
      NEW_SESSION_GROUP_LIST_ID,
      validIds.includes(selectedId) ? selectedId : NEW_SESSION_UNGROUPED_CHOICE_ID,
    );
    return { ...state, selection };
  }
  return state;
}
