import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";
import { resolveListKey } from "./engine.js";
import { listSpecForState } from "./registry.js";

/**
 * Runs in handleTuiKey before the screen switch. If the current screen is a
 * registered list (and active), resolves ↑↓/↵/slot; otherwise returns undefined
 * and the screen reducer keeps control of the key.
 */
export function selectionMiddleware(state: TuiState, key: TuiKey): TuiTransition | undefined {
  const spec = listSpecForState(state);
  if (spec === undefined) {
    return undefined;
  }
  if (spec.active !== undefined && !spec.active(state)) {
    return undefined;
  }
  return resolveListKey(spec, state, key);
}
