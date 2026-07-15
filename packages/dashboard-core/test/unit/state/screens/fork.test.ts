import type { StationSnapshot } from "@station/contracts";
import type { TuiKey, TuiState, TuiTransition } from "@station/dashboard-core";
import {
  createInitialTuiState,
  handleTuiKey,
  openForkDetailsForRow,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot, row } from "../../../fixtures/snapshots.js";

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

function openDetails(): TuiState {
  return drive(base(), [type("F"), type("1")]);
}

function clearBranch(state: TuiState): TuiState {
  let current = state;
  while (
    current.screen.name === "fork" &&
    current.screen.step === "details" &&
    current.screen.draftBranch.value.length > 0
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

  it("opens details for a chosen row with a suggested -fork branch and copy on", () => {
    const screen = detailsScreen(openDetails());
    expect(screen.draftBranch.value).toBe(`${screen.sourceBranch}-fork`);
    expect(screen.copyDirty).toBe(true);
    expect(screen.focus).toBe("branch");
    expect(screen.nameSource).toBe("generated");
    expect(screen.sourceWorktreeId.length).toBeGreaterThan(0);
  });

  it("submits a session.fork operation with the suggested branch and copyDirty", () => {
    const opened = openDetails();
    const screen = detailsScreen(opened);
    const transition = step(opened, ENTER);

    expect(transition.state.screen).toEqual({ name: "dashboard" });
    expect(transition.operations).toHaveLength(1);
    const operation = transition.operations?.[0];
    expect(operation?.type).toBe("forkSession");
    if (operation?.type !== "forkSession") throw new Error("unreachable");
    expect(operation.branch).toBe(`${screen.sourceBranch}-fork`);
    expect(operation.sourceWorktreeId).toBe(screen.sourceWorktreeId);
    expect(operation.command.type).toBe("session.fork");
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

  it("marks the branch as edited and updates the draft when typing", () => {
    const edited = drive(openDetails(), [type("x")]);
    const screen = detailsScreen(edited);
    expect(screen.nameSource).toBe("edited");
    expect(screen.draftBranch.value).toContain("x");
    expect(screen.focus).toBe("branch");
  });

  it("rejects an empty branch without dispatching an operation", () => {
    const cleared = clearBranch(openDetails());
    const transition = step(cleared, ENTER);
    expect(transition.operations).toBeUndefined();
    expect(detailsScreen(transition.state).validationError).toBeDefined();
  });

  it("rejects a branch that collides with an existing worktree", () => {
    const cleared = clearBranch(openDetails());
    const existing = base().snapshot?.rows[0]?.branch ?? "";
    const typed = drive(cleared, existing.split("").map(type));
    const transition = step(typed, ENTER);
    expect(transition.operations).toBeUndefined();
    expect(detailsScreen(transition.state).validationError).toContain(existing);
  });

  it("scopes branch collisions and suggestions to the source project", () => {
    // A DIFFERENT project already holds the name this web fork would suggest.
    // Branch uniqueness is per repo, so it must neither bump the suggestion nor
    // block the submit. (wt_web_idle is on "fix-nav-mobile" → suggests "-fork".)
    const base = createDashboardSnapshot();
    const snapshot: StationSnapshot = {
      ...base,
      rows: [
        ...base.rows,
        row({ id: "wt_api_fork", projectId: "api", branch: "fix-nav-mobile-fork", state: "idle" }),
      ],
    };
    const opened = openForkDetailsForRow(
      createInitialTuiState({ initialSnapshot: snapshot }),
      "ses_wt_web_idle",
    );
    const screen = detailsScreen(opened);
    expect(screen.draftBranch.value).toBe("fix-nav-mobile-fork");

    const transition = step(opened, ENTER);
    expect(transition.operations).toHaveLength(1);
    const operation = transition.operations?.[0];
    if (operation?.type !== "forkSession") throw new Error("expected fork operation");
    expect(operation.branch).toBe("fix-nav-mobile-fork");
  });

  it("escapes from details back to chooseSlot, then to the dashboard", () => {
    const backToChoose = step(openDetails(), ESC).state;
    expect(backToChoose.screen).toEqual({ name: "fork", step: "chooseSlot" });
    const backToDashboard = step(backToChoose, ESC).state;
    expect(backToDashboard.screen).toEqual({ name: "dashboard" });
  });
});
