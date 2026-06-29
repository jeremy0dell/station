import type { TuiKey, TuiState } from "@station/dashboard-core";
import { createInitialTuiState, handleTuiKey, selectProjectChoices } from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../../fixtures/snapshots.js";

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

const P: TuiKey = { input: "P" };
const ESC: TuiKey = { input: "", escape: true };

describe("project settings picker", () => {
  it("P opens a project picker prompt listing the projects", () => {
    const picker = drive(dashboardState(), [P]).screen;
    expect(picker.name).toBe("projectSettingsPicker");
    if (picker.name !== "projectSettingsPicker") return;
    // The inline command row renders this slot:label list.
    expect(picker.value.length).toBeGreaterThan(0);
  });

  it("choosing a slot opens that project's settings panel", () => {
    const base = dashboardState();
    const { snapshot } = base;
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) return;
    const picker = drive(base, [P]);
    const [first] = selectProjectChoices(snapshot, picker);
    expect(first).toBeDefined();
    if (first === undefined) return;

    const opened = drive(base, [P, { input: first.key }]).screen;
    expect(opened).toMatchObject({
      name: "projectSettings",
      projectId: first.value.id,
      focus: "list",
      activeId: "agent",
    });
  });

  it("esc backs out of the picker to the dashboard", () => {
    expect(drive(dashboardState(), [P, ESC]).screen.name).toBe("dashboard");
  });
});
