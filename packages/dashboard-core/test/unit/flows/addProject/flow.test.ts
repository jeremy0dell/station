import { describe, expect, it } from "vitest";
import {
  createAddProjectFlow,
  transitionAddProjectFlow,
} from "../../../../src/flows/addProject/flow.js";

describe("add project flow", () => {
  it("starts only from the current directory and home", () => {
    const started = createAddProjectFlow({
      cwd: "/Users/example/Developer/station",
      homeDir: "/Users/example",
    });

    expect(started.choices).toEqual([
      {
        id: "addProjectStart:currentDirectory",
        label: "current directory",
        path: "/Users/example/Developer/station",
        detail: "/Users/example/Developer/station",
      },
      {
        id: "addProjectStart:homeDirectory",
        label: "~",
        path: "/Users/example",
        detail: "home",
      },
    ]);
  });

  it("opens an explicitly selected start path", () => {
    const started = createAddProjectFlow({
      cwd: "/Users/example/Developer/station",
      homeDir: "/Users/example",
    });

    const opened = transitionAddProjectFlow(started, {
      type: "startOpen",
      path: "/Users/example",
    });

    expect(opened.effects).toEqual([{ type: "loadDirectory", path: "/Users/example" }]);
  });

  it("uses wizard history and does not leak choose fields into review state", () => {
    const started = createAddProjectFlow({
      cwd: "/Users/example/Developer/station",
      homeDir: "/Users/example",
    });
    const loaded = transitionAddProjectFlow(started, {
      type: "folderLoaded",
      result: {
        path: "/Users/example/Desktop/projects",
        entries: [
          {
            name: "GermStack",
            path: "/Users/example/Desktop/projects/GermStack",
            kind: "directory",
          },
        ],
      },
    }).state;
    if (loaded?.mode !== "choose") throw new Error("expected choose mode");

    const filtering = transitionAddProjectFlow(loaded, {
      type: "filterInput",
      value: "Germ",
    }).state;
    if (filtering?.mode !== "choose") throw new Error("expected choose mode");

    const reviewed = transitionAddProjectFlow(filtering, {
      type: "folderReviewed",
      review: {
        selectedPath: "/Users/example/Desktop/projects/GermStack",
        gitRoot: "/Users/example/Desktop/projects/GermStack",
        id: "germstack",
        label: "GermStack",
      },
    }).state;

    expect(reviewed).toMatchObject({
      mode: "review",
      stepHistory: ["start", "choose"],
      selectedPath: "/Users/example/Desktop/projects/GermStack",
      id: "germstack",
    });
    expect(Object.hasOwn(reviewed ?? {}, "entries")).toBe(false);
    expect(Object.hasOwn(reviewed ?? {}, "filter")).toBe(false);
    expect(Object.hasOwn(reviewed ?? {}, "searchEntries")).toBe(false);
  });

  it("does not leak choose fields into failure state", () => {
    const started = createAddProjectFlow({
      cwd: "/Users/example/Developer/station",
      homeDir: "/Users/example",
    });
    const loaded = transitionAddProjectFlow(started, {
      type: "folderLoaded",
      result: {
        path: "/Users/example/Desktop/projects",
        entries: [],
      },
    }).state;
    if (loaded?.mode !== "choose") throw new Error("expected choose mode");

    const failed = transitionAddProjectFlow(loaded, {
      type: "folderReviewFailed",
      path: "/Users/example/Desktop/projects/GermStack",
      error: {
        tag: "ConfigError",
        code: "CONFIG_WRITE_FAILED",
        message: "config.toml is not writable.",
      },
    }).state;

    expect(failed).toMatchObject({
      mode: "failed",
      stepHistory: ["start", "choose"],
      selectedPath: "/Users/example/Desktop/projects/GermStack",
    });
    expect(Object.hasOwn(failed ?? {}, "entries")).toBe(false);
    expect(Object.hasOwn(failed ?? {}, "filter")).toBe(false);
    expect(Object.hasOwn(failed ?? {}, "searchEntries")).toBe(false);
  });

  it("seeds action focus for review, success, and failure states", () => {
    const started = createAddProjectFlow({
      cwd: "/Users/example/Developer/station",
      homeDir: "/Users/example",
    });
    const validReview = transitionAddProjectFlow(started, {
      type: "folderReviewed",
      review: {
        selectedPath: "/Users/example/Developer/station",
        gitRoot: "/Users/example/Developer/station",
        id: "station",
        label: "station",
      },
    }).state;
    const invalidReview = transitionAddProjectFlow(started, {
      type: "folderReviewed",
      review: {
        selectedPath: "/Users/example/Desktop/notes",
        id: "notes",
        label: "notes",
      },
    }).state;

    expect(validReview).toMatchObject({ mode: "review", actionFocus: "submit" });
    expect(invalidReview).toMatchObject({ mode: "review", actionFocus: "chooseFolder" });

    const failed = transitionAddProjectFlow(validReview ?? started, {
      type: "submitFailed",
      error: { tag: "ConfigError", code: "CONFIG_WRITE_FAILED", message: "failed" },
    }).state;
    expect(failed).toMatchObject({ mode: "failed", actionFocus: "retry" });

    const succeeded = transitionAddProjectFlow(validReview ?? started, {
      type: "submitted",
      label: "Station",
      root: "/Users/example/Developer/station",
    }).state;
    expect(succeeded).toMatchObject({ mode: "success", actionFocus: "dashboard" });
  });

  it("cycles enabled actions and keeps duplicate submits inert", () => {
    const started = createAddProjectFlow({
      cwd: "/Users/example/Developer/station",
      homeDir: "/Users/example",
    });
    const reviewed = transitionAddProjectFlow(started, {
      type: "folderReviewed",
      review: {
        selectedPath: "/Users/example/Developer/station",
        gitRoot: "/Users/example/Developer/station",
        id: "station",
        label: "station",
      },
    }).state;
    if (reviewed?.mode !== "review") throw new Error("expected review mode");

    const focused = transitionAddProjectFlow(reviewed, { type: "actionFocus", dir: 1 }).state;
    expect(focused).toMatchObject({ mode: "review", actionFocus: "editId" });

    const submitting = transitionAddProjectFlow(reviewed, { type: "submit" });
    if (submitting.state?.mode !== "review") throw new Error("expected submitting review");
    expect(submitting.state.submitting).toBe(true);
    expect(transitionAddProjectFlow(submitting.state, { type: "submit" })).toEqual({
      state: submitting.state,
    });
  });

  it("seeds and preserves edit-id action focus", () => {
    const started = createAddProjectFlow({
      cwd: "/Users/example/Developer/station",
      homeDir: "/Users/example",
    });
    const reviewed = transitionAddProjectFlow(started, {
      type: "folderReviewed",
      review: {
        selectedPath: "/Users/example/Developer/station",
        gitRoot: "/Users/example/Developer/station",
        id: "station",
        label: "station",
      },
    }).state;
    if (reviewed?.mode !== "review") throw new Error("expected review mode");

    const editing = transitionAddProjectFlow(reviewed, { type: "editIdStart" }).state;
    expect(editing).toMatchObject({
      mode: "review",
      actionFocus: "editId",
      editIdActionFocus: "save",
    });
    if (editing?.mode !== "review") throw new Error("expected review mode");
    const backFocused = transitionAddProjectFlow(editing, { type: "actionFocus", dir: 1 }).state;
    expect(backFocused).toMatchObject({ editIdActionFocus: "back" });
    if (backFocused?.mode !== "review") throw new Error("expected review mode");
    expect(transitionAddProjectFlow(backFocused, { type: "editIdCancel" }).state).toMatchObject({
      mode: "review",
      actionFocus: "submit",
    });
  });

  it("does not submit a folder until a git repository is detected", () => {
    const started = createAddProjectFlow({
      cwd: "/Users/example/Desktop",
      homeDir: "/Users/example",
      firstProject: true,
    });
    const reviewed = transitionAddProjectFlow(started, {
      type: "folderReviewed",
      review: {
        selectedPath: "/Users/example/Desktop/notes",
        id: "notes",
        label: "notes",
      },
    }).state;
    if (reviewed?.mode !== "review") throw new Error("expected review mode");

    const submitted = transitionAddProjectFlow(reviewed, { type: "submit" });

    expect(submitted.state).toEqual(reviewed);
    expect(submitted.effects).toBeUndefined();
    expect(reviewed.firstProject).toBe(true);
  });

  it("submits a detected git root without a non-git override", () => {
    const started = createAddProjectFlow({
      cwd: "/Users/example/Developer/station",
      homeDir: "/Users/example",
    });
    const reviewed = transitionAddProjectFlow(started, {
      type: "folderReviewed",
      review: {
        selectedPath: "/Users/example/Developer/station/packages/config",
        gitRoot: "/Users/example/Developer/station",
        id: "station",
        label: "station",
      },
    }).state;
    if (reviewed?.mode !== "review") throw new Error("expected review mode");

    const submitted = transitionAddProjectFlow(reviewed, { type: "submit" });

    expect(submitted.effects).toEqual([
      {
        type: "submitProject",
        command: {
          type: "project.add",
          payload: {
            path: "/Users/example/Developer/station/packages/config",
            id: "station",
            label: "station",
          },
        },
      },
    ]);
  });
});
