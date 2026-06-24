export type EditableTextInputState = {
  value: string;
  cursor: number;
};

export type EditableTextInputKey = {
  ctrl?: boolean;
  backspace?: boolean;
  delete?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
};

export type EditableTextInputInput = {
  input: string;
  key: EditableTextInputKey;
};

export type EditableTextEditAction =
  | { type: "insert"; input: string }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "deleteBeforeCursor" }
  | { type: "moveCursor"; delta: number };

export type EditableTextInputIntent =
  | {
      type: "edit";
      action: EditableTextEditAction;
    }
  | {
      type: "none";
    };

export function createEditableTextInputState(value = ""): EditableTextInputState {
  return {
    value,
    cursor: value.length,
  };
}

export function editableTextInputIntentForInput(
  input: EditableTextInputInput,
): EditableTextInputIntent {
  if (input.key.leftArrow === true) {
    return { type: "edit", action: { type: "moveCursor", delta: -1 } };
  }
  if (input.key.rightArrow === true) {
    return { type: "edit", action: { type: "moveCursor", delta: 1 } };
  }
  if (input.key.backspace === true) {
    return { type: "edit", action: { type: "backspace" } };
  }
  if (input.key.delete === true) {
    return { type: "edit", action: { type: "delete" } };
  }
  if (input.key.ctrl === true && input.input === "u") {
    return { type: "edit", action: { type: "deleteBeforeCursor" } };
  }
  return input.input.length > 0
    ? { type: "edit", action: { type: "insert", input: input.input } }
    : { type: "none" };
}

export function transitionEditableTextInput(
  state: EditableTextInputState,
  action: EditableTextEditAction,
): EditableTextInputState {
  switch (action.type) {
    case "insert":
      return insertEditableText(state, action.input);
    case "backspace":
      return backspaceEditableText(state);
    case "delete":
      return deleteEditableText(state);
    case "deleteBeforeCursor":
      return deleteBeforeCursorEditableText(state);
    case "moveCursor":
      return moveEditableTextCursor(state, action.delta);
  }
}

export function insertEditableText(
  state: EditableTextInputState,
  input: string,
): EditableTextInputState {
  const cursor = clampEditableTextCursor(state.cursor, state.value);
  return {
    value: `${state.value.slice(0, cursor)}${input}${state.value.slice(cursor)}`,
    cursor: cursor + input.length,
  };
}

export function backspaceEditableText(state: EditableTextInputState): EditableTextInputState {
  const cursor = clampEditableTextCursor(state.cursor, state.value);
  if (cursor === 0) {
    return cursor === state.cursor ? state : { ...state, cursor };
  }
  return {
    value: `${state.value.slice(0, cursor - 1)}${state.value.slice(cursor)}`,
    cursor: cursor - 1,
  };
}

export function deleteEditableText(state: EditableTextInputState): EditableTextInputState {
  const cursor = clampEditableTextCursor(state.cursor, state.value);
  if (cursor >= state.value.length) {
    return cursor === state.cursor ? state : { ...state, cursor };
  }
  return {
    value: `${state.value.slice(0, cursor)}${state.value.slice(cursor + 1)}`,
    cursor,
  };
}

export function deleteBeforeCursorEditableText(
  state: EditableTextInputState,
): EditableTextInputState {
  const cursor = clampEditableTextCursor(state.cursor, state.value);
  if (cursor === 0) {
    return cursor === state.cursor ? state : { ...state, cursor };
  }
  return {
    value: state.value.slice(cursor),
    cursor: 0,
  };
}

export function moveEditableTextCursor(
  state: EditableTextInputState,
  delta: number,
): EditableTextInputState {
  return {
    ...state,
    cursor: clampEditableTextCursor(state.cursor + delta, state.value),
  };
}

export function clampEditableTextCursor(cursor: number, value: string): number {
  return Math.min(Math.max(0, cursor), value.length);
}
