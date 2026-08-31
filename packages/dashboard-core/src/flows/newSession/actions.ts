import type { EditableTextEditAction } from "../../components/EditableTextInput/editing.js";
import { editableTextInputIntentForInput } from "../../components/EditableTextInput/editing.js";
import type {
  NewSessionEditGroupDraftStateView,
  NewSessionEditNameFocus,
  NewSessionEditNameStateView,
  NewSessionFlowStateView,
  NewSessionSnapshotView,
} from "./model.js";
import { validateNewSessionCreate } from "./validation.js";

export type NewSessionFlowAction =
  | { type: "editName" }
  | { type: "editNameInput"; action: EditableTextEditAction }
  | { type: "commitName" }
  | { type: "pickProject" }
  | { type: "pickAgent" }
  | { type: "pickGroup" }
  | { type: "editGroupDraft" }
  | { type: "editGroupDraftInput"; action: EditableTextEditAction }
  | { type: "commitGroupDraft" }
  | { type: "chooseUngrouped" }
  | { type: "reviewFocus"; dir: -1 | 1 }
  | { type: "editNameFocusSet"; focus: NewSessionEditNameFocus }
  | { type: "cancel" };

export type NewSessionInputKey = {
  ctrl?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
};

export type NewSessionInput = {
  input: string;
  key: NewSessionInputKey;
  token: string;
};

export type NewSessionInputIntent =
  | {
      type: "transition";
      action: NewSessionFlowAction;
    }
  | {
      type: "submit";
    }
  | {
      type: "none";
    };

type NewSessionActionDefinition =
  | {
      mode: "review" | "editName" | "editGroupDraft";
      intent: "transition";
      action: NewSessionFlowAction;
    }
  | { mode: "review"; intent: "submit" };

const NEW_SESSION_ACTIONS = {
  "review.project": { mode: "review", intent: "transition", action: { type: "pickProject" } },
  "review.name": { mode: "review", intent: "transition", action: { type: "editName" } },
  "review.agent": { mode: "review", intent: "transition", action: { type: "pickAgent" } },
  "review.group": { mode: "review", intent: "transition", action: { type: "pickGroup" } },
  "review.create": { mode: "review", intent: "submit" },
  "editName.name": {
    mode: "editName",
    intent: "transition",
    action: { type: "editNameFocusSet", focus: "name" },
  },
  "editName.save": { mode: "editName", intent: "transition", action: { type: "commitName" } },
  "editName.back": { mode: "editName", intent: "transition", action: { type: "cancel" } },
  "editGroupDraft.save": {
    mode: "editGroupDraft",
    intent: "transition",
    action: { type: "commitGroupDraft" },
  },
  "editGroupDraft.back": {
    mode: "editGroupDraft",
    intent: "transition",
    action: { type: "cancel" },
  },
} as const satisfies Readonly<Record<string, NewSessionActionDefinition>>;

export type NewSessionActionId = keyof typeof NEW_SESSION_ACTIONS;

/** Returns whether a New Session control is visible and currently actionable. */
export function newSessionActionEnabled(
  snapshot: NewSessionSnapshotView | undefined,
  state: NewSessionFlowStateView,
  actionId: NewSessionActionId,
): boolean {
  if (NEW_SESSION_ACTIONS[actionId].mode !== state.mode) return false;
  if (state.mode === "review" && state.submissionLocalId !== undefined) return false;
  if (actionId === "editGroupDraft.save") {
    return state.mode === "editGroupDraft" && state.draftGroupName.value.trim().length > 0;
  }
  return (
    actionId !== "review.create" ||
    (snapshot !== undefined &&
      state.mode === "review" &&
      validateNewSessionCreate(snapshot, state).ok)
  );
}

