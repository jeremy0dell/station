import {
  chooseNewSessionAgentById,
  chooseNewSessionProjectById,
  createNewSessionFlow,
  createNewSessionNameToken,
  harnessOptions,
  newSessionIntentForInput,
  transitionNewSessionFlow,
  validateNewSessionCreate,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

describe("new session flow", () => {
  it("defaults to the first configured project and first configured agent", () => {
    const state = createNewSessionFlow(createHarnessSnapshot(), "k7p3x9");

    expect(state).toEqual({
      mode: "review",
      selectedProjectId: "web",
      selectedHarness: "codex",
      branch: "web-k7p3x9",
      nameSource: "generated",
      stepHistory: [],
    });
    expect(Object.hasOwn(state ?? {}, "draftName")).toBe(false);
  });

  it("creates deterministic path-safe name tokens from unique sources", () => {
    expect(createNewSessionNameToken("source-a")).toMatch(/^[a-f0-9]{6}$/);
    expect(createNewSessionNameToken("source-a")).toBe(createNewSessionNameToken("source-a"));
    expect(createNewSessionNameToken("source-a")).not.toBe(createNewSessionNameToken("source-b"));
  });

  it("trims typed names and otherwise preserves branch text", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");

    const editing = transitionNewSessionFlow(opened, { type: "editName" });
    if (editing?.mode !== "editName") throw new Error("expected edit mode");

    const state = typeName(editing, " feature/foo ");

    expect(transitionNewSessionFlow(state, { type: "commitName" })).toMatchObject({
      mode: "review",
      branch: "feature/foo",
      nameSource: "custom",
    });
  });

  it("keeps input interpretation out of the app input handler", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");

    expect(newSessionIntentForInput(opened, input("P"))).toEqual({
      type: "transition",
      action: { type: "pickProject" },
    });
    expect(newSessionIntentForInput(opened, input("N"))).toEqual({
      type: "transition",
      action: { type: "editName" },
    });
    expect(newSessionIntentForInput(opened, input("E"))).toEqual({ type: "none" });
    expect(newSessionIntentForInput(opened, input("p"))).toEqual({ type: "none" });
    expect(newSessionIntentForInput(opened, input("a"))).toEqual({ type: "none" });
    expect(newSessionIntentForInput(opened, input("\r", { return: true }))).toEqual({
      type: "submit",
    });

    // In a pick step the shared selection engine owns ↑↓/↵/slot before this
    // handler, so a slot key yields no intent here.
    const picker = transitionNewSessionFlow(opened, { type: "pickAgent" });
    if (picker?.mode !== "pickAgent") throw new Error("expected agent picker");
    expect(newSessionIntentForInput(picker, input("2"))).toEqual({ type: "none" });
    expect(chooseNewSessionAgentById(picker, snapshot, "opencode")).toMatchObject({
      mode: "review",
      selectedHarness: "opencode",
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
      branch: "api-bbbbbb",
      nameSource: "generated",
    });
  });

  it("keeps custom names when the project changes", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");

    const custom = {
      ...opened,
      branch: "feature/custom",
      nameSource: "custom" as const,
    };
    const picker = transitionNewSessionFlow(custom, { type: "pickProject" });
    if (picker?.mode !== "pickProject") throw new Error("expected project picker");
    const selected = chooseNewSessionProjectById(picker, snapshot, "api", "bbbbbb");

    expect(selected).toMatchObject({
      selectedProjectId: "api",
      selectedHarness: "codex",
      branch: "feature/custom",
      nameSource: "custom",
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
      branch: "project-10-bbbbbb",
    });
  });

  it("yields no pick-step intent for any key (the selection engine owns them)", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    const picker = transitionNewSessionFlow(opened, { type: "pickProject" });
    if (picker?.mode !== "pickProject") throw new Error("expected project picker");

    for (const key of [
      input("0"),
      input("2"),
      input("j"),
      input("", { downArrow: true }),
      input("", { upArrow: true }),
      input("\r", { return: true }),
    ]) {
      expect(newSessionIntentForInput(picker, key)).toEqual({ type: "none" });
    }
  });

  it("ignores an agent pick for an unknown id", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    const picker = transitionNewSessionFlow(opened, { type: "pickAgent" });
    if (picker?.mode !== "pickAgent") throw new Error("expected agent picker");

    expect(chooseNewSessionAgentById(picker, snapshot, "ghost")).toBe(picker);
  });

  it("moves the edit-name cursor and edits at the insertion point", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    const editing = transitionNewSessionFlow(opened, { type: "editName" });
    if (editing?.mode !== "editName") throw new Error("expected edit mode");

    const typed = typeName(editing, "feature/foo");
    const movedOnce = applyInput(typed, "", { leftArrow: true });
    const movedTwice = applyInput(movedOnce, "", { leftArrow: true });
    const movedLeft = applyInput(movedTwice, "", { leftArrow: true });
    if (movedLeft?.mode !== "editName") throw new Error("expected edit mode");
    expect(movedLeft.draftName.cursor).toBe(8);

    const inserted = applyInput(movedLeft, "-bar");
    expect(inserted).toMatchObject({
      mode: "editName",
      draftName: {
        value: "feature/-barfoo",
        cursor: 12,
      },
    });

    const backspaced = applyInput(inserted, "", { backspace: true });
    expect(backspaced).toMatchObject({
      mode: "editName",
      draftName: {
        value: "feature/-bafoo",
        cursor: 11,
      },
    });

    const deleted = applyInput(backspaced, "", { delete: true });
    expect(deleted).toMatchObject({
      mode: "editName",
      draftName: {
        value: "feature/-baoo",
        cursor: 11,
      },
    });
  });

  it("treats Ctrl-U as delete-before-cursor in edit-name", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    const editing = transitionNewSessionFlow(opened, { type: "editName" });
    if (editing?.mode !== "editName") throw new Error("expected edit mode");

    const typed = typeName(editing, "featurefoo");
    const movedOnce = applyInput(typed, "", { leftArrow: true });
    const movedTwice = applyInput(movedOnce, "", { leftArrow: true });
    const movedLeft = applyInput(movedTwice, "", { leftArrow: true });

    expect(newSessionIntentForInput(movedLeft, input("u", { ctrl: true }))).toEqual({
      type: "transition",
      action: { type: "editNameInput", action: { type: "deleteBeforeCursor" } },
    });
    expect(applyInput(movedLeft, "u", { ctrl: true })).toMatchObject({
      mode: "editName",
      draftName: {
        value: "foo",
        cursor: 0,
      },
    });
  });

  it("maps left and right arrows to edit-name cursor movement", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    const editing = transitionNewSessionFlow(opened, { type: "editName" });
    if (editing?.mode !== "editName") throw new Error("expected edit mode");

    expect(newSessionIntentForInput(editing, input("", { leftArrow: true }))).toEqual({
      type: "transition",
      action: { type: "editNameInput", action: { type: "moveCursor", delta: -1 } },
    });
    expect(newSessionIntentForInput(editing, input("", { rightArrow: true }))).toEqual({
      type: "transition",
      action: { type: "editNameInput", action: { type: "moveCursor", delta: 1 } },
    });
  });

  it("orders agent options from configured harnesses without a project default", () => {
    const snapshot = createHarnessSnapshot();
    const api = snapshot.projects.find((project) => project.id === "api");
    if (api === undefined) throw new Error("missing api project");

    expect(harnessOptions(snapshot, api).map((option) => option.id)).toEqual([
      "codex",
      "opencode",
      "scripted",
    ]);
  });

  it("blocks unavailable agents while allowing degraded and unknown agents", () => {
    const snapshot = createHarnessSnapshot({
      codex: "unavailable",
      opencode: "degraded",
    });
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");

    expect(validateNewSessionCreate(snapshot, opened)).toMatchObject({
      ok: false,
      error: {
        code: "HARNESS_PROVIDER_UNAVAILABLE",
      },
    });

    const opencode = { ...opened, selectedHarness: "opencode" };
    expect(validateNewSessionCreate(snapshot, opencode)).toMatchObject({
      ok: true,
      harnessProvider: "opencode",
    });

    const unknown = { ...opened, selectedHarness: "scripted" };
    expect(validateNewSessionCreate(snapshot, unknown)).toMatchObject({
      ok: true,
      harnessProvider: "scripted",
    });
  });
});

