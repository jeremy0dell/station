import { choiceValueByKey } from "../../selectors/selectors.js";
import { isSlotKey } from "../keymap.js";
import { isReturnKey, type TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardState } from "../types.js";
import type { RegisteredListSpec } from "./types.js";

function selectableIds(spec: RegisteredListSpec, state: DashboardState): string[] {
  return spec.rows(state).flatMap((row) => (row.selectable ? [row.id] : []));
}

/**
 * The current cursor id, or undefined. Repair is keep-or-unfocus: a stale
 * cursor (its row left the list) reads as unfocused and the next move re-seeds.
 */
export function cursorId(spec: RegisteredListSpec, state: DashboardState): string | undefined {
  const current = state.selection.get(spec.listId);
  if (current === undefined) {
    return undefined;
  }
  return selectableIds(spec, state).includes(current) ? current : undefined;
}

function withCursor(state: DashboardState, listId: string, id: string): DashboardState {
  const selection = new Map(state.selection);
  selection.set(listId, id);
  return { ...state, selection };
}

/**
 * Commits the canonical current cursor through the registered list's own behavior.
 * Stale or absent cursors remain inert, so keyboard Enter and semantic controls share one commit.
 */
export function commitCurrentCursor(
  spec: RegisteredListSpec,
  state: DashboardState,
): TuiTransition {
  const id = cursorId(spec, state);
  return id === undefined ? { state } : spec.commit(state, id, "cursor");
}

/** Focuses and commits one semantic list item, independent of shortcut availability. */
export function activateListItem(
  spec: RegisteredListSpec,
  state: DashboardState,
  itemId: string,
): TuiTransition {
  if (!selectableIds(spec, state).includes(itemId)) {
    return { state };
  }
  return spec.commit(withCursor(state, spec.listId, itemId), itemId, "cursor");
}

/** Move the cursor one selectable row; clamp (never wrap) and seed from the edge if unset. */
export function moveCursor(
  spec: RegisteredListSpec,
  state: DashboardState,
  delta: -1 | 1,
): DashboardState {
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
 * The dispatch heart. Renderer-visible semantic slots resolve before full-list cursor keys.
 * Returns undefined for anything the list doesn't own, so the screen reducer keeps every
 * bespoke chord.
 */
export function resolveListKey(
  spec: RegisteredListSpec,
  state: DashboardState,
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
      return commitCurrentCursor(spec, state);
    }
  }
  return undefined;
}
