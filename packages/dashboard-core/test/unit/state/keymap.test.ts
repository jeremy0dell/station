import type { TuiKey, TuiState } from "@station/dashboard-core";
import {
  createInitialTuiState,
  deriveTuiInputMode,
  editableTextBindings,
  handleTuiKey,
  matchingTuiBindings,
  openProjectDefaultAgentPicker,
  TUI_KEYMAP,
  type TuiInputMode,
  type TuiTransition,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

const KEY_CONTEXT = { cwd: "/Users/example/Developer/station", homeDir: "/Users/example" };

const ALLOWED_NOOP_BINDINGS = new Set([
  // Slot bindings cover the full accelerator range; assigned slots depend on
  // the current viewport, selected picker, and row data.
  "tui.dashboard.slotActivate",
  "tui.collapse.toggleSlot",
  "tui.projectSettingsPicker.choose",
  "tui.remove.chooseSlot",
  "tui.rename.chooseSlot",
  "tui.fork.chooseSlot",
  "tui.newSessionProject.choose",
  "tui.newSessionAgent.choose",
  "tui.projectDefaultAgent.choose",
  // Add-project metadata is a union over its internal submodes.
  "tui.addProject.cancel",
  "tui.addProject.confirm",
  "tui.addProject.up",
  "tui.addProject.down",
  "tui.addProject.left",
  "tui.addProject.right",
  "tui.addProject.backspace",
  "tui.addProject.delete",
  "tui.addProject.clearLine",
  "tui.addProject.type",
  // Esc only dismisses when the runtime is showing a dismissible persistent popup.
  "tui.dashboard.dismissEsc",
  // Return only activates once a row is focused.
  "tui.dashboard.focusActivate",
]);

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

function dashboardState(): TuiState {
  return createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
}

function drive(state: TuiState, keys: readonly TuiKey[]): TuiState {
  let current = state;
  for (const key of keys) {
    current = handleTuiKey(current, key, KEY_CONTEXT).state;
  }
  return current;
}

function representativeStates(): Record<TuiInputMode, TuiState> {
  const base = dashboardState();
  return {
    dashboard: base,
    help: drive(base, [{ input: "H" }]),
    search: drive(base, [{ input: "/" }, { input: "ab" }]),
    projectCollapse: drive(base, [{ input: "C" }]),
    projectSettingsPicker: drive(base, [{ input: "P" }]),
    removeChooseSlot: drive(base, [{ input: "X" }]),
    removeConfirm: drive(base, [{ input: "X" }, { input: "1" }]),
    renameChooseSlot: drive(base, [{ input: "R" }]),
    renameEdit: drive(base, [{ input: "R" }, { input: "1" }]),
    forkChooseSlot: drive(base, [{ input: "F" }]),
    forkDetails: drive(base, [{ input: "F" }, { input: "1" }]),
    newSessionReview: drive(base, [{ input: "N" }]),
    newSessionEditName: drive(base, [{ input: "N" }, { input: "N" }]),
    newSessionPickProject: drive(base, [{ input: "N" }, { input: "P" }]),
    newSessionPickAgent: drive(base, [{ input: "N" }, { input: "A" }]),
    projectDefaultAgent: openProjectDefaultAgentPicker(base, "web"),
    addProject: drive(base, [{ input: "A" }]),
  };
}

function transitionFor(state: TuiState, key: TuiKey): TuiTransition {
  return handleTuiKey(state, key, KEY_CONTEXT);
}

function machineHandled(state: TuiState, key: TuiKey): boolean {
  const transition = transitionFor(state, key);
  return (
    transition.state !== state ||
    transition.commands !== undefined ||
    transition.operations !== undefined ||
    transition.reconcileReason !== undefined ||
    transition.exitCode !== undefined ||
    transition.dismissPopup === true
  );
}

function transitionOutcome(transition: TuiTransition): "handled" | "exit" | "dismiss-popup" {
  if (transition.dismissPopup === true) {
    return "dismiss-popup";
  }
  if (transition.exitCode !== undefined) {
    return "exit";
  }
  return "handled";
}

describe("tui keymap metadata", () => {
  const states = representativeStates();

  it("derives the expected mode for every representative state", () => {
    for (const [mode, state] of Object.entries(states) as Array<[TuiInputMode, TuiState]>) {
      expect(`${mode}:${deriveTuiInputMode(state)}`).toBe(`${mode}:${mode}`);
    }
  });

  it("documents every machine-handled key with exactly one binding", () => {
    const failures: string[] = [];
    for (const [mode, state] of Object.entries(states) as Array<[TuiInputMode, TuiState]>) {
      for (const key of probeKeys()) {
        const handled = machineHandled(state, key);
        const bindings = matchingTuiBindings(mode, key);
        if (handled && bindings.length !== 1) {
          failures.push(
            `${mode}: machine handles ${describeKey(key)} but ${bindings.length} bindings match`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("has no stale bindings outside declared runtime-data cases", () => {
    const failures: string[] = [];
    for (const [mode, state] of Object.entries(states) as Array<[TuiInputMode, TuiState]>) {
      for (const key of probeKeys()) {
        for (const binding of matchingTuiBindings(mode, key)) {
          if (!machineHandled(state, key) && !ALLOWED_NOOP_BINDINGS.has(binding.id)) {
            failures.push(`${mode}: ${binding.id} matches ${describeKey(key)} but is ignored`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("declares handled/exit outcomes that match the transition output", () => {
    const failures: string[] = [];
    for (const [mode, state] of Object.entries(states) as Array<[TuiInputMode, TuiState]>) {
      for (const key of probeKeys()) {
        for (const binding of matchingTuiBindings(mode, key)) {
          const transition = transitionFor(state, key);
          if (!machineHandled(state, key) && ALLOWED_NOOP_BINDINGS.has(binding.id)) {
            continue;
          }
          const derived = transitionOutcome(transition);
          if (binding.outcome !== derived) {
            failures.push(
              `${mode}: ${binding.id} declares ${binding.outcome} but ${describeKey(
                key,
              )} derives ${derived}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps text catch-alls last", () => {
    for (const mode of Object.keys(TUI_KEYMAP) as TuiInputMode[]) {
      const table = TUI_KEYMAP[mode];
      const textIndex = table.findIndex((binding) => binding.pattern.kind === "text");
      if (textIndex !== -1) {
        expect(`${mode}:${textIndex}`).toBe(`${mode}:${table.length - 1}`);
      }
    }
  });
});

describe("editableTextBindings", () => {
  it("produces the cursor + text catch-all block for a single action", () => {
    const bindings = editableTextBindings("tui.example", "tui.example.edit");
    expect(bindings.map((binding) => binding.id)).toEqual([
      "tui.example.cursorLeft",
      "tui.example.cursorRight",
      "tui.example.backspace",
      "tui.example.delete",
      "tui.example.type",
    ]);
    expect(bindings.every((binding) => binding.action === "tui.example.edit")).toBe(true);
    expect(bindings.every((binding) => binding.outcome === "handled")).toBe(true);
    // The text catch-all must be last so specific named keys match first.
    expect(bindings.at(-1)?.pattern).toEqual({ kind: "text" });
    expect(bindings.every((binding) => binding.help === undefined)).toBe(true);
  });

  it("attaches optional help to the text binding only", () => {
    const bindings = editableTextBindings("tui.example", "tui.example.edit", {
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
