// The anti-drift suite pinning the keymap DATA to the shared transition
// machine (the single behavioral source):
//
// 1. Inverse coverage — for every mode and a broad probe-key space, any key
//    the machine handles must be matched by exactly one binding. A key the
//    machine handles that no binding documents is the omission-drift failure
//    the keymap-as-data requirement exists to prevent.
// 2. Stale bindings — a matched binding whose probe the machine ignores is
//    only legal for declared runtime-data cases (unassigned slots, the
//    addProject union table).
// 3. Outcome conformance — every binding's declared outcome must equal the
//    outcome derived from actually dispatching its key (close-overlay iff
//    the transition reports dismissPopup/exitCode).
import { describe, expect, it } from "bun:test";
import { attentionAndFailuresSnapshot, manyProjectsSnapshot } from "../fixtures/scenarios.js";
import {
  createInitialTuiState,
  openProjectDefaultAgentPicker,
  openProjectSettings,
} from "@station/dashboard-core";
import type { TuiKey } from "@station/dashboard-core";
import { handleTuiKey } from "@station/dashboard-core";
import type { TuiState } from "@station/dashboard-core";
import {
  deriveStationMode,
  editableTextBindings,
  matchStationBinding,
  STATION_KEYMAP,
  type StationBinding,
  type StationInputMode,
} from "./stationKeymap.js";

const KEY_CONTEXT = { cwd: "/Users/example/Developer/station", homeDir: "/Users/example" };

/** The shared actions union-table modes dispatch (addProject, projectSettings). */
const ADD_PROJECT_KEY_ACTION = "station.addProject.key";
const PROJECT_SETTINGS_KEY_ACTION = "station.projectSettings.key";

/**
 * Slot bindings are runtime-assigned, and the union-table modes (addProject,
 * projectSettings) route every key to one action and decode it in the machine,
 * so their bindings are checked by that shared action only — future distinct
 * stale actions still fail the audit.
 */
function allowedNoOpBinding(mode: StationInputMode, binding: StationBinding): boolean {
  if (binding.pattern.kind === "slot") {
    return true;
  }
  // Return only acts once a row is focused; Tab only when a row needs attention.
  if (
    binding.id === "station.dashboard.focusActivate" ||
    binding.id === "station.dashboard.nextNeedsMe"
  ) {
    return true;
  }
  if (mode === "addProject" && binding.action === ADD_PROJECT_KEY_ACTION) {
    return true;
  }
  return mode === "projectSettings" && binding.action === PROJECT_SETTINGS_KEY_ACTION;
}

function probeKeys(): TuiKey[] {
  const keys: TuiKey[] = [];
  for (let code = 0x20; code <= 0x7e; code += 1) {
    keys.push({ input: String.fromCharCode(code) });
  }
  for (let code = 0; code < 26; code += 1) {
    keys.push({ input: String.fromCharCode(0x61 + code), ctrl: true });
  }
  keys.push({ input: "\r", return: true });
  keys.push({ input: "", escape: true });
  keys.push({ input: "", backspace: true });
  keys.push({ input: "", delete: true });
  keys.push({ input: "", upArrow: true });
  keys.push({ input: "", downArrow: true });
  keys.push({ input: "", leftArrow: true });
  keys.push({ input: "", rightArrow: true });
  return keys;
}

/** Hoisted: the probe space is iterated once per mode in three suites. */
const PROBE_KEYS: readonly TuiKey[] = probeKeys();

function dashboardState(): TuiState {
  return createInitialTuiState({
    initialSnapshot: manyProjectsSnapshot(),
    runtime: { persistentPopup: true, canDismissPopup: true },
  });
}

function drive(state: TuiState, keys: TuiKey[]): TuiState {
  let current = state;
  for (const key of keys) {
    current = handleTuiKey(current, key, KEY_CONTEXT).state;
  }
  return current;
}

/**
 * Representative states for every mode, built by driving the machine from
 * the dashboard with real keys — if a path here breaks, the mode itself
 * broke. The rename path uses the attention fixture's first slot, whose row
 * has a session.
 */
function representativeStates(): Record<StationInputMode, TuiState> {
  const base = dashboardState();
  const renameBase = createInitialTuiState({
    initialSnapshot: attentionAndFailuresSnapshot(),
    runtime: { persistentPopup: true, canDismissPopup: true },
  });
  return {
    dashboard: base,
    help: drive(base, [{ input: "H" }]),
    search: drive(base, [{ input: "/" }, { input: "ab" }]),
    projectCollapse: drive(base, [{ input: "C" }]),
    projectSettingsPicker: drive(base, [{ input: "P" }]),
    removeChooseSlot: drive(base, [{ input: "X" }]),
    removeConfirm: drive(base, [{ input: "X" }, { input: "1" }]),
    projectSettings: openProjectSettings(base, "station"),
    renameChooseSlot: drive(renameBase, [{ input: "R" }]),
    renameEdit: drive(renameBase, [{ input: "R" }, { input: "1" }]),
    forkChooseSlot: drive(base, [{ input: "F" }]),
    forkDetails: drive(base, [{ input: "F" }, { input: "1" }]),
    newSessionReview: drive(base, [{ input: "N" }]),
    newSessionEditName: drive(base, [{ input: "N" }, { input: "N" }]),
    newSessionPickProject: drive(base, [{ input: "N" }, { input: "P" }]),
    newSessionPickAgent: drive(base, [{ input: "N" }, { input: "A" }]),
    projectDefaultAgent: openProjectDefaultAgentPicker(base, "station"),
    addProject: drive(base, [{ input: "A" }]),
  };
}

