import type { StationSnapshot, TuiKey, TuiState } from "@station/dashboard-core";
import {
  createInitialTuiState,
  focusProjectSettingsItem,
  handleTuiKey,
  openProjectSettings,
  pendingProjectDefaultHarnesses,
  pruneLocalRowsForSnapshot,
  removePendingProjectDefaultHarness,
  removeProjectConfirmPhrase,
  selectNewSessionHarnessChoices,
  selectProjectDefaultHarness,
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

  it("arrow-navigates the agent picker and commits the focused agent on enter", () => {
    const snapshot = createDashboardSnapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === "web");
    if (project === undefined) throw new Error("missing web project");
    const other = selectNewSessionHarnessChoices(snapshot, project).find(
      (choice) => choice.value.id !== project.defaults.harness,
    );
    if (other === undefined) throw new Error("no alternative harness in fixture");

    // Descend into the agent detail; the cursor seeds at the current default.
    const detail = drive(panelState(), [RIGHT]);
    expect(detail.selection.get("projectSettingsAgent")).toBe(project.defaults.harness);

    // Arrow to a different agent; the cursor moves.
    const moved = drive(detail, [DOWN]);
    expect(moved.selection.get("projectSettingsAgent")).toBe(other.value.id);

    // Enter commits the focused agent and returns to the list.
    const committed = handleTuiKey(moved, ENTER);
    expect(committed.operations).toEqual([
      expect.objectContaining({
        type: "setProjectDefaultHarness",
        command: expect.objectContaining({
          payload: { projectId: "web", harness: other.value.id },
        }),
      }),
    ]);
    expect(committed.state.screen.name === "projectSettings" && committed.state.screen.focus).toBe(
      "list",
    );
  });

  it("enter on the unchanged focused agent closes to the list without dispatching", () => {
    // Cursor seeds at the current default; committing it is a no-op-and-ascend.
    const committed = handleTuiKey(drive(panelState(), [RIGHT]), ENTER);
    expect(committed.operations ?? []).toEqual([]);
    expect(committed.state.screen.name === "projectSettings" && committed.state.screen.focus).toBe(
      "list",
    );
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

  it("marks the picked agent as the optimistic default until the snapshot confirms", () => {
    const snapshot = createDashboardSnapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === "web");
    if (project === undefined) throw new Error("missing web project");
    const other = selectNewSessionHarnessChoices(snapshot, project).find(
      (choice) => choice.value.id !== project.defaults.harness,
    );
    if (other === undefined) throw new Error("no alternative harness in fixture");

    const { state } = handleTuiKey(drive(panelState(), [RIGHT]), { input: other.key });

    // The marker jumps to the picked agent right away, flagged pending.
    expect(selectProjectDefaultHarness(state.localRows, project)).toEqual({
      harness: other.value.id,
      pending: true,
    });

    // A snapshot that reflects the new default prunes the optimistic entry.
    const confirmed: StationSnapshot = {
      ...snapshot,
      projects: snapshot.projects.map((candidate) =>
        candidate.id === "web"
          ? { ...candidate, defaults: { ...candidate.defaults, harness: other.value.id } }
          : candidate,
      ),
    };
    const pruned = pruneLocalRowsForSnapshot(state.localRows, confirmed);
    expect(pendingProjectDefaultHarnesses(pruned)).toEqual({});
  });

  it("does not re-dispatch when re-selecting the agent that is already optimistically current", () => {
    const snapshot = createDashboardSnapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === "web");
    if (project === undefined) throw new Error("missing web project");
    const other = selectNewSessionHarnessChoices(snapshot, project).find(
      (choice) => choice.value.id !== project.defaults.harness,
    );
    if (other === undefined) throw new Error("no alternative harness in fixture");

    const picked = handleTuiKey(drive(panelState(), [RIGHT]), { input: other.key });
    expect(picked.operations).toHaveLength(1);

    // It is now the optimistic default, so re-selecting it is a no-op edit — not
    // a duplicate setProjectDefaultHarness command for a change already in flight.
    const again = handleTuiKey(picked.state, { input: other.key });
    expect(again.operations ?? []).toEqual([]);
  });

  it("overrides an in-flight change when the snapshot default is re-selected", () => {
    const snapshot = createDashboardSnapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === "web");
    if (project === undefined) throw new Error("missing web project");
    const choices = selectNewSessionHarnessChoices(snapshot, project);
    const current = choices.find((choice) => choice.value.id === project.defaults.harness);
    const other = choices.find((choice) => choice.value.id !== project.defaults.harness);
    if (current === undefined || other === undefined) {
      throw new Error("fixture needs the default plus one alternative harness");
    }

    // Pick the alternative (optimistic pending), then pick the snapshot default
    // again before the change lands.
    const pendingOther = handleTuiKey(drive(panelState(), [RIGHT]), { input: other.key }).state;
    const revert = handleTuiKey(pendingOther, { input: current.key });

    // The final choice must win: dispatch the default and re-point the optimistic
    // marker, not silently drop it because it matches the stale snapshot value.
    expect(revert.operations).toEqual([
      expect.objectContaining({
        type: "setProjectDefaultHarness",
        command: expect.objectContaining({
          payload: { projectId: "web", harness: project.defaults.harness },
        }),
      }),
    ]);
    expect(selectProjectDefaultHarness(revert.state.localRows, project)).toEqual({
      harness: project.defaults.harness,
      pending: true,
    });
  });

  it("reverting the optimistic default falls back to the snapshot value", () => {
    const snapshot = createDashboardSnapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === "web");
    if (project === undefined) throw new Error("missing web project");
    const other = selectNewSessionHarnessChoices(snapshot, project).find(
      (choice) => choice.value.id !== project.defaults.harness,
    );
    if (other === undefined) throw new Error("no alternative harness in fixture");

    const { state } = handleTuiKey(drive(panelState(), [RIGHT]), { input: other.key });
    const reverted = removePendingProjectDefaultHarness(state, "web");
    expect(selectProjectDefaultHarness(reverted.localRows, project)).toEqual({
      harness: project.defaults.harness,
      pending: false,
    });
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
