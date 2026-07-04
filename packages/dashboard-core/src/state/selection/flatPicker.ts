import type { KeyedChoice } from "../../selectors/selectors.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";
import { type CommitVia, defineList, type ListRow, type RegisteredListSpec } from "./types.js";

/**
 * The near-zero picker: pick one item, commit, leave. Every choice is a
 * selectable row and a slot, so a flat picker gets ↑↓/↵ and slot-jump for free.
 * A screen contributes only `choices` and `commit`.
 */
export function flatPickerSpec<TId extends string>(config: {
  listId: string;
  choices: (state: TuiState) => readonly KeyedChoice<TId>[];
  commit: (state: TuiState, id: TId, via: CommitVia) => TuiTransition;
  active?: (state: TuiState) => boolean;
}): RegisteredListSpec {
  return defineList<TId>({
    listId: config.listId,
    cursor: true,
    rows: (state) =>
      config.choices(state).map((choice): ListRow<TId> => ({ selectable: true, id: choice.value })),
    slots: config.choices,
    commit: config.commit,
    ...(config.active === undefined ? {} : { active: config.active }),
  });
}
