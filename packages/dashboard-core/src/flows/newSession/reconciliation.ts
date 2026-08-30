import type { ProjectId } from "@station/contracts";
import { selectNewSessionRootGroup } from "../../selectors/selectors.js";
import type {
  NewSessionFlowState,
  NewSessionGroupSelection,
  NewSessionSnapshotView,
} from "./model.js";

export function reconcileNewSessionFlow(
  state: NewSessionFlowState,
  snapshot: NewSessionSnapshotView,
): NewSessionFlowState {
  const groupSelection = reconcileNewSessionGroupSelection(
    snapshot,
    state.selectedProjectId,
    state.groupSelection,
  );
  return sameGroupSelection(groupSelection, state.groupSelection)
    ? state
    : { ...state, groupSelection };
}

export function reconcileNewSessionGroupSelection(
  snapshot: NewSessionSnapshotView,
  projectId: ProjectId,
  selection: NewSessionGroupSelection,
): NewSessionGroupSelection {
  if (selection.kind !== "existing") return selection;
  return selectNewSessionRootGroup(snapshot, projectId, selection.groupId) === undefined
    ? { kind: "ungrouped" }
    : selection;
}

function sameGroupSelection(
  left: NewSessionGroupSelection,
  right: NewSessionGroupSelection,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "ungrouped") return true;
  if (left.kind === "existing" && right.kind === "existing") {
    return left.groupId === right.groupId;
  }
  return left.kind === "create" && right.kind === "create" && left.name === right.name;
}
