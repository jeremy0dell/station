import {
  applyAddProjectFolderReviewed,
  createInitialTuiState,
  handleTuiKey,
  openAddProject,
  type TuiState,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { handleTuiAction } from "../../../src/state/actions.js";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

const context = {
  cwd: "/workspace",
  homeDir: "/home/example",
};

describe("semantic TUI actions", () => {
  it("opens first-project onboarding equivalently from A, focused Enter, and semantic activation", () => {
    const snapshot = {
      ...createDashboardSnapshot(),
      projects: [],
      rows: [],
      sessions: [],
    };
    const state = createInitialTuiState({ initialSnapshot: snapshot });

    const direct = handleTuiKey(state, { input: "A" }, context);
    const focused = handleTuiKey(state, { input: "\r", return: true }, context);
    const semantic = handleTuiAction(state, { type: "dashboard.addProject" }, context);

    expect(focused).toEqual(direct);
    expect(semantic).toEqual(direct);
  });

  it("keeps a stale first-project semantic target inert after projects populate", () => {
    const state = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });

    expect(handleTuiAction(state, { type: "dashboard.addProject" }, context).state).toBe(state);
  });

  it("activates Add Project review controls identically through hotkey, focused Enter, and action", () => {
    const state = addProjectReviewState();

    const direct = handleTuiKey(state, { input: "N" }, context);
    const focused = handleTuiKey(
      {
        ...state,
        screen: {
          name: "addProject",
          flow: { ...addProjectFlow(state), actionFocus: "editId" },
        },
      },
      { input: "\r", return: true },
      context,
    );
    const semantic = handleTuiAction(
      state,
      { type: "addProject.activate", actionId: "review.editId" },
      context,
    );

    expect(focused).toEqual(direct);
    expect(semantic).toEqual(direct);
  });

  it("activates Create Session fields identically through hotkey, focused Enter, and action", () => {
    const state = handleTuiKey(
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      { input: "N" },
      context,
    ).state;
    if (state.screen.name !== "newSession" || state.screen.flow.mode !== "review") {
      throw new Error("expected new-session review");
    }

    const direct = handleTuiKey(state, { input: "P" }, context);
    const focused = handleTuiKey(
      {
        ...state,
        screen: {
          name: "newSession",
          flow: { ...state.screen.flow, reviewFocus: "project" },
        },
      },
      { input: "\r", return: true },
      context,
    );
    const semantic = handleTuiAction(
      state,
      { type: "newSession.activate", actionId: "review.project" },
      context,
    );

    expect(focused).toEqual(direct);
    expect(semantic).toEqual(direct);
  });
});

function addProjectReviewState(): TuiState {
  const state = openAddProject(createInitialTuiState(), context);
  return applyAddProjectFolderReviewed(state, {
    selectedPath: "/workspace/station",
    gitRoot: "/workspace/station",
    id: "station",
    label: "Station",
  });
}

function addProjectFlow(
  state: TuiState,
): Extract<TuiState["screen"], { name: "addProject" }>["flow"] & { mode: "review" } {
  if (state.screen.name !== "addProject" || state.screen.flow.mode !== "review") {
    throw new Error("expected Add Project review");
  }
  return state.screen.flow;
}
