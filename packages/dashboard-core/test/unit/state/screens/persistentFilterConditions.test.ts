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
  it("builds status, project, and agent conditions before applying the complete filter", () => {
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
    const statusDone = key(starting, RETURN);
    const projectValues = key(statusDone, { input: "P" });
    const projectSelected = key(projectValues, { input: "1" });
    const projectDone = key(projectSelected, { input: "", leftArrow: true });
    const agentValues = key(projectDone, { input: "A" });
    const agentSelected = key(agentValues, { input: "1" });
    const built = key(agentSelected, RETURN);
    expect(built.screen).toEqual({
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
        { field: "project", values: [{ id: "api", label: "api" }] },
        { field: "agent", values: [{ id: "codex", label: "codex" }] },
      ],
      conditionEditor: { stage: "field", cursor: 2 },
    });

    const applied = key(built, { input: "F" });
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
        { field: "project", values: [{ id: "api", label: "api" }] },
        { field: "agent", values: [{ id: "codex", label: "codex" }] },
      ],
    });
  });

  it("focuses Apply filter after the fields and activates it with Enter", () => {
    const editing = key(openFilter(), { input: "api" });
    const chooser = key(editing, TAB);
    const applyFocused = key(
      key(key(chooser, { input: "", downArrow: true }), { input: "", downArrow: true }),
      { input: "", downArrow: true },
    );

    expect(applyFocused.screen).toMatchObject({
      conditionEditor: { stage: "field", cursor: 3 },
    });
    expect(key(applyFocused, RETURN)).toMatchObject({
      screen: { name: "dashboard" },
      persistentFilter: { query: "api" },
    });
  });

  it("returns to the field chooser with Left while Esc closes the whole panel", () => {
    const values = key(key(key(openFilter(), TAB), { input: "S" }), { input: "3" });

    const chooser = key(values, { input: "", leftArrow: true });
    expect(chooser.screen).toEqual({
      name: "persistentFilter",
      draft: { value: "", cursor: 0 },
      draftConditions: [{ field: "status", values: [{ id: "working", label: "Working" }] }],
      conditionEditor: { stage: "field", cursor: 0 },
    });

    const closed = key(values, { input: "", escape: true });
    expect(closed.screen).toEqual({
      name: "persistentFilter",
      draft: { value: "", cursor: 0 },
      draftConditions: [],
    });
  });

  it("discards only the active field's unretained toggles on Esc", () => {
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

  it("removes a field when no values are retained", () => {
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

    const done = key(cleared, RETURN);

    expect(done.screen).toMatchObject({
      draftConditions: [],
      conditionEditor: { stage: "field", cursor: 0 },
    });
    expect(key(done, { input: "F" }).persistentFilter).toEqual({ query: "api" });
  });

  it("Ctrl-U clears text, retained conditions, and the nested editor", () => {
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
