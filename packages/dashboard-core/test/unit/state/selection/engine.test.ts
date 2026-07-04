import {
  createInitialTuiState,
  cursorId,
  deriveTuiInputMode,
  flatPickerSpec,
  handleTuiKey,
  LIST_REGISTRY,
  type ListRow,
  type ListSpec,
  moveCursor,
  resolveListKey,
  selectableListBindings,
  selectionMiddleware,
  type TuiState,
} from "@station/dashboard-core";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../../fixtures/snapshots.js";

const KEY_CONTEXT = { cwd: "/Users/example/Developer/station", homeDir: "/Users/example" };

// A synthetic list: item "b" is a non-selectable divider between "a" and "c".
const probeSpec: ListSpec<string> = {
  listId: "probe",
  cursor: true,
  rows: (): readonly ListRow<string>[] => [
    { selectable: true, id: "a" },
    { selectable: false },
    { selectable: true, id: "c" },
  ],
  slots: () => [
    { key: "1", value: "a" },
    { key: "2", value: "c" },
  ],
  commit: (state, id, via) => ({ state, reconcileReason: `commit:${id}:${via}` }),
};

function baseState(cursor?: string): TuiState {
  const state = createInitialTuiState();
  if (cursor === undefined) {
    return state;
  }
  return { ...state, selection: new Map([["probe", cursor]]) };
}

describe("selection engine — moveCursor", () => {
  it("seeds the first selectable row on a first down, skipping dividers", () => {
    const next = moveCursor(probeSpec, baseState(), 1);
    expect(next.selection.get("probe")).toBe("a");
  });

  it("seeds the last selectable row on a first up", () => {
    const next = moveCursor(probeSpec, baseState(), -1);
    expect(next.selection.get("probe")).toBe("c");
  });

  it("steps over a non-selectable divider", () => {
    const next = moveCursor(probeSpec, baseState("a"), 1);
    expect(next.selection.get("probe")).toBe("c");
  });

  it("clamps at the bottom edge and returns the same state reference", () => {
    const start = baseState("c");
    expect(moveCursor(probeSpec, start, 1)).toBe(start);
  });

  it("clamps at the top edge and returns the same state reference", () => {
    const start = baseState("a");
    expect(moveCursor(probeSpec, start, -1)).toBe(start);
  });

  it("treats a stale cursor (row gone) as unfocused and re-seeds", () => {
    const next = moveCursor(probeSpec, baseState("gone"), 1);
    expect(next.selection.get("probe")).toBe("a");
  });

  it("never mutates the caller's selection map (copy-on-write)", () => {
    const start = baseState("a");
    const snapshotBefore = new Map(start.selection);
    const next = moveCursor(probeSpec, start, 1);
    expect(start.selection).toEqual(snapshotBefore);
    expect(next.selection).not.toBe(start.selection);
  });
});

describe("selection engine — cursorId (keep-or-unfocus repair)", () => {
  it("returns the cursor when it still points at a selectable row", () => {
    expect(cursorId(probeSpec, baseState("c"))).toBe("c");
  });

  it("returns undefined for a stale cursor", () => {
    expect(cursorId(probeSpec, baseState("gone"))).toBeUndefined();
  });

  it("returns undefined when no cursor is set", () => {
    expect(cursorId(probeSpec, baseState())).toBeUndefined();
  });
});

describe("selection engine — resolveListKey", () => {
  it("moves the cursor on down arrow", () => {
    const result = resolveListKey(probeSpec, baseState("a"), { input: "", downArrow: true });
    expect(result?.state.selection.get("probe")).toBe("c");
  });

  it("commits the focused cursor via 'cursor' on return", () => {
    const result = resolveListKey(probeSpec, baseState("c"), { input: "\r", return: true });
    expect(result?.reconcileReason).toBe("commit:c:cursor");
  });

  it("no-ops (consumes) return when nothing is focused", () => {
    const start = baseState();
    const result = resolveListKey(probeSpec, start, { input: "\r", return: true });
    expect(result).toEqual({ state: start });
    expect(result?.reconcileReason).toBeUndefined();
  });

  it("commits via 'slot' on a matching slot key", () => {
    const result = resolveListKey(probeSpec, baseState(), { input: "2" });
    expect(result?.reconcileReason).toBe("commit:c:slot");
  });

  it("consumes an unmatched slot key without committing", () => {
    const start = baseState();
    const result = resolveListKey(probeSpec, start, { input: "9" });
    expect(result).toEqual({ state: start });
  });

  it("falls through (undefined) for a non-selection key so bespoke chords survive", () => {
    expect(resolveListKey(probeSpec, baseState("a"), { input: "Q" })).toBeUndefined();
  });

  it("falls through for slot keys when the spec defines no slots", () => {
    const slotless: ListSpec<string> = {
      listId: "probe",
      cursor: true,
      rows: probeSpec.rows,
      commit: probeSpec.commit,
    };
    expect(resolveListKey(slotless, baseState(), { input: "1" })).toBeUndefined();
  });
});