function machineHandled(state: TuiState, key: TuiKey): boolean {
  const transition = handleTuiKey(state, key, KEY_CONTEXT);
  return (
    transition.state !== state ||
    transition.commands !== undefined ||
    transition.operations !== undefined ||
    transition.reconcileReason !== undefined ||
    transition.exitCode !== undefined ||
    transition.dismissPopup === true
  );
}

describe("station keymap coverage", () => {
  const states = representativeStates();

  it("derives the expected mode for every representative state", () => {
    for (const [mode, state] of Object.entries(states)) {
      expect(`${mode}:${deriveStationMode(state)}`).toBe(`${mode}:${mode}`);
    }
  });

  it("documents every machine-handled key with exactly one binding (no omission drift)", () => {
    const failures: string[] = [];
    for (const [mode, state] of Object.entries(states) as Array<[StationInputMode, TuiState]>) {
      for (const key of PROBE_KEYS) {
        const handled = machineHandled(state, key);
        const binding = matchStationBinding(mode, key);
        if (handled && binding === undefined) {
          failures.push(`${mode}: machine handles ${describeKey(key)} but no binding matches`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("has no stale bindings outside the declared runtime-data cases", () => {
    const failures: string[] = [];
    for (const [mode, state] of Object.entries(states) as Array<[StationInputMode, TuiState]>) {
      for (const key of PROBE_KEYS) {
        const binding = matchStationBinding(mode, key);
        if (binding === undefined) {
          continue;
        }
        if (!machineHandled(state, key) && !allowedNoOpBinding(mode, binding)) {
          failures.push(`${mode}: ${binding.id} matches ${describeKey(key)} but the machine ignores it`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("declares outcomes that match what dispatching actually produces", () => {
    const failures: string[] = [];
    for (const [mode, state] of Object.entries(states) as Array<[StationInputMode, TuiState]>) {
      for (const key of PROBE_KEYS) {
        const binding = matchStationBinding(mode, key);
        if (binding === undefined) {
          continue;
        }
        const transition = handleTuiKey(state, key, KEY_CONTEXT);
        const derived =
          transition.dismissPopup === true || transition.exitCode !== undefined
            ? "close-overlay"
            : "handled";
        if (binding.outcome !== derived) {
          failures.push(
            `${mode}: ${binding.id} declares ${binding.outcome} but ${describeKey(key)} derives ${derived}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("matches at most one specific binding per key (text catch-alls last)", () => {
    for (const mode of Object.keys(STATION_KEYMAP) as StationInputMode[]) {
      const table = STATION_KEYMAP[mode];
      const textIndex = table.findIndex((binding) => binding.pattern.kind === "text");
      if (textIndex !== -1) {
        expect(`${mode}:${textIndex}`).toBe(`${mode}:${table.length - 1}`);
      }
    }
  });
});

describe("editableTextBindings", () => {
  it("produces the cursor + text catch-all block with the text binding last", () => {
    const bindings = editableTextBindings("station.example", "station.example.edit");
    expect(bindings.map((binding) => binding.id)).toEqual([
      "station.example.cursorLeft",
      "station.example.cursorRight",
      "station.example.backspace",
      "station.example.delete",
      "station.example.type",
    ]);
    expect(bindings.every((binding) => binding.action === "station.example.edit")).toBe(true);
    expect(bindings.at(-1)?.pattern).toEqual({ kind: "text" });
    expect(bindings.every((binding) => binding.help === undefined)).toBe(true);
  });

  it("attaches optional help to the text binding only", () => {
    const bindings = editableTextBindings("station.example", "station.example.edit", {
      keys: "space",
      label: "toggle",
    });
    expect(bindings.at(-1)?.help).toEqual({ keys: "space", label: "toggle" });
    expect(bindings.slice(0, -1).every((binding) => binding.help === undefined)).toBe(true);
  });
});

function describeKey(key: TuiKey): string {
  const flags = Object.entries(key)
    .filter(([name, value]) => name !== "input" && value === true)
    .map(([name]) => name)
    .join("+");
  return `{input:${JSON.stringify(key.input)}${flags ? ` ${flags}` : ""}}`;
}
