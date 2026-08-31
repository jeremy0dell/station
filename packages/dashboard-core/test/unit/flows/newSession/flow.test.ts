import { describe, expect, it } from "vitest";
import {
  newSessionActionEnabled,
  newSessionIntentForAction,
} from "../../../../src/flows/newSession/actions.js";
import {
  chooseNewSessionAgentById,
  chooseNewSessionGroupById,
  chooseNewSessionProjectById,
  createNewSessionFlow,
  transitionNewSessionFlow,
} from "../../../../src/flows/newSession/flow.js";
import { createGroupedDashboardSnapshot } from "../../../fixtures/snapshots.js";
import { applyInput, createHarnessSnapshot, createProjectSnapshot, typeName } from "./support.js";

describe("New Session flow", () => {
  it("defaults to the first configured project and first configured agent", () => {
    const state = createNewSessionFlow(createHarnessSnapshot(), "k7p3x9");

    expect(state).toEqual({
      mode: "review",
      reviewFocus: "create",
      selectedProjectId: "web",
      selectedHarness: "codex",
      title: "web-k7p3x9",
      branch: "web-k7p3x9",
      titleSource: "generated",
      groupSelection: { kind: "ungrouped" },
      stepHistory: [],
    });
    expect(Object.hasOwn(state ?? {}, "draftName")).toBe(false);
  });

  it("trims custom titles without changing the generated branch", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");

    const editing = transitionNewSessionFlow(opened, { type: "editName" });
    if (editing?.mode !== "editName") throw new Error("expected edit mode");

    const state = typeName(editing, " Hexagonal PT 12! ");

    expect(transitionNewSessionFlow(state, { type: "commitName" })).toMatchObject({
      mode: "review",
      title: "Hexagonal PT 12!",
      branch: "web-aaaaaa",
      titleSource: "custom",
    });
  });

  it("preselects only a same-project root Group", () => {
    const snapshot = createGroupedDashboardSnapshot();

    expect(
      createNewSessionFlow(snapshot, "aaaaaa", { projectId: "web", groupId: "group_active" }),
    ).toMatchObject({ groupSelection: { kind: "existing", groupId: "group_active" } });
    expect(
      createNewSessionFlow(snapshot, "aaaaaa", { projectId: "web", groupId: "group_build" }),
    ).toMatchObject({ groupSelection: { kind: "ungrouped" } });
    expect(
      createNewSessionFlow(snapshot, "aaaaaa", { projectId: "web", groupId: "group_api" }),
    ).toMatchObject({ groupSelection: { kind: "ungrouped" } });
  });

  it("commits an existing Group or a trimmed inline draft", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    const picker = transitionNewSessionFlow(opened, { type: "pickGroup" });
    if (picker?.mode !== "pickGroup") throw new Error("expected Group picker");

    expect(chooseNewSessionGroupById(picker, snapshot, "group_active")).toMatchObject({
      mode: "review",
      reviewFocus: "group",
      groupSelection: { kind: "existing", groupId: "group_active" },
    });
    expect(chooseNewSessionGroupById(picker, snapshot, "group_build")).toBe(picker);

    const editing = transitionNewSessionFlow(picker, { type: "editGroupDraft" });
    if (editing?.mode !== "editGroupDraft") throw new Error("expected Group editor");
    expect(newSessionActionEnabled(snapshot, editing, "editGroupDraft.save")).toBe(false);
    expect(newSessionActionEnabled(snapshot, editing, "editGroupDraft.back")).toBe(true);
    const typed = "  Release  ".split("").reduce((state, value) => {
      const next = applyInput(state, value);
      if (next.mode !== "editGroupDraft") throw new Error("expected Group editor");
      return next;
    }, editing);
    expect(newSessionActionEnabled(snapshot, typed, "editGroupDraft.save")).toBe(true);
    expect(newSessionIntentForAction(typed, "editGroupDraft.save")).toEqual({
      type: "transition",
      action: { type: "commitGroupDraft" },
    });
    expect(newSessionIntentForAction(typed, "editGroupDraft.back")).toEqual({
      type: "transition",
      action: { type: "cancel" },
    });
    expect(applyInput(typed, "\r", { return: true })).toMatchObject({
      mode: "review",
      reviewFocus: "group",
      groupSelection: { kind: "create", name: "Release" },
    });
  });

  it("uses wizard history for substep cancellation", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");

    const editing = transitionNewSessionFlow(opened, { type: "editName" });
    expect(editing).toMatchObject({
      mode: "editName",
      stepHistory: ["review"],
      draftName: { value: "", cursor: 0 },
    });

    const reviewed = transitionNewSessionFlow(editing ?? opened, { type: "cancel" });
    expect(reviewed).toMatchObject({
      mode: "review",
      stepHistory: [],
    });
  });

  it("keeps the chosen agent and regenerates generated names when the project changes", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");

    // Pick a non-default harness so the assertion can tell "preserved" from "reset to default".
    const chosen = { ...opened, selectedHarness: "opencode" as const };
    const picker = transitionNewSessionFlow(chosen, { type: "pickProject" });
    if (picker?.mode !== "pickProject") throw new Error("expected project picker");
    const selected = chooseNewSessionProjectById(picker, snapshot, "api", "bbbbbb");

    expect(selected).toMatchObject({
      mode: "review",
      selectedProjectId: "api",
      selectedHarness: "opencode",
      title: "api-bbbbbb",
      branch: "api-bbbbbb",
      titleSource: "generated",
    });
  });

  it("keeps custom names when the project changes", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");

    const custom = {
      ...opened,
      title: "Hexagonal PT 12",
      titleSource: "custom" as const,
    };
    const picker = transitionNewSessionFlow(custom, { type: "pickProject" });
    if (picker?.mode !== "pickProject") throw new Error("expected project picker");
    const selected = chooseNewSessionProjectById(picker, snapshot, "api", "bbbbbb");

    expect(selected).toMatchObject({
      selectedProjectId: "api",
      selectedHarness: "codex",
      title: "Hexagonal PT 12",
      branch: "api-bbbbbb",
      titleSource: "custom",
    });
  });

  it("ignores a project pick for an unknown id", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    const picker = transitionNewSessionFlow(opened, { type: "pickProject" });
    if (picker?.mode !== "pickProject") throw new Error("expected project picker");

    expect(chooseNewSessionProjectById(picker, snapshot, "ghost", "bbbbbb")).toBe(picker);
  });

  it("commits a project by id from a larger list", () => {
    const snapshot = createProjectSnapshot(10);
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    const picker = transitionNewSessionFlow(opened, { type: "pickProject" });
    if (picker?.mode !== "pickProject") throw new Error("expected project picker");

    const selected = chooseNewSessionProjectById(picker, snapshot, "project-10", "bbbbbb");

    expect(selected).toMatchObject({
      mode: "review",
      selectedProjectId: "project-10",
      selectedHarness: "codex",
      title: "project-10-bbbbbb",
      branch: "project-10-bbbbbb",
    });
  });

  it("ignores an agent pick for an unknown id", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    const picker = transitionNewSessionFlow(opened, { type: "pickAgent" });
    if (picker?.mode !== "pickAgent") throw new Error("expected agent picker");

    expect(chooseNewSessionAgentById(picker, snapshot, "ghost")).toBe(picker);
  });
});
