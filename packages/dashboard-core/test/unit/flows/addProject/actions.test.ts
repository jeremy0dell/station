import {
  addProjectActions,
  createAddProjectFlow,
  transitionAddProjectFlow,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";

describe("Add Project action descriptors", () => {
  it("owns stable order, labels, accelerators, and intent", () => {
    const state = createAddProjectFlow({ cwd: "/workspace", homeDir: "/home/example" });

    expect(addProjectActions(state)).toEqual([
      {
        id: "start.open",
        label: "Open",
        compactLabel: "Open",
        accelerator: "→/↵",
        intent: "primary",
        enabled: true,
      },
      {
        id: "start.cancel",
        label: "Cancel",
        compactLabel: "Back",
        accelerator: "Esc",
        intent: "secondary",
        enabled: true,
      },
    ]);
  });

  it("uses the canonical folder selection and pasted path for chooser availability", () => {
    const started = createAddProjectFlow({ cwd: "/workspace", homeDir: "/home/example" });
    const choosing = transitionAddProjectFlow(started, {
      type: "folderLoaded",
      result: {
        path: "/workspace",
        entries: [{ name: "station", path: "/workspace/station", kind: "directory" }],
      },
    }).state;
    if (choosing?.mode !== "choose") throw new Error("expected chooser");

    expect(
      addProjectActions(choosing, 0).find((action) => action.id === "choose.open")?.enabled,
    ).toBe(false);
    expect(
      addProjectActions(choosing, 1).find((action) => action.id === "choose.open")?.enabled,
    ).toBe(true);

    const pasted = transitionAddProjectFlow(choosing, {
      type: "filterInput",
      value: "/missing/project",
    }).state;
    if (pasted?.mode !== "choose") throw new Error("expected chooser");
    expect(addProjectActions(pasted).find((action) => action.id === "choose.choose")?.enabled).toBe(
      true,
    );
  });

  it("removes disabled submit from focus traversal without hiding its descriptor", () => {
    const start = createAddProjectFlow({ cwd: "/workspace", homeDir: "/home/example" });
    const review = transitionAddProjectFlow(start, {
      type: "folderReviewed",
      review: { selectedPath: "/workspace/notes", id: "notes", label: "Notes" },
    }).state;
    if (review?.mode !== "review") throw new Error("expected review");

    expect(addProjectActions(review).find((action) => action.id === "review.submit")?.enabled).toBe(
      false,
    );
    expect(transitionAddProjectFlow(review, { type: "actionFocus", dir: 1 }).state).toMatchObject({
      mode: "review",
      actionFocus: "cancel",
    });
  });
});
