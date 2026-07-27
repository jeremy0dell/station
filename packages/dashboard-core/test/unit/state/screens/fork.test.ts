import type { StationSnapshot } from "@station/contracts";
import type { TuiKey, TuiState, TuiTransition } from "@station/dashboard-core";
import {
  createInitialTuiState,
  handleTuiKey,
  openForkDetailsForRow,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../../fixtures/snapshots.js";

const CTX = { cwd: "/Users/example/Developer/station", homeDir: "/Users/example" };

function base(): TuiState {
  return createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
}

function step(state: TuiState, key: TuiKey): TuiTransition {
  return handleTuiKey(state, key, CTX);
}

function drive(state: TuiState, keys: readonly TuiKey[]): TuiState {
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

function detailsScreen(state: TuiState) {
  if (state.screen.name !== "fork" || state.screen.step !== "details") {
    throw new Error(`expected fork details, got ${state.screen.name}`);
  }
  return state.screen;
}

function openDetails(branchToken = "aaaaaa"): TuiState {
  return openForkDetailsForRow(base(), "ses_wt_web_idle", { branchToken });
}

function clearTitle(state: TuiState): TuiState {
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

  it("submits a session.fork operation with the generated branch and copyDirty", () => {
    const opened = openDetails();
    const screen = detailsScreen(opened);
    const transition = step(opened, ENTER);

    expect(transition.state.screen).toEqual({ name: "dashboard" });
    expect(transition.operations).toHaveLength(1);
    const operation = transition.operations?.[0];
    expect(operation?.type).toBe("forkSession");
    if (operation?.type !== "forkSession") throw new Error("unreachable");
    expect(operation.title).toBe(`${screen.sourceBranch}-fork`);
    expect(operation.branch).toBe(screen.branch);
    expect(operation.sourceWorktreeId).toBe(screen.sourceWorktreeId);
    expect(operation.command.type).toBe("session.fork");
    expect(operation.command.payload.title).toBe(operation.title);
    expect(operation.command.payload.copyDirty).toBe(true);
    expect(operation.command.payload.sourceWorktreeId).toBe(screen.sourceWorktreeId);
    // Base + harness are omitted so the observer pins the base and inherits the harness.
    expect(operation.command.payload.base).toBeUndefined();
    expect(operation.command.payload.harness).toBeUndefined();
  });

  it("toggles copy-dirty off and reflects it in the submitted command", () => {
    const toggled = drive(openDetails(), [DOWN, type(" ")]);
    expect(detailsScreen(toggled).copyDirty).toBe(false);
    expect(detailsScreen(toggled).focus).toBe("copyDirty");

    const transition = step(toggled, ENTER);
    const operation = transition.operations?.[0];
    if (operation?.type !== "forkSession") throw new Error("expected fork operation");
    expect(operation.command.payload.copyDirty).toBe(false);
  });

  it("allows a custom title without changing the hidden branch", () => {
    const opened = openDetails();
    const branch = detailsScreen(opened).branch;
    const edited = drive(clearTitle(opened), "Hexagonal PT 12!".split("").map(type));
    const transition = step(edited, ENTER);
    const operation = transition.operations?.[0];
    if (operation?.type !== "forkSession") throw new Error("expected fork operation");
    expect(operation.title).toBe("Hexagonal PT 12!");
    expect(operation.branch).toBe(branch);
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
    const collided: TuiState = {
      ...opened,
      snapshot: {
        ...snapshot,
        rows: [...snapshot.rows, { ...sourceRow, id: "wt_web_late_fork", branch: screen.branch }],
      },
    };

    const transition = step(collided, ENTER);
    const operation = transition.operations?.[0];
    if (operation?.type !== "forkSession") throw new Error("expected fork operation");
    expect(operation.title).toBe(screen.draftTitle.value);
    expect(operation.branch).toBe(`${screen.branch}-2`);
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
    if (operation?.type !== "forkSession") throw new Error("expected fork operation");
    expect(operation.branch).toBe(initial.branch);
  });

  it("escapes from details back to chooseSlot, then to the dashboard", () => {
    const backToChoose = step(openDetails(), ESC).state;
    expect(backToChoose.screen).toEqual({ name: "fork", step: "chooseSlot" });
    const backToDashboard = step(backToChoose, ESC).state;
    expect(backToDashboard.screen).toEqual({ name: "dashboard" });
  });
});
