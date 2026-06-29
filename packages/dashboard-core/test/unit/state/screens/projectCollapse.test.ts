import type { TuiKey, TuiState } from "@station/dashboard-core";
import { createInitialTuiState, handleTuiKey, selectProjectChoices } from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../../fixtures/snapshots.js";

// projectCollapse shares the projectSlotPicker skeleton with the settings picker;
// these lock its toggle behavior so a refactor of the shared helper can't quietly
// change collapse semantics.
function dashboardState(): TuiState {
  return createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
}

function drive(state: TuiState, keys: TuiKey[]): TuiState {
  let current = state;
  for (const key of keys) {
    current = handleTuiKey(current, key).state;
  }
  return current;
}

function firstProject(state: TuiState) {
  const snapshot = state.snapshot;
  if (snapshot === undefined) throw new Error("snapshot missing");
  const [choice] = selectProjectChoices(snapshot, state);
  if (choice === undefined) throw new Error("no projects in fixture");
  return choice;
}

const C: TuiKey = { input: "C" };
const ESC: TuiKey = { input: "", escape: true };

describe("project collapse picker", () => {
  it("C opens the collapse picker prompt", () => {
    expect(drive(dashboardState(), [C]).screen.name).toBe("projectCollapse");
  });

  it("choosing a slot collapses the project and returns to the dashboard", () => {
    const base = dashboardState();
    const project = firstProject(base);
    const after = drive(base, [C, { input: project.key }]);
    expect(after.screen.name).toBe("dashboard");
    expect(after.collapsedProjectIds.has(project.value.id)).toBe(true);
  });

  it("choosing the same slot again expands it (toggle off)", () => {
    const base = dashboardState();
    const project = firstProject(base);
    const collapsed = drive(base, [C, { input: project.key }]);
    expect(collapsed.collapsedProjectIds.has(project.value.id)).toBe(true);
    const expanded = drive(collapsed, [C, { input: project.key }]);
    expect(expanded.collapsedProjectIds.has(project.value.id)).toBe(false);
  });

  it("esc backs out to the dashboard without changing collapse state", () => {
    const after = drive(dashboardState(), [C, ESC]);
    expect(after.screen.name).toBe("dashboard");
    expect([...after.collapsedProjectIds]).toEqual([]);
  });

  it("an unmapped slot key is a no-op and stays in the picker", () => {
    const after = drive(dashboardState(), [C, { input: "z" }]);
    expect(after.screen.name).toBe("projectCollapse");
    expect([...after.collapsedProjectIds]).toEqual([]);
  });
});
