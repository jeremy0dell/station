import { createAddProjectFlow, transitionAddProjectFlow } from "@station/dashboard-core";
import { describe, expect, it } from "vitest";

describe("add project flow", () => {
  it("starts only from the current directory and home", () => {
    const started = createAddProjectFlow({
      cwd: "/Users/example/Developer/station",
      homeDir: "/Users/example",
    });

    expect(started.choices).toEqual([
      {
        label: "current directory",
        path: "/Users/example/Developer/station",
        detail: "/Users/example/Developer/station",
      },
      { label: "~", path: "/Users/example", detail: "home" },
    ]);
  });

  it("selects a start row by absolute index and clamps out-of-range clicks", () => {
    const started = createAddProjectFlow({
      cwd: "/Users/example/Developer/station",
      homeDir: "/Users/example",
    });
    expect(started.selectedIndex).toBe(0);

    const picked = transitionAddProjectFlow(started, { type: "select", index: 1 }).state;
    expect(picked?.selectedIndex).toBe(1);

    // A stale click past the list clamps to the last row instead of going out of range.
    const clamped = transitionAddProjectFlow(started, { type: "select", index: 9 }).state;
    expect(clamped?.selectedIndex).toBe(started.choices.length - 1);
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
