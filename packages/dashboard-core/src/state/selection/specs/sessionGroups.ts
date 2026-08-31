import { selectMoveToGroupChoices } from "../../../selectors/sessionGroupChoices.js";
import {
  MOVE_TO_GROUP_CREATE_CHOICE_ID,
  MOVE_TO_GROUP_LIST_ID,
  MOVE_TO_GROUP_UNGROUPED_CHOICE_ID,
  moveToGroupExistingChoiceId,
  openMoveToGroupCreate,
  selectMoveToGroupDestination,
} from "../../screens/moveToGroup.js";
import { defineList, type ListRow } from "../types.js";

export const moveToGroupDestinationListSpec = defineList({
  listId: MOVE_TO_GROUP_LIST_ID,
  cursor: true,
  active: (state) =>
    state.screen.name === "moveToGroup" &&
    state.screen.step === "chooseDestination" &&
    !state.screen.submitting,
  rows: (state): readonly ListRow<string>[] => {
    if (
      state.screen.name !== "moveToGroup" ||
      state.screen.step !== "chooseDestination" ||
      state.snapshot === undefined
    ) {
      return [];
    }
    return [
      { selectable: true, id: MOVE_TO_GROUP_UNGROUPED_CHOICE_ID },
      ...selectMoveToGroupChoices(state.snapshot, state.screen.sessionId).map((choice) => ({
        selectable: true as const,
        id: moveToGroupExistingChoiceId(choice.value.id),
      })),
      { selectable: true, id: MOVE_TO_GROUP_CREATE_CHOICE_ID },
    ];
  },
  slots: (state) => {
    if (
      state.screen.name !== "moveToGroup" ||
      state.screen.step !== "chooseDestination" ||
      state.snapshot === undefined
    ) {
      return [];
    }
    return selectMoveToGroupChoices(state.snapshot, state.screen.sessionId).flatMap((choice) =>
      choice.key === undefined
        ? []
        : [{ key: choice.key, value: moveToGroupExistingChoiceId(choice.value.id) }],
    );
  },
  commit: (state, id) => {
    if (
      state.screen.name !== "moveToGroup" ||
      state.screen.step !== "chooseDestination" ||
      state.snapshot === undefined
    ) {
      return { state };
    }
    if (id === MOVE_TO_GROUP_UNGROUPED_CHOICE_ID) return selectMoveToGroupDestination(state, null);
    if (id === MOVE_TO_GROUP_CREATE_CHOICE_ID) return { state: openMoveToGroupCreate(state) };
    const group = selectMoveToGroupChoices(state.snapshot, state.screen.sessionId).find(
      (choice) => moveToGroupExistingChoiceId(choice.value.id) === id,
    )?.value;
    return group === undefined ? { state } : selectMoveToGroupDestination(state, group.id);
  },
});
