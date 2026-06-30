import type { StationState } from "../../state/types.js";

export type LayerId =
  | "resize-drag"
  | "dialog"
  | "command-palette"
  | "context-menu"
  | "overlay"
  | "terminal"
  | "workspace"
  | "base";

/**
 * The documented priority order, highest first. All seven slots are named so
 * a future layer is a registration into an existing slot; only layers that
 * are actually registered participate in resolution.
 */
export const LAYER_PRIORITY: readonly LayerId[] = [
  "resize-drag",
  "dialog",
  "command-palette",
  "context-menu",
  "overlay",
  "terminal",
  "workspace",
  "base",
];

export type KeyBinding<TOutcome> = {
  /**
   * Bind normalized legacy bytes only; do not bind indistinguishable collisions
   * like Tab/Ctrl-I. Richer chords need normalized key descriptors later.
   */
  keys: readonly string[];
  /**
   * Reserved keys bypass catch-alls so lower-priority explicit bindings like
   * Ctrl-Q/Ctrl-O still receive them.
   */
  reserved?: boolean;
  action: (state: StationState) => TOutcome;
};

export type KeymapLayer<TOutcome> = {
  id: LayerId;
  isActive(state: StationState): boolean;
  bindings: readonly KeyBinding<TOutcome>[];
  /** Modal swallow or terminal passthrough: claims every non-reserved key. */
  catchAll?: (key: string, state: StationState) => TOutcome;
};

export type KeymapStack<TOutcome> = {
  layers: readonly KeymapLayer<TOutcome>[];
  reservedKeys: ReadonlySet<string>;
  /** Returns undefined when no active layer claims the key. */
  resolve(key: string, state: StationState): TOutcome | undefined;
};

export function createKeymapStack<TOutcome>(
  layers: readonly KeymapLayer<TOutcome>[],
): KeymapStack<TOutcome> {
  const ordered = [...layers].sort(
    (a, b) => LAYER_PRIORITY.indexOf(a.id) - LAYER_PRIORITY.indexOf(b.id),
  );

  const reservedKeys = new Set<string>();
  const keyIndexes = new Map<LayerId, Map<string, KeyBinding<TOutcome>>>();
  for (const layer of ordered) {
    if (keyIndexes.has(layer.id)) {
      throw new Error(`duplicate keymap layer: ${layer.id}`);
    }
    const index = new Map<string, KeyBinding<TOutcome>>();
    for (const binding of layer.bindings) {
      for (const key of binding.keys) {
        if (index.has(key)) {
          throw new Error(`duplicate key binding in layer ${layer.id}: ${JSON.stringify(key)}`);
        }
        index.set(key, binding);
        if (binding.reserved === true) {
          reservedKeys.add(key);
        }
      }
    }
    keyIndexes.set(layer.id, index);
  }

  return {
    layers: ordered,
    reservedKeys,
    resolve(key, state) {
      for (const layer of ordered) {
        if (!layer.isActive(state)) {
          continue;
        }
        const binding = keyIndexes.get(layer.id)?.get(key);
        if (binding !== undefined) {
          return binding.action(state);
        }
        if (layer.catchAll !== undefined && !reservedKeys.has(key)) {
          return layer.catchAll(key, state);
        }
      }
      return undefined;
    },
  };
}