function createHarnessSnapshot(
  statuses: Partial<
    Record<"codex" | "opencode" | "scripted", "healthy" | "degraded" | "unavailable">
  > = {},
) {
  const snapshot = createDashboardSnapshot();
  return {
    ...snapshot,
    harnesses: [
      { id: "codex", label: "codex" },
      { id: "opencode", label: "opencode" },
      { id: "scripted", label: "scripted" },
    ],
    providerHealth: {
      ...snapshot.providerHealth,
      codex: harnessHealth("codex", statuses.codex ?? "healthy", snapshot.generatedAt),
      opencode: harnessHealth("opencode", statuses.opencode ?? "healthy", snapshot.generatedAt),
    },
  };
}

function createProjectSnapshot(count: number) {
  const snapshot = createHarnessSnapshot();
  const baseProject = snapshot.projects[0];
  if (baseProject === undefined) throw new Error("expected project");
  return {
    ...snapshot,
    projects: Array.from({ length: count }, (_, index) => {
      const id = `project-${index + 1}`;
      return {
        ...baseProject,
        id,
        label: id,
        root: `/tmp/station/${id}`,
        defaults: {
          ...baseProject.defaults,
          harness: "codex",
        },
      };
    }),
    rows: [],
    sessions: [],
  };
}

function typeName(
  initialState: NonNullable<ReturnType<typeof transitionNewSessionFlow>> & { mode: "editName" },
  value: string,
) {
  return value.split("").reduce((state, input) => {
    const next = applyInput(state, input);
    if (next?.mode !== "editName") throw new Error("expected edit mode");
    return next;
  }, initialState);
}

function applyInput(
  state: NonNullable<ReturnType<typeof transitionNewSessionFlow>>,
  value: string,
  key: Parameters<typeof newSessionIntentForInput>[1]["key"] = {},
) {
  const intent = newSessionIntentForInput(state, input(value, key));
  if (intent.type !== "transition") throw new Error("expected transition intent");
  const next = transitionNewSessionFlow(state, intent.action);
  if (next === undefined) throw new Error("expected state");
  return next;
}

function input(
  value: string,
  key: Parameters<typeof newSessionIntentForInput>[1]["key"] = {},
): Parameters<typeof newSessionIntentForInput>[1] {
  return {
    input: value,
    key,
    token: "bbbbbb",
  };
}

function harnessHealth(
  providerId: string,
  status: "healthy" | "degraded" | "unavailable",
  lastCheckedAt: string,
) {
  return {
    providerId,
    providerType: "harness" as const,
    status,
    lastCheckedAt,
  };
}
