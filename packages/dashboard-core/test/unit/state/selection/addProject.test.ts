import {
  addProjectSelectedIndex,
  applyAddProjectFolderLoaded,
  applyAddProjectFolderReviewed,
  applyAddProjectFolderReviewFailed,
  applyAddProjectFolderSearchLoaded,
  applyAddProjectSubmitted,
  createInitialTuiState,
  deriveTuiInputMode,
  handleTuiKey,
  openAddProject,
  selectAddProjectRow,
  type TuiState,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";

const KEY_CONTEXT = { cwd: "/workspace/station", homeDir: "/Users/example" };

function startState(): TuiState {
  return openAddProject(createInitialTuiState(), {
    cwd: KEY_CONTEXT.cwd,
    homeDir: KEY_CONTEXT.homeDir,
  });
}

function chooseState(
  entries = [{ name: "station", path: "/workspace/station", kind: "directory" as const }],
) {
  return applyAddProjectFolderLoaded(startState(), {
    path: "/workspace",
    entries,
  });
}

function reviewState(): TuiState {
  return applyAddProjectFolderReviewed(startState(), {
    selectedPath: "/workspace/station",
    gitRoot: "/workspace/station",
    id: "station",
    label: "Station",
  });
}

describe("add-project shared selection", () => {
  it("seeds the start cursor and routes arrows and Enter through the registered list", () => {
    const opened = startState();
    expect(deriveTuiInputMode(opened)).toBe("addProjectStart");
    expect(addProjectSelectedIndex(opened)).toBe(0);

    const moved = handleTuiKey(opened, { input: "", downArrow: true }, KEY_CONTEXT).state;
    expect(addProjectSelectedIndex(moved)).toBe(1);

    const committed = handleTuiKey(moved, { input: "\r", return: true }, KEY_CONTEXT);
    expect(committed.operations).toEqual([
      { type: "loadProjectDirectory", path: "/Users/example" },
    ]);
  });

  it("uses the same canonical cursor for mouse selection", () => {
    const moved = selectAddProjectRow(startState(), 99);
    expect(addProjectSelectedIndex(moved)).toBe(1);
  });

  it("opens the selected start path with Right and closes with Escape", () => {
    const opened = handleTuiKey(startState(), { input: "", rightArrow: true }, KEY_CONTEXT);
    expect(opened.operations).toEqual([
      { type: "loadProjectDirectory", path: "/workspace/station" },
    ]);

    const closed = handleTuiKey(startState(), { input: "", escape: true }, KEY_CONTEXT);
    expect(closed.state.screen).toEqual({ name: "dashboard" });
  });

  it("registers folder selection in normal and filter modes", () => {
    const choosing = chooseState();
    expect(deriveTuiInputMode(choosing)).toBe("addProjectChoose");
    expect(addProjectSelectedIndex(choosing)).toBe(0);

    const moved = handleTuiKey(choosing, { input: "", downArrow: true }, KEY_CONTEXT).state;
    expect(addProjectSelectedIndex(moved)).toBe(1);
    expect(handleTuiKey(moved, { input: "\r", return: true }, KEY_CONTEXT).operations).toEqual([
      { type: "reviewProjectFolder", path: "/workspace/station" },
    ]);

    const filtering = handleTuiKey(choosing, { input: "/" }, KEY_CONTEXT).state;
    expect(deriveTuiInputMode(filtering)).toBe("addProjectFilter");
    expect(handleTuiKey(filtering, { input: "\r", return: true }, KEY_CONTEXT).operations).toEqual([
      { type: "reviewProjectFolder", path: "/workspace" },
    ]);
  });

  it("opens a selected child with Right and its parent with Left", () => {
    const choosing = chooseState();
    expect(
      handleTuiKey(choosing, { input: "", rightArrow: true }, KEY_CONTEXT).operations,
    ).toBeUndefined();

    const child = handleTuiKey(choosing, { input: "", downArrow: true }, KEY_CONTEXT).state;
    expect(handleTuiKey(child, { input: "", rightArrow: true }, KEY_CONTEXT).operations).toEqual([
      { type: "loadProjectDirectory", path: "/workspace/station" },
    ]);
    expect(handleTuiKey(child, { input: "", leftArrow: true }, KEY_CONTEXT).operations).toEqual([
      { type: "loadProjectDirectory", path: "/" },
    ]);
  });

  it("handles filter editing and reseeds the cursor when results arrive", () => {
    let state = chooseState([]);
    state = handleTuiKey(state, { input: "/" }, KEY_CONTEXT).state;
    state = handleTuiKey(state, { input: "zz" }, KEY_CONTEXT).state;
    expect(addProjectSelectedIndex(state)).toBeUndefined();

    state = handleTuiKey(state, { input: "", backspace: true }, KEY_CONTEXT).state;
    expect(state.screen).toMatchObject({ name: "addProject", flow: { filter: "z" } });
    state = handleTuiKey(state, { input: "", delete: true }, KEY_CONTEXT).state;
    expect(state.screen).toMatchObject({ name: "addProject", flow: { filter: "" } });

    state = handleTuiKey(state, { input: "zz" }, KEY_CONTEXT).state;
    state = applyAddProjectFolderSearchLoaded(state, {
      query: "zz",
      entries: [{ name: "fizz", path: "/search/fizz", kind: "directory" }],
      truncated: false,
    });
    expect(addProjectSelectedIndex(state)).toBe(0);

    state = handleTuiKey(state, { input: "u", ctrl: true }, KEY_CONTEXT).state;
    expect(state.screen).toMatchObject({
      name: "addProject",
      flow: { filter: "", filterMode: false },
    });
  });

  it("falls through to pasted-path review when filtering has no rows", () => {
    let state = chooseState([]);
    state = handleTuiKey(state, { input: "/" }, KEY_CONTEXT).state;
    state = handleTuiKey(state, { input: "/missing/project" }, KEY_CONTEXT).state;

    const submitted = handleTuiKey(state, { input: "\r", return: true }, KEY_CONTEXT);
    expect(submitted.operations).toEqual([
      { type: "reviewProjectFolder", path: "/missing/project" },
    ]);
  });
});

describe("add-project mode intents", () => {
  it("maps review, id editing, and back actions", () => {
    const reviewing = reviewState();
    expect(deriveTuiInputMode(reviewing)).toBe("addProjectReview");

    const editing = handleTuiKey(reviewing, { input: "N" }, KEY_CONTEXT).state;
    expect(deriveTuiInputMode(editing)).toBe("addProjectEditId");

    const changed = handleTuiKey(editing, { input: "-custom" }, KEY_CONTEXT).state;
    const committed = handleTuiKey(changed, { input: "\r", return: true }, KEY_CONTEXT).state;
    expect(committed.screen).toMatchObject({
      name: "addProject",
      flow: { mode: "review", id: "station-custom" },
    });

    expect(handleTuiKey(committed, { input: "B" }, KEY_CONTEXT).operations).toEqual([
      { type: "loadProjectDirectory", path: "/workspace/station" },
    ]);
  });

  it("cancels id editing without changing the project id", () => {
    const reviewing = reviewState();
    let state = handleTuiKey(reviewing, { input: "N" }, KEY_CONTEXT).state;
    state = handleTuiKey(state, { input: "-discarded" }, KEY_CONTEXT).state;
    state = handleTuiKey(state, { input: "", escape: true }, KEY_CONTEXT).state;

    expect(state.screen).toMatchObject({
      name: "addProject",
      flow: { mode: "review", id: "station" },
    });
  });

  it("submits review, closes success, and retries failure", () => {
    const reviewing = reviewState();
    expect(handleTuiKey(reviewing, { input: "\r", return: true }, KEY_CONTEXT).operations).toEqual([
      {
        type: "addProject",
        command: {
          type: "project.add",
          payload: { path: "/workspace/station", id: "station", label: "Station" },
        },
      },
    ]);

    const success = applyAddProjectSubmitted(reviewing, {
      label: "Station",
      root: "/workspace/station",
    });
    expect(deriveTuiInputMode(success)).toBe("addProjectSuccess");
    expect(handleTuiKey(success, { input: "\r", return: true }, KEY_CONTEXT).state.screen).toEqual({
      name: "dashboard",
    });

    const failed = applyAddProjectFolderReviewFailed(
      reviewing,
      "/workspace/station",
      new Error("failed"),
    );
    expect(deriveTuiInputMode(failed)).toBe("addProjectFailed");
    expect(handleTuiKey(failed, { input: "R" }, KEY_CONTEXT).operations).toEqual([
      { type: "reviewProjectFolder", path: "/workspace/station" },
    ]);
    expect(handleTuiKey(failed, { input: "B" }, KEY_CONTEXT).operations).toEqual([
      { type: "loadProjectDirectory", path: "/workspace/station" },
    ]);
    expect(handleTuiKey(failed, { input: "", escape: true }, KEY_CONTEXT).state.screen).toEqual({
      name: "dashboard",
    });
    expect(handleTuiKey(success, { input: "", escape: true }, KEY_CONTEXT).state.screen).toEqual({
      name: "dashboard",
    });
  });

  it("clears filtering before Escape closes the wizard", () => {
    let state = chooseState();
    state = handleTuiKey(state, { input: "/" }, KEY_CONTEXT).state;
    state = handleTuiKey(state, { input: "st" }, KEY_CONTEXT).state;

    const cleared = handleTuiKey(state, { input: "", escape: true }, KEY_CONTEXT).state;
    expect(cleared.screen).toMatchObject({
      name: "addProject",
      flow: { mode: "choose", filter: "", filterMode: false },
    });

    expect(handleTuiKey(cleared, { input: "", escape: true }, KEY_CONTEXT).state.screen).toEqual({
      name: "dashboard",
    });
  });
});
