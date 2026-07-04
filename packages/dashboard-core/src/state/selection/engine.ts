import { choiceValueByKey } from "../../selectors/selectors.js";
import { isSlotKey } from "../keymap.js";
import { isReturnKey, type TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";
import type { RegisteredListSpec } from "./types.js";

function selectableIds(spec: RegisteredListSpec, state: TuiState): string[] {
  return spec.rows(state).flatMap((row) => (row.selectable ? [row.id] : []));
}

/**
 * The current cursor id, or undefined. Repair is keep-or-unfocus: a stale
 * cursor (its row left the list) reads as unfocused and the next move re-seeds.
 */
export function cursorId(spec: RegisteredListSpec, state: TuiState): string | undefined {
  const current = state.selection.get(spec.listId);
  if (current === undefined) {
    return undefined;
  }
  return selectableIds(spec, state).includes(current) ? current : undefined;
}

function withCursor(state: TuiState, listId: string, id: string): TuiState {
  const selection = new Map(state.selection);
  selection.set(listId, id);
  return { ...state, selection };
}

/** Move the cursor one selectable row; clamp (never wrap) and seed from the edge if unset. */
export function moveCursor(spec: RegisteredListSpec, state: TuiState, delta: -1 | 1): TuiState {
  const ids = selectableIds(spec, state);
  if (ids.length === 0) {
    return state;
  }
  const current = cursorId(spec, state);
  if (current === undefined) {
    const seeded = delta > 0 ? ids[0] : ids[ids.length - 1];
    return seeded === undefined ? state : withCursor(state, spec.listId, seeded);
  }
  const next = ids[ids.indexOf(current) + delta] ?? current;
  return next === current ? state : withCursor(state, spec.listId, next);
}

/**
 * The dispatch heart. Slots (viewport-relative) resolve before cursor keys
 * (full-list). Returns undefined for anything the list doesn't own, so the
 * screen reducer keeps every bespoke chord.
 */
export function resolveListKey(
  spec: RegisteredListSpec,
  state: TuiState,
  key: TuiKey,
): TuiTransition | undefined {
  if (spec.slots !== undefined && isSlotKey(key)) {
    const id = choiceValueByKey(spec.slots(state), key.input);
    return id === undefined ? { state } : spec.commit(state, id, "slot");
  }
  if (spec.cursor === true) {
    if (key.upArrow === true) {
      return { state: moveCursor(spec, state, -1) };
    }
    if (key.downArrow === true) {
      return { state: moveCursor(spec, state, 1) };
    }
    if (isReturnKey(key)) {
      const id = cursorId(spec, state);
      return id === undefined ? { state } : spec.commit(state, id, "cursor");
    }
  }
  return undefined;
}
