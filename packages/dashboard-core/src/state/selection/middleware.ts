import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardState } from "../types.js";
import { activateListItem, resolveListKey } from "./engine.js";
import { listSpecForState } from "./registry.js";

/**
 * Runs in handleTuiKey before the screen switch. If the current screen is a
 * registered list (and active), resolves ↑↓/↵/slot; otherwise returns undefined
 * and the screen reducer keeps control of the key.
 */
export function selectionMiddleware(state: DashboardState, key: TuiKey): TuiTransition | undefined {
  const spec = listSpecForState(state);
  if (spec === undefined) {
    return undefined;
  }
  if (spec.active !== undefined && !spec.active(state)) {
    return undefined;
  }
  return resolveListKey(spec, state, key);
}

/** Activates a registered list row by semantic identity, independent of shortcuts. */
export function activateCurrentListItem(state: DashboardState, itemId: string): TuiTransition {
  const spec = listSpecForState(state);
  if (spec === undefined || (spec.active !== undefined && !spec.active(state))) {
    return { state };
  }
  return activateListItem(spec, state, itemId);
}
