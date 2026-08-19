import type { StationSnapshot } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { handleTuiAction } from "../../../../src/state/actions.js";
import type { TuiKey } from "../../../../src/state/keys.js";
import { createInitialTuiState, replaceSnapshot } from "../../../../src/state/screen.js";
import { openForkDetailsForRow } from "../../../../src/state/screens/fork.js";
import type { TuiTransition } from "../../../../src/state/transition.js";
import { handleTuiKey } from "../../../../src/state/transition.js";
import type { DashboardState } from "../../../../src/state/types.js";
import {
  createDashboardSnapshot,
  createGroupedDashboardSnapshot,
} from "../../../fixtures/snapshots.js";

const CTX = { cwd: "/Users/example/Developer/station", homeDir: "/Users/example" };

function base(): DashboardState {
  return createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
}

function step(state: DashboardState, key: TuiKey): TuiTransition {
  return handleTuiKey(state, key, CTX);
}

function drive(state: DashboardState, keys: readonly TuiKey[]): DashboardState {
  let current = state;
  for (const key of keys) {
    current = handleTuiKey(current, key, CTX).state;
  }
  return current;
}

const ENTER: TuiKey = { input: "\r", return: true };
const ESC: TuiKey = { input: "", escape: true };
const DOWN: TuiKey = { input: "", downArrow: true };
const BACKSPACE: TuiKey = { input: "", backspace: true };
const type = (char: string): TuiKey => ({ input: char });

function detailsScreen(state: DashboardState) {
  if (state.screen.name !== "fork" || state.screen.step !== "details") {
    throw new Error(`expected fork details, got ${state.screen.name}`);
  }
  return state.screen;
}

function openDetails(branchToken = "aaaaaa"): DashboardState {
  return openForkDetailsForRow(base(), "ses_wt_web_idle", { branchToken });
}

function openGroupedDetails(branchToken = "aaaaaa"): DashboardState {
  return openForkDetailsForRow(
    createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() }),
    "ses_wt_web_idle",
    { branchToken },
  );
}

function clearTitle(state: DashboardState): DashboardState {
  let current = state;
  while (
    current.screen.name === "fork" &&
    current.screen.step === "details" &&
    current.screen.draftTitle.value.length > 0
  ) {
    current = step(current, BACKSPACE).state;
  }
  return current;
}

