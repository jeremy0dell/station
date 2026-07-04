import { deriveTuiInputMode, type TuiInputMode } from "../keymap.js";
import type { TuiState } from "../types.js";
import type { RegisteredListSpec } from "./types.js";

/**
 * Lists keyed by the input mode they own. Empty until a screen registers; an
 * unregistered mode makes the middleware a no-op, so a half-migrated tree runs.
 */
export const LIST_REGISTRY: Partial<Record<TuiInputMode, RegisteredListSpec>> = {};

export function listSpecForState(state: TuiState): RegisteredListSpec | undefined {
  return LIST_REGISTRY[deriveTuiInputMode(state)];
}
