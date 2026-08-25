export type EditableTextInputState = {
  value: string;
  /** UTF-16 offset normalized to a complete grapheme boundary. */
  cursor: number;
};

type GraphemeSegment = {
  readonly segment: string;
  readonly index: number;
};

type GraphemeSegmenter = {
  segment(input: string): Iterable<GraphemeSegment>;
};

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
}) as GraphemeSegmenter;
let cachedGraphemeValue: string | undefined;
let cachedGraphemeBoundaries: readonly number[] = [];

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
  return input.input !== ""
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
  const boundaries = graphemeBoundaries(state.value);
  const cursor = cursorBoundaryAtOrBefore(state.cursor, state.value.length, boundaries);
  if (cursor === 0) {
    return cursor === state.cursor ? state : { ...state, cursor };
  }
  const current = boundaries.indexOf(cursor);
  const previous = boundaries[Math.max(0, current - 1)] ?? 0;
  return {
    value: `${state.value.slice(0, previous)}${state.value.slice(cursor)}`,
    cursor: previous,
  };
}

export function deleteEditableText(state: EditableTextInputState): EditableTextInputState {
  const boundaries = graphemeBoundaries(state.value);
  const cursor = cursorBoundaryAtOrBefore(state.cursor, state.value.length, boundaries);
  if (cursor >= state.value.length) {
    return cursor === state.cursor ? state : { ...state, cursor };
  }
  const current = boundaries.indexOf(cursor);
  const next = boundaries[Math.min(boundaries.length - 1, current + 1)] ?? state.value.length;
  return {
    value: `${state.value.slice(0, cursor)}${state.value.slice(next)}`,
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
  const boundaries = graphemeBoundaries(state.value);
  const cursor = cursorBoundaryAtOrBefore(state.cursor, state.value.length, boundaries);
  const current = Math.max(0, boundaries.indexOf(cursor));
  const next = Math.min(boundaries.length - 1, Math.max(0, current + Math.trunc(delta)));
  return {
    ...state,
    cursor: boundaries[next] ?? 0,
  };
}

export function clampEditableTextCursor(cursor: number, value: string): number {
  return cursorBoundaryAtOrBefore(cursor, value.length, graphemeBoundaries(value));
}

function cursorBoundaryAtOrBefore(
  cursor: number,
  valueLength: number,
  boundaries: readonly number[],
): number {
  const bounded = Math.min(Math.max(0, Math.trunc(cursor)), valueLength);
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index] ?? 0;
    if (boundary <= bounded) return boundary;
  }
  return 0;
}

function graphemeBoundaries(value: string): readonly number[] {
  // Cursor-only navigation reuses the unchanged value, so keep segmentation off the key-repeat path.
  if (value === cachedGraphemeValue) return cachedGraphemeBoundaries;
  const boundaries = [0];
  for (const grapheme of graphemeSegmenter.segment(value)) {
    const end = grapheme.index + grapheme.segment.length;
    if (end !== boundaries.at(-1)) boundaries.push(end);
  }
  cachedGraphemeValue = value;
  cachedGraphemeBoundaries = boundaries;
  return cachedGraphemeBoundaries;
}
