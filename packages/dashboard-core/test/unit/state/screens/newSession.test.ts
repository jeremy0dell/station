import { describe, expect, it } from "vitest";
import { createInitialTuiState } from "../../../../src/state/screen.js";
import { openNewSession } from "../../../../src/state/screens/newSession.js";
import {
  createDashboardSnapshot,
  createGroupedDashboardSnapshot,
} from "../../../fixtures/snapshots.js";

describe("New Session screen", () => {
  it("opens for a configured Project", () => {
    const state = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });

    expect(openNewSession(state).state.screen).toMatchObject({
      name: "newSession",
      flow: { mode: "review", selectedProjectId: "web" },
    });
  });

  it("opens with a valid root Group preselected", () => {
    const state = createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() });

    expect(
      openNewSession(state, { projectId: "web", groupId: "group_active" }).state.screen,
    ).toMatchObject({
      name: "newSession",
      flow: {
        selectedProjectId: "web",
        groupSelection: { kind: "existing", groupId: "group_active" },
      },
    });
  });

  it("keeps the dashboard unchanged without a snapshot", () => {
    const state = createInitialTuiState();

    expect(openNewSession(state)).toEqual({ state });
  });

  it("reports the no-Project error without opening the screen", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: { ...snapshot, projects: [], rows: [], sessions: [] },
    });

    const opened = openNewSession(state).state;

    expect(opened.screen).toEqual({ name: "dashboard" });
    expect(opened.toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: "No project is configured for a new session.",
    });
  });
});
