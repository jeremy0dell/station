import type { TuiKey, TuiState } from "@station/dashboard-core";
import {
  createInitialTuiState,
  focusProjectSettingsItem,
  handleTuiKey,
  openProjectSettings,
  removeProjectConfirmPhrase,
  selectNewSessionHarnessChoices,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../../fixtures/snapshots.js";

function panelState(): TuiState {
  const base = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
  return openProjectSettings(base, "web");
}

function drive(state: TuiState, keys: TuiKey[]): TuiState {
  let current = state;
  for (const key of keys) {
    current = handleTuiKey(current, key).state;
  }
  return current;
}

const ENTER: TuiKey = { input: "\r", return: true };
const ESC: TuiKey = { input: "", escape: true };
const DOWN: TuiKey = { input: "", downArrow: true };
const UP: TuiKey = { input: "", upArrow: true };
const RIGHT: TuiKey = { input: "", rightArrow: true };

describe("project settings panel", () => {
  it("opens focused on the list with the first item active", () => {
    const screen = panelState().screen;
    expect(screen.name).toBe("projectSettings");
    if (screen.name !== "projectSettings") return;
    expect(screen).toMatchObject({ projectId: "web", focus: "list", activeId: "agent" });
  });

  it("moves the cursor and clamps at the ends", () => {
    const down = drive(panelState(), [DOWN]).screen;
    expect(down.name === "projectSettings" && down.activeId).toBe("remove");
    // Up from the top item stays put (clamp, no wrap).
    const clamped = drive(panelState(), [UP]).screen;
    expect(clamped.name === "projectSettings" && clamped.activeId).toBe("agent");
  });

  it("enters the detail pane with right/enter and pops back with esc", () => {
    const detail = drive(panelState(), [RIGHT]).screen;
    expect(detail.name === "projectSettings" && detail.focus).toBe("detail");
    const back = drive(panelState(), [RIGHT, ESC]).screen;
    expect(back.name === "projectSettings" && back.focus).toBe("list");
  });

  it("esc from the list closes the panel to the dashboard", () => {
    expect(drive(panelState(), [ESC]).screen.name).toBe("dashboard");
  });

  it("selecting a non-current agent emits setProjectDefaultHarness", () => {
    const snapshot = createDashboardSnapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === "web");
    if (project === undefined) throw new Error("missing web project");
    const other = selectNewSessionHarnessChoices(snapshot, project).find(
      (choice) => choice.value.id !== project.defaults.harness,
    );
    if (other === undefined) throw new Error("no alternative harness in fixture");

    const transition = handleTuiKey(drive(panelState(), [RIGHT]), { input: other.key });
    expect(transition.operations).toEqual([
      expect.objectContaining({
        type: "setProjectDefaultHarness",
        command: expect.objectContaining({
          type: "project.setDefaultHarness",
          payload: { projectId: "web", harness: other.value.id },
        }),
      }),
    ]);
    expect(
      transition.state.screen.name === "projectSettings" && transition.state.screen.focus,
    ).toBe("list");
  });

  it("requires typing the confirm phrase before removal is armed", () => {
    const phrase = removeProjectConfirmPhrase("web");
    const toRemoveDetail = drive(panelState(), [DOWN, RIGHT]);

    // Enter before the phrase matches does nothing destructive.
    const premature = handleTuiKey(toRemoveDetail, ENTER);
    expect(premature.operations).toBeUndefined();
    expect(premature.state.screen.name).toBe("projectSettings");

    const typed = drive(
      toRemoveDetail,
      [...phrase].map((char) => ({ input: char })),
    );
    const armedScreen = typed.screen;
    expect(armedScreen.name === "projectSettings" && armedScreen.removeDraft.value).toBe(phrase);

    const fired = handleTuiKey(typed, ENTER);
    expect(fired.operations).toEqual([
      expect.objectContaining({
        type: "removeProject",
        command: expect.objectContaining({
          type: "project.remove",
          payload: { projectId: "web" },
        }),
      }),
    ]);
    expect(fired.state.screen.name).toBe("dashboard");
  });

  it("fires removal on the R accelerator once armed", () => {
    const phrase = removeProjectConfirmPhrase("web");
    const armed = drive(panelState(), [
      DOWN,
      RIGHT,
      ...[...phrase].map((char) => ({ input: char })),
    ]);
    const fired = handleTuiKey(armed, { input: "R" });
    expect(fired.operations?.[0]).toMatchObject({ type: "removeProject" });
    expect(fired.state.screen.name).toBe("dashboard");
  });

  it("mouse focus jumps straight into an item's detail pane", () => {
    const screen = focusProjectSettingsItem(panelState(), "remove").screen;
    expect(screen).toMatchObject({ name: "projectSettings", activeId: "remove", focus: "detail" });
  });
});
