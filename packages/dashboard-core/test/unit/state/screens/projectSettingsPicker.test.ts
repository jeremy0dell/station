import { describe, expect, it } from "vitest";
import { selectProjectChooserChoices } from "../../../../src/selectors/selectors.js";
import type { TuiKey } from "../../../../src/state/keys.js";
import { createInitialTuiState } from "../../../../src/state/screen.js";
import { handleTuiKey } from "../../../../src/state/transition.js";
import type { DashboardState } from "../../../../src/state/types.js";
import { createDashboardSnapshot } from "../../../fixtures/snapshots.js";

function dashboardState(): DashboardState {
  return createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
}

function drive(state: DashboardState, keys: TuiKey[]): DashboardState {
  let current = state;
  for (const key of keys) {
    current = handleTuiKey(current, key).state;
  }
  return current;
}

const P: TuiKey = { input: "P" };
const ESC: TuiKey = { input: "", escape: true };

describe("project settings picker", () => {
  it("P opens the project settings picker and seeds the cursor", () => {
    const opened = drive(dashboardState(), [P]);
    expect(opened.screen.name).toBe("projectSettingsPicker");
    // The picker renders as a list sheet; the cursor seeds to the first project.
    expect(opened.selection.get("projectSettingsPicker")).toBeDefined();
  });

  it("choosing a slot opens that project's settings panel", () => {
    const base = dashboardState();
    const { snapshot } = base;
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) return;
    const [first] = selectProjectChooserChoices(snapshot);
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
