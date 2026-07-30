import {
  type AddProjectActionId,
  type AddProjectFlowState,
  addProjectActionKey,
  applyAddProjectFolderReviewed,
  applyAddProjectFolderReviewFailed,
  applyAddProjectSubmitted,
  createAddProjectFlow,
  createInitialTuiState,
  createNewSessionFlow,
  type NewSessionActionId,
  newSessionActionInputPath,
  openAddProject,
  transitionAddProjectFlow,
  transitionNewSessionFlow,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

const ADD_PROJECT_VISIBLE_ACTIONS: ReadonlyArray<{
  state: AddProjectFlowState;
  ids: readonly AddProjectActionId[];
}> = (() => {
  const start = createAddProjectFlow({ cwd: "/workspace", homeDir: "/home/example" });
  const choose = transitionAddProjectFlow(start, {
    type: "folderLoaded",
    result: { path: "/workspace", entries: [] },
  }).state;
  const review = transitionAddProjectFlow(start, {
    type: "folderReviewed",
    review: {
      selectedPath: "/workspace/station",
      gitRoot: "/workspace/station",
      id: "station",
      label: "Station",
    },
  }).state;
  if (choose === undefined || review === undefined) throw new Error("expected add-project states");
  const editing = transitionAddProjectFlow(review, { type: "editIdStart" }).state;
  const failed = transitionAddProjectFlow(review, {
    type: "submitFailed",
    error: { tag: "ConfigError", code: "CONFIG_WRITE_FAILED", message: "failed" },
  }).state;
  const success = transitionAddProjectFlow(review, {
    type: "submitted",
    label: "Station",
    root: "/workspace/station",
  }).state;
  if (editing === undefined || failed === undefined || success === undefined) {
    throw new Error("expected terminal add-project states");
  }
  return [
    { state: start, ids: ["start.open", "start.cancel"] },
    {
      state: choose,
      ids: ["choose.choose", "choose.open", "choose.parent", "choose.search", "choose.cancel"],
    },
    {
      state: review,
      ids: ["review.submit", "review.editId", "review.chooseFolder", "review.cancel"],
    },
    { state: editing, ids: ["editId.save", "editId.back"] },
    { state: success, ids: ["success.dashboard"] },
    { state: failed, ids: ["failed.retry", "failed.chooseFolder", "failed.cancel"] },
  ];
})();

describe("primary workflow interaction parity", () => {
  it("gives every visible Add Project action an enabled shared key path", () => {
    for (const { state, ids } of ADD_PROJECT_VISIBLE_ACTIONS) {
      for (const id of ids) {
        expect(addProjectActionKey(state, id), `${state.mode}:${id}`).toBeDefined();
      }
    }
  });

  it("keeps Git-invalid Add Project submit disabled while recovery stays reachable", () => {
    let state = openAddProject(createInitialTuiState(), {
      cwd: "/workspace",
      homeDir: "/home/example",
    });
    state = applyAddProjectFolderReviewed(state, {
      selectedPath: "/workspace/notes",
      id: "notes",
      label: "Notes",
    });
    if (state.screen.name !== "addProject") throw new Error("expected Add Project");
    expect(addProjectActionKey(state.screen.flow, "review.submit")).toBeUndefined();
    expect(addProjectActionKey(state.screen.flow, "review.chooseFolder")).toBeDefined();

    state = applyAddProjectFolderReviewFailed(state, "/workspace/notes", new Error("failed"));
    state = applyAddProjectSubmitted(state, { label: "Notes", root: "/workspace/notes" });
    expect(state.screen.name).toBe("addProject");
  });

  it("gives every visible Create Session control a shared keyboard path", () => {
    const snapshot = createDashboardSnapshot();
    const review = createNewSessionFlow(snapshot, "aaaaaa");
    if (review === undefined) throw new Error("expected New Session");
    const reviewIds: NewSessionActionId[] = [
      "review.project",
      "review.name",
      "review.agent",
      "review.create",
    ];
    for (const id of reviewIds) {
      expect(newSessionActionInputPath(review, id), id).toBeDefined();
    }

    const edit = transitionNewSessionFlow(review, { type: "editName" });
    if (edit?.mode !== "editName") throw new Error("expected name editor");
    for (const id of ["editName.name", "editName.save", "editName.back"] as const) {
      expect(newSessionActionInputPath(edit, id), id).toBeDefined();
    }
  });
});