describe("fork screen", () => {
  it("opens the chooseSlot step from the dashboard via F", () => {
    const state = drive(base(), [type("F")]);
    expect(state.screen).toEqual({ name: "fork", step: "chooseSlot" });
  });

  it("starts with a friendly title and a collision-resistant hidden branch", () => {
    const screen = detailsScreen(openDetails());
    expect(screen.draftTitle.value).toBe(`${screen.sourceBranch}-fork`);
    expect(screen.branch).toMatch(/^fix-nav-mobile-fork-[a-f0-9]+$/);
    expect(screen.branch).not.toBe(screen.draftTitle.value);
    expect(screen.inheritSourceGroup).toBe(true);
    expect(screen.sourceGroup).toBeUndefined();
    expect(screen.copyDirty).toBe(true);
    expect(screen.focus).toBe("name");
    expect(screen.sourceWorktreeId.length).toBeGreaterThan(0);
  });

  it("generates a different hidden branch when retrying an unseen Git-ref collision", () => {
    const first = detailsScreen(openDetails("aaaaaa"));
    const retry = detailsScreen(openDetails("bbbbbb"));

    expect(retry.draftTitle.value).toBe(first.draftTitle.value);
    expect(retry.branch).not.toBe(first.branch);
  });

  it("submits semantic fork product values with the generated branch and copyDirty", () => {
    const opened = openDetails();
    const screen = detailsScreen(opened);
    const transition = step(opened, ENTER);

    expect(transition.state.screen).toEqual({ name: "dashboard" });
    expect(transition.operations).toHaveLength(1);
    const operation = transition.operations?.[0];
    expect(operation?.type).toBe("forkManagedSession");
    if (operation?.type !== "forkManagedSession") throw new Error("unreachable");
    expect(operation.title).toBe(`${screen.sourceBranch}-fork`);
    expect(operation.hiddenBranch).toBe(screen.branch);
    expect(operation.sourceWorktreeId).toBe(screen.sourceWorktreeId);
    expect(operation.copyDirty).toBe(true);
    expect(operation.inheritedHarness).toBeDefined();
  });

  it("inherits a grouped source by stable identity and targets the grouped operation", () => {
    const opened = openGroupedDetails();
    const screen = detailsScreen(opened);
    expect(screen.sourceGroup).toEqual({ id: "group_active", name: "Active work" });
    expect(screen.inheritSourceGroup).toBe(true);

    const transition = step(opened, ENTER);
    const operation = transition.operations?.[0];
    if (operation?.type !== "forkManagedSession") throw new Error("expected fork operation");
    expect(operation.group).toEqual({
      kind: "source",
      sourceSessionId: "ses_wt_web_idle",
      groupId: "group_active",
    });
  });

  it("toggles Group placement through Space, focused Enter, and the semantic pointer action", () => {
    const groupFocused = step(openGroupedDetails(), DOWN).state;
    expect(detailsScreen(groupFocused).focus).toBe("group");

    const spaced = step(groupFocused, type(" "));
    expect(detailsScreen(spaced.state)).toMatchObject({
      focus: "group",
      inheritSourceGroup: false,
    });
    expect(spaced.operations).toBeUndefined();

    const entered = step(spaced.state, ENTER);
    expect(detailsScreen(entered.state).inheritSourceGroup).toBe(true);
    expect(entered.operations).toBeUndefined();

    const clicked = handleTuiAction(
      entered.state,
      { type: "forkSession.activate", actionId: "details.group" },
      CTX,
    );
    expect(detailsScreen(clicked.state)).toMatchObject({
      focus: "group",
      inheritSourceGroup: false,
    });
    const submit = handleTuiAction(
      clicked.state,
      { type: "forkSession.activate", actionId: "details.submit" },
      CTX,
    );
    const operation = submit.operations?.[0];
    if (operation?.type !== "forkManagedSession") throw new Error("expected fork operation");
    expect(operation.group).toBeUndefined();
  });

  it("keeps an ungrouped source read-only and out of the focus order", () => {
    const opened = openDetails();
    expect(detailsScreen(opened).sourceGroup).toBeUndefined();
    expect(detailsScreen(step(opened, DOWN).state).focus).toBe("copyDirty");
    expect(
      handleTuiAction(opened, { type: "forkSession.activate", actionId: "details.group" }, CTX),
    ).toEqual({ state: opened });
  });

  it("follows canonical source Group changes while preserving an explicit opt-out", () => {
    const opened = openGroupedDetails();
    const snapshot = opened.snapshot;
    if (snapshot === undefined) throw new Error("expected snapshot");
    const renamed = replaceSnapshot(opened, {
      ...snapshot,
      sessionGroups: snapshot.sessionGroups.map((group) =>
        group.id === "group_active" ? { ...group, name: "Renamed work" } : group,
      ),
    });
    expect(detailsScreen(renamed).sourceGroup).toEqual({
      id: "group_active",
      name: "Renamed work",
    });

    const moved = replaceSnapshot(renamed, {
      ...snapshot,
      sessionGroups: snapshot.sessionGroups.map((group) => {
        if (group.id === "group_active") {
          return {
            ...group,
            sessionIds: group.sessionIds.filter((id) => id !== "ses_wt_web_idle"),
          };
        }
        if (group.id === "group_empty") {
          return { ...group, sessionIds: ["ses_wt_web_idle"] };
        }
        return group;
      }),
    });
    expect(detailsScreen(moved)).toMatchObject({
      sourceGroup: { id: "group_empty", name: "Empty" },
      inheritSourceGroup: true,
    });
    const movedSubmit = handleTuiAction(
      moved,
      { type: "forkSession.activate", actionId: "details.submit" },
      CTX,
    );
    expect(movedSubmit.operations?.[0]).toMatchObject({
      type: "forkManagedSession",
      group: {
        kind: "source",
        sourceSessionId: "ses_wt_web_idle",
        groupId: "group_empty",
      },
    });

    const optedOut = handleTuiAction(
      moved,
      { type: "forkSession.activate", actionId: "details.group" },
      CTX,
    ).state;
    expect(detailsScreen(optedOut).inheritSourceGroup).toBe(false);
    const removed = replaceSnapshot(optedOut, {
      ...snapshot,
      sessionGroups: snapshot.sessionGroups
        .filter((group) => group.id !== "group_empty")
        .map((group) =>
          group.id === "group_active"
            ? {
                ...group,
                sessionIds: group.sessionIds.filter((id) => id !== "ses_wt_web_idle"),
              }
            : group,
        ),
    });
    expect(detailsScreen(removed).sourceGroup).toBeUndefined();
    expect(detailsScreen(removed).inheritSourceGroup).toBe(false);
    expect(detailsScreen(removed).focus).toBe("copyDirty");
  });

  it("toggles copy-dirty off and reflects it in the submitted command", () => {
    const toggled = drive(openDetails(), [DOWN, type(" ")]);
    expect(detailsScreen(toggled).copyDirty).toBe(false);
    expect(detailsScreen(toggled).focus).toBe("copyDirty");

    const submitFocused = step(toggled, DOWN).state;
    const transition = step(submitFocused, ENTER);
    const operation = transition.operations?.[0];
    if (operation?.type !== "forkManagedSession") throw new Error("expected fork operation");
    expect(operation.copyDirty).toBe(false);
  });

  it("uses semantic field actions for pointer focus and Copy toggling", () => {
    const opened = openDetails();
    const copy = handleTuiAction(
      opened,
      { type: "forkSession.activate", actionId: "details.copyDirty" },
      CTX,
    );

    expect(detailsScreen(copy.state).focus).toBe("copyDirty");
    expect(detailsScreen(copy.state).copyDirty).toBe(false);
    expect(copy.operations).toBeUndefined();

    const name = handleTuiAction(
      copy.state,
      { type: "forkSession.activate", actionId: "details.name" },
      CTX,
    );
    expect(detailsScreen(name.state).focus).toBe("name");
    expect(detailsScreen(name.state).draftTitle).toEqual(detailsScreen(opened).draftTitle);
  });

  it("toggles Copy on focused Enter without submitting", () => {
    const copyFocused = step(openDetails(), DOWN).state;

    const transition = step(copyFocused, ENTER);

    expect(detailsScreen(transition.state).focus).toBe("copyDirty");
    expect(detailsScreen(transition.state).copyDirty).toBe(false);
    expect(transition.operations).toBeUndefined();
  });

  it("submits through the semantic Fork action", () => {
    const opened = openDetails();

    const transition = handleTuiAction(
      opened,
      { type: "forkSession.activate", actionId: "details.submit" },
      CTX,
    );

    expect(transition.state.screen).toEqual({ name: "dashboard" });
    expect(transition.operations?.[0]).toMatchObject({
      type: "forkManagedSession",
      sourceWorktreeId: detailsScreen(opened).sourceWorktreeId,
    });
  });

  it("keeps stale semantic Fork actions inert", () => {
    const state = base();

    expect(
      handleTuiAction(state, { type: "forkSession.activate", actionId: "details.copyDirty" }, CTX),
    ).toEqual({ state });
  });

  it("allows a custom title without changing the hidden branch", () => {
    const opened = openDetails();
    const branch = detailsScreen(opened).branch;
    const edited = drive(clearTitle(opened), "Hexagonal PT 12!".split("").map(type));
    const transition = step(edited, ENTER);
    const operation = transition.operations?.[0];
    if (operation?.type !== "forkManagedSession") throw new Error("expected fork operation");
    expect(operation.title).toBe("Hexagonal PT 12!");
    expect(operation.hiddenBranch).toBe(branch);
  });

  it("rejects an empty title without dispatching an operation", () => {
    const cleared = clearTitle(openDetails());
    const transition = step(cleared, ENTER);
    expect(transition.operations).toBeUndefined();
    expect(detailsScreen(transition.state).validationError).toBe("Session name cannot be empty.");
  });

  it("resolves a hidden branch collision with the next generated suffix", () => {
    const opened = openDetails();
    const screen = detailsScreen(opened);
    const snapshot = opened.snapshot;
    if (snapshot === undefined) throw new Error("expected snapshot");
    const sourceRow = snapshot.rows.find((candidate) => candidate.id === screen.sourceWorktreeId);
    if (sourceRow === undefined) throw new Error("expected source row");
    const collided: DashboardState = {
      ...opened,
      snapshot: {
        ...snapshot,
        rows: [...snapshot.rows, { ...sourceRow, id: "wt_web_late_fork", branch: screen.branch }],
      },
    };

    const transition = step(collided, ENTER);
    const operation = transition.operations?.[0];
    if (operation?.type !== "forkManagedSession") throw new Error("expected fork operation");
    expect(operation.title).toBe(screen.draftTitle.value);
    expect(operation.hiddenBranch).toBe(`${screen.branch}-2`);
  });

  it("scopes branch collisions and suggestions to the source project", () => {
    const initial = detailsScreen(openDetails());
    const snapshot = createDashboardSnapshot();
    const apiRow = snapshot.rows.find((candidate) => candidate.projectId === "api");
    if (apiRow === undefined) throw new Error("expected api row");
    const withOtherProjectCollision: StationSnapshot = {
      ...snapshot,
      rows: [...snapshot.rows, { ...apiRow, id: "wt_api_fork", branch: initial.branch }],
    };
    const opened = openForkDetailsForRow(
      createInitialTuiState({ initialSnapshot: withOtherProjectCollision }),
      "ses_wt_web_idle",
      { branchToken: "aaaaaa" },
    );
    const screen = detailsScreen(opened);
    expect(screen.branch).toBe(initial.branch);
    expect(screen.draftTitle.value).toBe(`${screen.sourceBranch}-fork`);

    const transition = step(opened, ENTER);
    expect(transition.operations).toHaveLength(1);
    const operation = transition.operations?.[0];
    if (operation?.type !== "forkManagedSession") throw new Error("expected fork operation");
    expect(operation.hiddenBranch).toBe(initial.branch);
  });

  it("escapes from details back to chooseSlot, then to the dashboard", () => {
    const backToChoose = step(openDetails(), ESC).state;
    expect(backToChoose.screen).toEqual({ name: "fork", step: "chooseSlot" });
    const backToDashboard = step(backToChoose, ESC).state;
    expect(backToDashboard.screen).toEqual({ name: "dashboard" });
  });
});