export function newSessionIntentForInput(
  state: NewSessionFlowStateView,
  input: NewSessionInput,
): NewSessionInputIntent {
  if (state.mode === "review" && state.submissionLocalId !== undefined) {
    return { type: "none" };
  }
  const actionId = newSessionActionForInput(state, input);
  if (actionId !== undefined) {
    return newSessionIntentForAction(state, actionId);
  }
  if (state.mode === "pickGroup") {
    if (input.input === "U") return transitionIntent({ type: "chooseUngrouped" });
    if (input.input === "N") return transitionIntent({ type: "editGroupDraft" });
  }
  if (input.key.escape === true) {
    return transitionIntent({ type: "cancel" });
  }
  switch (state.mode) {
    case "review":
      return reviewInputIntent(input);
    case "editName":
      return editNameInputIntent(state, input);
    case "editGroupDraft":
      return editGroupDraftInputIntent(state, input);
    // Pick steps are registered lists: the shared selectionMiddleware resolves
    // ↑↓/↵/slot before this handler runs, so nothing is left for it to intent.
    case "pickProject":
    case "pickAgent":
    case "pickGroup":
      return { type: "none" };
  }
}

/** Resolves a visible New Session control into a renderer-neutral flow intent. */
export function newSessionIntentForAction(
  state: NewSessionFlowStateView,
  actionId: NewSessionActionId,
): NewSessionInputIntent {
  const definition = NEW_SESSION_ACTIONS[actionId];
  if (definition.mode !== state.mode) return { type: "none" };
  return definition.intent === "submit" ? { type: "submit" } : transitionIntent(definition.action);
}

/** Decodes only semantic control activation; text editing and focus movement stay as input intents. */
export function newSessionActionForInput(
  state: NewSessionFlowStateView,
  input: Pick<NewSessionInput, "input" | "key">,
): NewSessionActionId | undefined {
  if (state.mode === "review") {
    if (isReturn(input)) return `review.${state.reviewFocus}`;
    if (input.input === "P") return "review.project";
    if (input.input === "N") return "review.name";
    if (input.input === "A") return "review.agent";
    if (input.input === "G") return "review.group";
    return input.input === "C" ? "review.create" : undefined;
  }
  if (state.mode === "editGroupDraft") {
    if (input.key.escape === true) return "editGroupDraft.back";
    return isReturn(input) ? "editGroupDraft.save" : undefined;
  }
  if (state.mode !== "editName") return undefined;
  if (input.key.escape === true) return "editName.back";
  if (input.key.ctrl === true && input.input === "s") return "editName.save";
  if (!isReturn(input)) return undefined;
  return state.editNameFocus === "back" ? "editName.back" : "editName.save";
}

function reviewInputIntent(input: NewSessionInput): NewSessionInputIntent {
  if (input.key.upArrow === true) {
    return transitionIntent({ type: "reviewFocus", dir: -1 });
  }
  return input.key.downArrow === true
    ? transitionIntent({ type: "reviewFocus", dir: 1 })
    : { type: "none" };
}

function editNameInputIntent(
  state: NewSessionEditNameStateView,
  input: NewSessionInput,
): NewSessionInputIntent {
  if (state.editNameFocus === "name") {
    if (input.key.downArrow === true) {
      return transitionIntent({ type: "editNameFocusSet", focus: "save" });
    }
    const intent = editableTextInputIntentForInput(input);
    return intent.type === "edit"
      ? transitionIntent({ type: "editNameInput", action: intent.action })
      : { type: "none" };
  }
  if (input.key.upArrow === true) {
    return transitionIntent({ type: "editNameFocusSet", focus: "name" });
  }
  if (input.key.leftArrow === true || input.key.rightArrow === true) {
    return transitionIntent({
      type: "editNameFocusSet",
      focus: state.editNameFocus === "save" ? "back" : "save",
    });
  }
  return { type: "none" };
}

function editGroupDraftInputIntent(
  _state: NewSessionEditGroupDraftStateView,
  input: NewSessionInput,
): NewSessionInputIntent {
  const intent = editableTextInputIntentForInput(input);
  return intent.type === "edit"
    ? transitionIntent({ type: "editGroupDraftInput", action: intent.action })
    : { type: "none" };
}

function transitionIntent(action: NewSessionFlowAction): NewSessionInputIntent {
  return {
    type: "transition",
    action,
  };
}

function isReturn(input: Pick<NewSessionInput, "input" | "key">): boolean {
  return input.key.return === true || input.input === "\r" || input.input === "\n";
}