describe("flatPickerSpec", () => {
  it("marks every choice selectable and exposes them as both rows and slots", () => {
    const spec = flatPickerSpec<string>({
      listId: "flat",
      choices: () => [
        { key: "1", value: "x" },
        { key: "2", value: "y" },
      ],
      commit: (state, id) => ({ state, reconcileReason: id }),
    });
    const state = createInitialTuiState();
    expect(spec.rows(state)).toEqual([
      { selectable: true, id: "x" },
      { selectable: true, id: "y" },
    ]);
    expect(spec.slots?.(state)).toEqual([
      { key: "1", value: "x" },
      { key: "2", value: "y" },
    ]);
  });
});

describe("selectableListBindings", () => {
  it("produces up/down/return/slot bindings with literal action strings", () => {
    const bindings = selectableListBindings("tui.example");
    expect(bindings.map((binding) => binding.id)).toEqual([
      "tui.example.cursorUp",
      "tui.example.cursorDown",
      "tui.example.activate",
      "tui.example.slot",
    ]);
    expect(bindings.map((binding) => binding.pattern.kind)).toEqual([
      "named",
      "named",
      "named",
      "slot",
    ]);
    expect(bindings.every((binding) => binding.outcome === "handled")).toBe(true);
    // No text catch-all: a selectable list never eats arbitrary printables.
    expect(bindings.some((binding) => binding.pattern.kind === "text")).toBe(false);
  });
});

describe("selectionMiddleware — inert with an empty registry", () => {
  const modes: TuiState[] = [
    createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
    handleTuiKey(createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }), {
      input: "N",
    }).state,
  ];

  it("returns undefined for every current screen (no list registered yet)", () => {
    for (const state of modes) {
      expect(selectionMiddleware(state, { input: "", downArrow: true })).toBeUndefined();
    }
  });

  it("leaves dashboard arrow-focus behavior unchanged", () => {
    const dashboard = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
    expect(deriveTuiInputMode(dashboard)).toBe("dashboard");
    const moved = handleTuiKey(dashboard, { input: "", downArrow: true }, KEY_CONTEXT).state;
    // The dashboard's own focus engine still owns the cursor; the shared slice stays empty.
    expect(moved.focusedRowId).toBeDefined();
    expect(moved.selection.size).toBe(0);
  });
});

describe("selection slice default", () => {
  it("initializes as an empty map", () => {
    const state = createInitialTuiState();
    expect(state.selection).toBeInstanceOf(Map);
    expect(state.selection.size).toBe(0);
  });
});

describe("list registry — migrated modes", () => {
  it("registers exactly the migrated lists (complete over all modes)", () => {
    // Any accidental registration in an unmigrated mode flips this red, so the
    // set is asserted whole rather than sampled.
    expect(Object.keys(LIST_REGISTRY).sort()).toEqual([
      "newSessionPickAgent",
      "newSessionPickProject",
      "projectDefaultAgent",
    ]);
  });
});

describe("selectionMiddleware — active gate", () => {
  const helpState = handleTuiKey(
    createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
    { input: "H" },
    KEY_CONTEXT,
  ).state;

  // deriveTuiInputMode(helpState) === "help"; register a probe list there and
  // remove it after each case so the empty-registry invariant is restored.
  afterEach(() => {
    delete LIST_REGISTRY.help;
  });

  it("yields the key (undefined) when the spec's active predicate is false", () => {
    LIST_REGISTRY.help = flatPickerSpec<string>({
      listId: "help",
      choices: () => [{ key: "1", value: "x" }],
      commit: (state, id) => ({ state, reconcileReason: id }),
      active: () => false,
    });
    expect(deriveTuiInputMode(helpState)).toBe("help");
    expect(selectionMiddleware(helpState, { input: "1" })).toBeUndefined();
  });

  it("resolves the key when the active predicate is true", () => {
    LIST_REGISTRY.help = flatPickerSpec<string>({
      listId: "help",
      choices: () => [{ key: "1", value: "x" }],
      commit: (state, id) => ({ state, reconcileReason: `hit:${id}` }),
      active: () => true,
    });
    expect(selectionMiddleware(helpState, { input: "1" })?.reconcileReason).toBe("hit:x");
  });
});
