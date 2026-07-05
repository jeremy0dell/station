import type { KeyedChoice } from "../../selectors/selectors.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

/** Registry key: the list a screen registers under (usually its input mode). */
export type ListId = string;

/**
 * One row in a list's cursor space. Non-selectable rows (headers, dividers,
 * gaps) hold viewport positions but the cursor steps over them.
 */
export type ListRow<TId extends string> = { selectable: true; id: TId } | { selectable: false };

/** How a commit was reached — screens use this to keep slot vs cursor policy apart. */
export type CommitVia = "cursor" | "slot";

/**
 * The whole per-list contribution. A screen supplies data (rows, optional
 * slots) and one behavior (`commit`); every capability is opt-in so a text or
 * lowercase-verb screen can register without the middleware eating its keys.
 */
export type ListSpec<TId extends string> = {
  listId: ListId;
  /** ↑↓ move a cursor and ↵ commits it. */
  cursor?: boolean;
  /** Gate for hybrid screens: when it returns false the middleware yields all keys. */
  active?: (state: TuiState) => boolean;
  /** Full ordered cursor space. */
  rows: (state: TuiState) => readonly ListRow<TId>[];
  /** Viewport-relative slot accelerators; OMIT to opt a list out of slot-jump. */
  slots?: (state: TuiState) => readonly KeyedChoice<TId>[];
  /** The only screen-authored behavior; returns a full transition (commands/operations/toasts). */
  commit: (state: TuiState, id: TId, via: CommitVia) => TuiTransition;
};

/**
 * Type-erased spec the registry and engine operate on. `defineList` performs the
 * single id-widening cast at registration; `rows`/`slots` only ever yield ids
 * this spec's own `commit` accepts, so the cast is sound.
 */
export type RegisteredListSpec = ListSpec<string>;

export function defineList<TId extends string>(spec: ListSpec<TId>): RegisteredListSpec {
  return spec as unknown as RegisteredListSpec;
}

/** Per-list cursor storage. A map, not a single pair, so two-list screens keep both cursors. */
export type TuiSelectionState = ReadonlyMap<ListId, string>;
