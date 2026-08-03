import {
  createInitialTuiState,
  handleTuiKey,
  persistentFilterExperience,
  type TuiKey,
  type TuiState,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../../fixtures/snapshots.js";

const CONTEXT = { cwd: "/workspace", homeDir: "/home/example" };
const RETURN = { input: "\r", return: true } as const;
const TAB = { input: "i", ctrl: true } as const;

function key(state: TuiState, input: TuiKey): TuiState {
  return handleTuiKey(state, input, CONTEXT, persistentFilterExperience).state;
}

function openFilter(): TuiState {
  return key(createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }), { input: "/" });
}

describe("persistent-filter conditions", () => {
  it("opens the field chooser and commits slot-toggled status values", () => {
    const chooser = key(openFilter(), TAB);
    expect(chooser.screen).toMatchObject({
      name: "persistentFilter",
      conditionEditor: { stage: "field", cursor: 0 },
    });

    const values = key(chooser, { input: "S" });
    expect(values.screen).toMatchObject({
      name: "persistentFilter",
      conditionEditor: {
        stage: "values",
        field: "status",
        cursor: 0,
        selectedIds: [],
      },
    });

    const working = key(values, { input: "3" });
    const starting = key(working, { input: "4" });
    const committed = key(starting, RETURN);
    expect(committed.screen).toEqual({
      name: "persistentFilter",
      draft: { value: "", cursor: 0 },
      draftConditions: [
        {
          field: "status",
          values: [
            { id: "working", label: "Working" },
            { id: "starting", label: "Starting" },
          ],
        },
      ],
    });

    const applied = key(committed, RETURN);
    expect(applied.screen).toEqual({ name: "dashboard" });
    expect(applied.persistentFilter).toEqual({
      query: "",
      conditions: [
        {
          field: "status",
          values: [
            { id: "working", label: "Working" },
            { id: "starting", label: "Starting" },
          ],
        },
      ],
    });
  });

  it("returns to the field chooser with Left while Esc closes the whole panel", () => {
    const values = key(key(key(openFilter(), TAB), { input: "S" }), { input: "3" });

    const chooser = key(values, { input: "", leftArrow: true });
    expect(chooser.screen).toEqual({
      name: "persistentFilter",
      draft: { value: "", cursor: 0 },
      draftConditions: [],
      conditionEditor: { stage: "field", cursor: 0 },
    });

    const closed = key(values, { input: "", escape: true });
    expect(closed.screen).toEqual({
      name: "persistentFilter",
      draft: { value: "", cursor: 0 },
      draftConditions: [],
    });
  });

  it("discards only uncommitted panel toggles on Esc", () => {
    const applied = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      persistentFilter: {
        query: "",
        conditions: [{ field: "status", values: [{ id: "working", label: "Working" }] }],
      },
    });
    const opened = key(applied, { input: "/" });
    const values = key(key(opened, TAB), { input: "S" });
    const toggledOff = key(values, { input: "3" });

    const cancelled = key(toggledOff, { input: "", escape: true });

    expect(cancelled.screen).toEqual({
      name: "persistentFilter",
      draft: { value: "", cursor: 0 },
      draftConditions: [{ field: "status", values: [{ id: "working", label: "Working" }] }],
    });
    expect(cancelled.persistentFilter).toBe(applied.persistentFilter);
  });

  it("removes a field when no values are committed", () => {
    const applied = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      persistentFilter: {
        query: "api",
        conditions: [{ field: "status", values: [{ id: "working", label: "Working" }] }],
      },
    });
    const opened = key(applied, { input: "/" });
    const values = key(key(opened, TAB), { input: "S" });
    const cleared = key(values, { input: "3" });

    const committed = key(cleared, RETURN);

    expect(committed.screen).toMatchObject({ draftConditions: [] });
    expect(key(committed, RETURN).persistentFilter).toEqual({ query: "api" });
  });

  it("Ctrl-U clears text, committed conditions, and the nested editor", () => {
    const state = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      persistentFilter: {
        query: "api",
        conditions: [{ field: "agent", values: [{ id: "codex", label: "Codex" }] }],
      },
    });
    const editing = key(key(state, { input: "/" }), TAB);

    const cleared = key(editing, { input: "u", ctrl: true });

    expect(cleared.screen).toEqual({
      name: "persistentFilter",
      draft: { value: "", cursor: 0 },
      draftConditions: [],
    });
    expect("persistentFilter" in key(cleared, RETURN)).toBe(false);
  });
});
