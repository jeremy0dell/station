import {
  type AddProjectActionId,
  addProjectActions,
  applyAddProjectFolderReviewed,
  createInitialTuiState,
  createNewSessionFlow,
  handleTuiAction,
  newSessionIntentForAction,
  openAddProject,
  transitionNewSessionFlow,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

const context = { cwd: "/workspace", homeDir: "/home/example" };

describe("primary workflow interaction parity", () => {
  it("derives visible Add Project controls and availability from core descriptors", () => {
    let state = openAddProject(createInitialTuiState(), context);
    expect(actionIds(state)).toEqual(["start.open", "start.cancel"]);

    state = applyAddProjectFolderReviewed(state, {
      selectedPath: "/workspace/station",
      gitRoot: "/workspace/station",
      id: "station",
      label: "Station",
    });
    expect(actionIds(state)).toEqual([
      "review.submit",
      "review.editId",
      "review.chooseFolder",
      "review.cancel",
    ]);
  });

  it("keeps Git-invalid and submitting Add Project controls inert in core", () => {
    let invalid = openAddProject(createInitialTuiState(), context);
    invalid = applyAddProjectFolderReviewed(invalid, {
      selectedPath: "/workspace/notes",
      id: "notes",
      label: "Notes",
    });
    expect(actionEnabled(invalid, "review.submit")).toBe(false);
    expect(
      handleTuiAction(invalid, { type: "addProject.activate", actionId: "review.submit" }, context)
        .state,
    ).toBe(invalid);

    if (invalid.screen.name !== "addProject" || invalid.screen.flow.mode !== "review") {
      throw new Error("expected Add Project review");
    }
    const submitting = {
      ...invalid,
      screen: {
        name: "addProject" as const,
        flow: { ...invalid.screen.flow, submitting: true },
      },
    };
    expect(addProjectActions(submitting.screen.flow).every((action) => !action.enabled)).toBe(true);
    expect(
      handleTuiAction(
        submitting,
        { type: "addProject.activate", actionId: "review.cancel" },
        context,
      ).state,
    ).toBe(submitting);
  });

  it("gives every visible Create Session control a semantic intent", () => {
    const review = createNewSessionFlow(createDashboardSnapshot(), "aaaaaa");
    if (review === undefined) throw new Error("expected New Session");
    for (const id of ["review.project", "review.name", "review.agent", "review.create"] as const) {
      expect(newSessionIntentForAction(review, id).type, id).not.toBe("none");
    }

    const edit = transitionNewSessionFlow(review, { type: "editName" });
    if (edit?.mode !== "editName") throw new Error("expected name editor");
    for (const id of ["editName.name", "editName.save", "editName.back"] as const) {
      expect(newSessionIntentForAction(edit, id).type, id).not.toBe("none");
    }
  });
});

function actionIds(state: ReturnType<typeof createInitialTuiState>): AddProjectActionId[] {
  if (state.screen.name !== "addProject") throw new Error("expected Add Project");
  return addProjectActions(state.screen.flow).map((action) => action.id);
}

function actionEnabled(
  state: ReturnType<typeof createInitialTuiState>,
  actionId: AddProjectActionId,
): boolean | undefined {
  if (state.screen.name !== "addProject") throw new Error("expected Add Project");
  return addProjectActions(state.screen.flow).find((action) => action.id === actionId)?.enabled;
}
