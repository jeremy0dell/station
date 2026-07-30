import { pastedPathCandidate } from "./input.js";
import { addProjectRows } from "./rows.js";
import type {
  AddProjectEditIdActionFocus,
  AddProjectFailedActionFocus,
  AddProjectFlowState,
  AddProjectReviewActionFocus,
  AddProjectSuccessActionFocus,
} from "./types.js";

export type AddProjectActionId =
  | "start.open"
  | "start.cancel"
  | "choose.choose"
  | "choose.open"
  | "choose.parent"
  | "choose.search"
  | "choose.cancel"
  | "review.submit"
  | "review.editId"
  | "review.chooseFolder"
  | "review.cancel"
  | "editId.save"
  | "editId.back"
  | "success.dashboard"
  | "failed.retry"
  | "failed.chooseFolder"
  | "failed.cancel";

export type AddProjectActionFocus =
  | AddProjectReviewActionFocus
  | AddProjectEditIdActionFocus
  | AddProjectSuccessActionFocus
  | AddProjectFailedActionFocus;

export type AddProjectActionDescriptor = {
  id: AddProjectActionId;
  label: string;
  compactLabel: string;
  accelerator: string;
  intent: "primary" | "secondary";
  focus?: AddProjectActionFocus;
  enabled: boolean;
};

type AddProjectActionDefinition = Omit<AddProjectActionDescriptor, "enabled">;

const DEFINITIONS: Readonly<Record<AddProjectActionId, AddProjectActionDefinition>> = {
  "start.open": {
    id: "start.open",
    label: "Open",
    compactLabel: "Open",
    accelerator: "→/↵",
    intent: "primary",
  },
  "start.cancel": {
    id: "start.cancel",
    label: "Cancel",
    compactLabel: "Back",
    accelerator: "Esc",
    intent: "secondary",
  },
  "choose.choose": {
    id: "choose.choose",
    label: "Choose",
    compactLabel: "Use",
    accelerator: "↵",
    intent: "primary",
  },
  "choose.open": {
    id: "choose.open",
    label: "Open",
    compactLabel: "Open",
    accelerator: "→",
    intent: "secondary",
  },
  "choose.parent": {
    id: "choose.parent",
    label: "Parent",
    compactLabel: "Up",
    accelerator: "←",
    intent: "secondary",
  },
  "choose.search": {
    id: "choose.search",
    label: "Search",
    compactLabel: "Find",
    accelerator: "/",
    intent: "secondary",
  },
  "choose.cancel": {
    id: "choose.cancel",
    label: "Cancel",
    compactLabel: "Exit",
    accelerator: "Esc",
    intent: "secondary",
  },
  "review.submit": {
    id: "review.submit",
    label: "Add project",
    compactLabel: "Add",
    accelerator: "A",
    intent: "primary",
    focus: "submit",
  },
  "review.editId": {
    id: "review.editId",
    label: "Edit id",
    compactLabel: "Edit",
    accelerator: "N",
    intent: "secondary",
    focus: "editId",
  },
  "review.chooseFolder": {
    id: "review.chooseFolder",
    label: "Choose folder",
    compactLabel: "Choose",
    accelerator: "B",
    intent: "secondary",
    focus: "chooseFolder",
  },
  "review.cancel": {
    id: "review.cancel",
    label: "Cancel",
    compactLabel: "Cancel",
    accelerator: "Esc",
    intent: "secondary",
    focus: "cancel",
  },
  "editId.save": {
    id: "editId.save",
    label: "Save id",
    compactLabel: "Save",
    accelerator: "Ctrl-S",
    intent: "primary",
    focus: "save",
  },
  "editId.back": {
    id: "editId.back",
    label: "Back",
    compactLabel: "Back",
    accelerator: "Esc",
    intent: "secondary",
    focus: "back",
  },
  "success.dashboard": {
    id: "success.dashboard",
    label: "Dashboard",
    compactLabel: "Dashboard",
    accelerator: "D",
    intent: "primary",
    focus: "dashboard",
  },
  "failed.retry": {
    id: "failed.retry",
    label: "Retry",
    compactLabel: "Retry",
    accelerator: "R",
    intent: "primary",
    focus: "retry",
  },
  "failed.chooseFolder": {
    id: "failed.chooseFolder",
    label: "Choose folder",
    compactLabel: "Choose",
    accelerator: "B",
    intent: "secondary",
    focus: "chooseFolder",
  },
  "failed.cancel": {
    id: "failed.cancel",
    label: "Cancel",
    compactLabel: "Cancel",
    accelerator: "Esc",
    intent: "secondary",
    focus: "cancel",
  },
};

const ACTIONS_BY_MODE = {
  start: ["start.open", "start.cancel"],
  choose: ["choose.choose", "choose.open", "choose.parent", "choose.search", "choose.cancel"],
  review: ["review.submit", "review.editId", "review.chooseFolder", "review.cancel"],
  editId: ["editId.save", "editId.back"],
  success: ["success.dashboard"],
  failed: ["failed.retry", "failed.chooseFolder", "failed.cancel"],
} as const satisfies Readonly<Record<string, readonly AddProjectActionId[]>>;

/**
 * Returns the ordered, renderer-neutral controls visible for the current Add Project state.
 * Choose-mode availability follows the canonical selected row when its index is supplied.
 */
export function addProjectActions(
  state: AddProjectFlowState,
  selectedIndex?: number,
): readonly AddProjectActionDescriptor[] {
  const ids =
    state.mode === "review" && state.editingId !== undefined
      ? ACTIONS_BY_MODE.editId
      : ACTIONS_BY_MODE[state.mode];
  return ids.map((id) => ({
    ...DEFINITIONS[id],
    enabled: isActionEnabled(state, id, selectedIndex),
  }));
}

export function addProjectAction(
  state: AddProjectFlowState,
  actionId: AddProjectActionId,
  selectedIndex?: number,
): AddProjectActionDescriptor | undefined {
  return addProjectActions(state, selectedIndex).find((action) => action.id === actionId);
}

function isActionEnabled(
  state: AddProjectFlowState,
  actionId: AddProjectActionId,
  selectedIndex: number | undefined,
): boolean {
  if (state.mode === "start") {
    return actionId !== "start.open" || state.choices.length > 0;
  }
  if (state.mode === "choose") {
    const selectedRow =
      selectedIndex === undefined ? undefined : addProjectRows(state)[selectedIndex];
    if (actionId === "choose.choose") {
      return pastedPathCandidate(state.filter) !== undefined || selectedRow !== undefined;
    }
    if (actionId === "choose.open") {
      return selectedRow !== undefined && selectedRow.kind !== "current";
    }
    if (actionId === "choose.search") return !state.filterMode;
    return true;
  }
  if (state.mode === "review") {
    if (state.submitting) return false;
    if (state.editingId !== undefined) return true;
    return actionId !== "review.submit" || state.gitRoot !== undefined;
  }
  return true;
}
