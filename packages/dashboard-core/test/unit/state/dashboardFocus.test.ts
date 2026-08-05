import type { StationSnapshot } from "@station/contracts";
import type { DashboardFocus, ProjectHeaderControl, TuiState } from "@station/dashboard-core";
import {
  clearDashboardFocus,
  createInitialTuiState,
  focusDashboardEmptyProjectAction,
  focusDashboardSession,
  handleTuiKey,
  replaceSnapshot,
  selectDashboardItems,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import {
  createCommandSnapshot,
  createDashboardSnapshot,
  createZeroWorktreeSnapshot,
} from "../../fixtures/snapshots.js";
import { createTestDashboardRuntime } from "../../support/fakeClientStateSource.js";
import { FakeTuiObserverService } from "../../support/fakeObserverService.js";

const DOWN = { input: "", downArrow: true } as const;
const UP = { input: "", upArrow: true } as const;
const LEFT = { input: "", leftArrow: true } as const;
const RIGHT = { input: "", rightArrow: true } as const;
const NEXT_NEEDS_ME = { input: "i", ctrl: true } as const;
const RETURN = { input: "\r", return: true } as const;

function state(options: Partial<Parameters<typeof createInitialTuiState>[0]> = {}): TuiState {
  return createInitialTuiState({ initialSnapshot: createDashboardSnapshot(), ...options });
}

function session(sessionId: string): DashboardFocus {
  return { kind: "session", sessionId };
}

function header(projectId: string, control: ProjectHeaderControl): DashboardFocus {
  return { kind: "projectHeader", projectId, control };
}

function emptyAction(projectId: string): DashboardFocus {
  return { kind: "emptyProjectAction", projectId };
}

describe("dashboard focus", () => {
  it("focuses a canonical session identity and minimally scrolls it into view", () => {
    const initial = state({ terminalRows: 12, scrollOffset: 0 });
    const focused = focusDashboardSession(initial, "ses_wt_api_working");

    expect(focused.dashboardFocus).toEqual(session("ses_wt_api_working"));
    expect(focused.scrollOffset).toBe(5);
  });

  it.each([
    ["non-session worktree id", (snapshot: StationSnapshot) => snapshot, "wt_api_working"],
    [
      "stale session row",
      (snapshot: StationSnapshot) => ({
        ...snapshot,
        rows: snapshot.rows.filter((row) => row.id !== "wt_api_working"),
      }),
      "ses_wt_api_working",
    ],
  ])("clears focus for a %s without moving the viewport", (_label, update, sessionId) => {
    const initial: TuiState = {
      ...state(),
      dashboardFocus: session("ses_wt_web_attention"),
      scrollOffset: 3,
    };
    const focused = focusDashboardSession(
      { ...initial, snapshot: update(initial.snapshot as StationSnapshot) },
      sessionId,
    );

    expect("dashboardFocus" in focused).toBe(false);
    expect(focused.scrollOffset).toBe(3);
  });

  it("clears synchronized session focus when collapse hides it", () => {
    const collapsed = state({ collapsedProjectIds: ["api"], scrollOffset: 2 });
    expect("dashboardFocus" in focusDashboardSession(collapsed, "ses_wt_api_working")).toBe(false);
  });

  it("clears focus without changing the viewport and preserves store methods", () => {
    const initial: TuiState = {
      ...state(),
      dashboardFocus: session("ses_wt_web_attention"),
      scrollOffset: 2,
    };
    const cleared = clearDashboardFocus(initial);
    expect("dashboardFocus" in cleared).toBe(false);
    expect(cleared.scrollOffset).toBe(2);

    const snapshot = createDashboardSnapshot();
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      initialState: { terminalRows: 12 },
    });
    store.actions.focusDashboardSession("ses_wt_web_attention");
    store.actions.handleKey(DOWN);
    expect(store.state.getState().dashboardFocus).toEqual(session("ses_wt_web_exited"));
    store.actions.clearDashboardFocus();
    expect("dashboardFocus" in store.state.getState()).toBe(false);
    expect(typeof store.actions.handleKey).toBe("function");
  });

  it("walks headers and sessions in rendered vertical order", () => {
    const expected: DashboardFocus[] = [
      header("web", "primary"),
      session("ses_wt_web_working"),
      session("ses_wt_web_attention"),
      session("ses_wt_web_exited"),
      session("ses_wt_web_idle"),
      session("ses_wt_web_unknown"),
      session("ses_wt_web_stuck"),
      header("api", "primary"),
      session("ses_wt_api_working"),
    ];
    let current = state({ terminalRows: 40 });
    for (const focus of expected) {
      current = handleTuiKey(current, DOWN).state;
      expect(current.dashboardFocus).toEqual(focus);
    }
    expect(handleTuiKey(current, DOWN).state.dashboardFocus).toEqual(expected.at(-1));

    for (const focus of [...expected].reverse().slice(1)) {
      current = handleTuiKey(current, UP).state;
      expect(current.dashboardFocus).toEqual(focus);
    }
    expect(handleTuiKey(current, UP).state.dashboardFocus).toEqual(expected[0]);
  });

  it("enters on the first or last focusable item inside the viewport", () => {
    const down = handleTuiKey(state({ terminalRows: 12, scrollOffset: 2 }), DOWN).state;
    expect(down.dashboardFocus).toEqual(session("ses_wt_web_attention"));

    const up = handleTuiKey(state({ terminalRows: 12 }), UP).state;
    expect(up.dashboardFocus).toEqual(session("ses_wt_web_idle"));
  });

  it("traverses all four header controls horizontally and clamps", () => {
    const controls = ["primary", "shell", "quickSession", "defaultAgent"] as const;
    let current = handleTuiKey(state(), DOWN).state;
    for (const control of controls.slice(1)) {
      current = handleTuiKey(current, RIGHT).state;
      expect(current.dashboardFocus).toEqual(header("web", control));
    }
    expect(handleTuiKey(current, RIGHT).state).toBe(current);

    for (const control of [...controls].reverse().slice(1)) {
      current = handleTuiKey(current, LEFT).state;
      expect(current.dashboardFocus).toEqual(header("web", control));
    }
    expect(handleTuiKey(current, LEFT).state).toBe(current);
  });

  it("leaves session Left/Right inert and resets headers to primary on vertical entry", () => {
    const primary = handleTuiKey(state(), DOWN).state;
    const shell = handleTuiKey(primary, RIGHT).state;
    expect(handleTuiKey(shell, UP).state).toBe(shell);

    const row = handleTuiKey(shell, DOWN).state;
    expect(handleTuiKey(row, LEFT).state).toBe(row);
    expect(handleTuiKey(row, RIGHT).state).toBe(row);
    expect(handleTuiKey(row, UP).state.dashboardFocus).toEqual(header("web", "primary"));

    const apiShell = state({ dashboardFocus: header("api", "shell") });
    expect(handleTuiKey(apiShell, UP).state.dashboardFocus).toEqual(session("ses_wt_web_stuck"));
  });

  it("skips hidden sessions after collapse and re-enters them after expansion", () => {
    let current = handleTuiKey(state({ terminalRows: 40 }), DOWN).state;
    current = handleTuiKey(current, RETURN).state;
    expect(current.collapsedProjectIds).toEqual(new Set(["web"]));
    expect(current.dashboardFocus).toEqual(header("web", "primary"));
    expect(handleTuiKey(current, DOWN).state.dashboardFocus).toEqual(header("api", "primary"));

    current = handleTuiKey(current, RETURN).state;
    expect(current.collapsedProjectIds).toEqual(new Set());
    expect(handleTuiKey(current, DOWN).state.dashboardFocus).toEqual(session("ses_wt_web_working"));
  });

  it("moves focused sessions to their primary header when C collapses the project", () => {
    const focused = state({ dashboardFocus: session("ses_wt_web_idle") });
    const picker = handleTuiKey(focused, { input: "C" }).state;
    const collapsed = handleTuiKey(picker, { input: "1" }).state;

    expect(collapsed.collapsedProjectIds).toEqual(new Set(["web"]));
    expect(collapsed.dashboardFocus).toEqual(header("web", "primary"));
  });

  it("walks empty-project actions between their headers in rendered order", () => {
    let current = createInitialTuiState({
      initialSnapshot: createZeroWorktreeSnapshot(),
      terminalRows: 40,
    });
    for (const focus of [
      header("web", "primary"),
      emptyAction("web"),
      header("api", "primary"),
      emptyAction("api"),
    ]) {
      current = handleTuiKey(current, DOWN).state;
      expect(current.dashboardFocus).toEqual(focus);
    }
  });

  it("focuses a stable empty-project action and leaves horizontal movement inert", () => {
    const initial = createInitialTuiState({
      initialSnapshot: createZeroWorktreeSnapshot(),
      terminalRows: 40,
    });
    const focused = focusDashboardEmptyProjectAction(initial, "api");

    expect(focused.dashboardFocus).toEqual(emptyAction("api"));
    expect(handleTuiKey(focused, LEFT).state).toBe(focused);
    expect(handleTuiKey(focused, RIGHT).state).toBe(focused);
  });

  it("enters and scrolls empty-project focus from the current viewport", () => {
    const base = createInitialTuiState({
      initialSnapshot: createZeroWorktreeSnapshot(),
      terminalRows: 10,
      scrollOffset: 2,
    });
    expect(handleTuiKey(base, DOWN).state.dashboardFocus).toEqual(header("api", "primary"));
    expect(handleTuiKey(base, UP).state.dashboardFocus).toEqual(emptyAction("api"));

    let current = createInitialTuiState({
      initialSnapshot: createZeroWorktreeSnapshot(),
      terminalRows: 10,
    });
    for (let presses = 0; presses < 4; presses += 1) {
      current = handleTuiKey(current, DOWN).state;
    }
    expect(current.dashboardFocus).toEqual(emptyAction("api"));
    expect(current.scrollOffset).toBe(2);
  });

  it("moves a collapsed empty action to primary and returns to it after expansion", () => {
    const focused = focusDashboardEmptyProjectAction(
      createInitialTuiState({
        initialSnapshot: createZeroWorktreeSnapshot(),
        terminalRows: 40,
      }),
      "web",
    );
    const collapsed = handleTuiKey(handleTuiKey(focused, { input: "C" }).state, {
      input: "1",
    }).state;
    expect(collapsed.dashboardFocus).toEqual(header("web", "primary"));

    const expanded = handleTuiKey(handleTuiKey(collapsed, { input: "C" }).state, {
      input: "1",
    }).state;
    expect(handleTuiKey(expanded, DOWN).state.dashboardFocus).toEqual(emptyAction("web"));
  });

  it("preserves empty-action identity through an accepted filter and resize", () => {
    let current = focusDashboardEmptyProjectAction(
      createInitialTuiState({
        initialSnapshot: createZeroWorktreeSnapshot(),
        terminalRows: 40,
      }),
      "api",
    );
    current = handleTuiKey(current, { input: "/" }).state;
    current = handleTuiKey(current, { input: "api" }).state;
    current = handleTuiKey(current, RETURN).state;
    expect(current.persistentFilter).toEqual({ query: "api" });
    expect(current.dashboardFocus).toEqual(emptyAction("api"));

    const snapshot = createZeroWorktreeSnapshot();
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      initialState: {
        terminalRows: 40,
        dashboardFocus: emptyAction("api"),
      },
    });
    store.actions.setTerminalRows(10);
    expect(store.state.getState().dashboardFocus).toEqual(emptyAction("api"));
    expect(store.state.getState().scrollOffset).toBe(2);
  });

  it("reconciles removed empty actions by their old rendered position", () => {
    const snapshot = createZeroWorktreeSnapshot();
    const initial = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: 40,
      dashboardFocus: emptyAction("web"),
    });
    const withoutWeb: StationSnapshot = {
      ...snapshot,
      projects: snapshot.projects.filter((project) => project.id !== "web"),
      counts: { ...snapshot.counts, projects: 1 },
    };

    expect(replaceSnapshot(initial, withoutWeb).dashboardFocus).toEqual(emptyAction("api"));
  });

  it("keeps session-only traversal away from empty actions", () => {
    const snapshot = createDashboardSnapshot();
    const withoutApiSessions: StationSnapshot = {
      ...snapshot,
      rows: snapshot.rows.filter((row) => row.projectId !== "api"),
      sessions: snapshot.sessions.filter((candidate) => candidate.projectId !== "api"),
    };
    const focused = createInitialTuiState({
      initialSnapshot: withoutApiSessions,
      terminalRows: 40,
      dashboardFocus: emptyAction("api"),
    });

    expect(handleTuiKey(focused, NEXT_NEEDS_ME).state.dashboardFocus).toEqual(
      session("ses_wt_web_attention"),
    );
    const choosing = handleTuiKey(focused, { input: "X" }).state;
    expect(handleTuiKey(choosing, DOWN).state.dashboardFocus?.kind).toBe("session");
    expect(handleTuiKey(focused, { input: "N" }).state.dashboardFocus).toEqual(emptyAction("api"));
  });

  it("scrolls to keep project-header and session focus visible", () => {
    let current = state({ terminalRows: 12 });
    for (let presses = 0; presses < 8; presses += 1) {
      current = handleTuiKey(current, DOWN).state;
    }
    expect(current.dashboardFocus).toEqual(header("api", "primary"));
    expect(current.scrollOffset).toBe(4);
  });

  it("jumps next-needs-me through sessions only and wraps", () => {
    const first = handleTuiKey(state({ terminalRows: 12 }), NEXT_NEEDS_ME).state;
    expect(first.dashboardFocus).toEqual(session("ses_wt_web_attention"));
    const second = handleTuiKey(first, NEXT_NEEDS_ME).state;
    expect(second.dashboardFocus).toEqual(session("ses_wt_web_stuck"));
    expect(handleTuiKey(second, NEXT_NEEDS_ME).state.dashboardFocus).toEqual(
      session("ses_wt_web_attention"),
    );
  });

  it("activates focused sessions and leaves missing focus inert", () => {
    const focused = state({ dashboardFocus: session("ses_wt_web_working") });
    expect(handleTuiKey(focused, RETURN).operations).toEqual([
      expect.objectContaining({
        type: "activateSession",
        sessionId: "ses_wt_web_working",
        preferredObserverAction: "focus",
      }),
    ]);
    const initial = state();
    expect(handleTuiKey(initial, RETURN).state).toBe(initial);
  });

  it("does not activate a focused row whose start is pending", () => {
    const snapshot = createCommandSnapshot("none");
    const initial = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: session("ses_wt_web_no_agent"),
    });
    expect(selectDashboardItems(snapshot, initial).some((item) => item.type === "session")).toBe(
      true,
    );
    const pending: TuiState = {
      ...initial,
      localRows: {
        ...initial.localRows,
        pendingStart: [
          {
            localId: "start:wt_web_no_agent",
            projectId: "web",
            worktreeId: "wt_web_no_agent",
            branch: "feature-auth",
            operation: "startAgent",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
      },
    };
    const transition = handleTuiKey(pending, RETURN);
    expect(transition.operations).toBeUndefined();
  });

  it("reconciles an accepted filter at the old visual position", () => {
    let current = state({
      terminalRows: 40,
      dashboardFocus: session("ses_wt_web_idle"),
    });
    current = handleTuiKey(current, { input: "/" }).state;
    current = handleTuiKey(current, { input: "queue-worker" }).state;
    current = handleTuiKey(current, RETURN).state;

    expect(current.persistentFilter).toEqual({ query: "queue-worker" });
    expect(current.dashboardFocus).toEqual(session("ses_wt_api_working"));
  });

  it("keeps soft preview stable, then hard-projects apply with forward/backward focus fallback", () => {
    const initial = state({
      terminalRows: 10,
      scrollOffset: 3,
      dashboardFocus: session("ses_wt_web_idle"),
    });
    const snapshot = initial.snapshot as StationSnapshot;
    const initialIds = selectDashboardItems(snapshot, initial).map((item) => item.id);
    const opened = handleTuiKey(initial, { input: "/" }).state;
    const preview = handleTuiKey(opened, { input: "queue-worker" }).state;
    const applied = handleTuiKey(preview, RETURN).state;

    expect(selectDashboardItems(snapshot, preview, preview.screen).map((item) => item.id)).toEqual(
      initialIds,
    );
    expect(selectDashboardItems(snapshot, applied, applied.screen).map((item) => item.id)).toEqual([
      "project:api",
      "session:ses_wt_api_working",
    ]);
    expect(preview.dashboardFocus).toEqual(initial.dashboardFocus);
    expect(applied.dashboardFocus).toEqual(session("ses_wt_api_working"));
    expect(applied.scrollOffset).toBe(0);
  });

  it("preserves collapsed project-header focus when clearing an applied filter", () => {
    const filtered = state({
      terminalRows: 10,
      collapsedProjectIds: ["web"],
      persistentFilter: { query: "fix-nav-mobile" },
      dashboardFocus: header("web", "primary"),
    });

    const cleared = handleTuiKey(filtered, { input: "", escape: true }).state;

    expect(cleared.collapsedProjectIds).toEqual(new Set(["web"]));
    expect(cleared.dashboardFocus).toEqual(header("web", "primary"));
    expect(selectDashboardItems(cleared.snapshot as StationSnapshot, cleared)).not.toContainEqual(
      expect.objectContaining({ type: "session", row: { id: "ses_wt_web_idle" } }),
    );
  });

  it("keeps a focused header when the accepted filter retains its project", () => {
    let current = state({
      terminalRows: 40,
      dashboardFocus: header("web", "shell"),
    });
    current = handleTuiKey(current, { input: "/" }).state;
    current = handleTuiKey(current, { input: "web" }).state;
    current = handleTuiKey(current, RETURN).state;

    expect(current.persistentFilter).toEqual({ query: "web" });
    expect(current.dashboardFocus).toEqual(header("web", "shell"));
  });

  it("preserves stable identity through snapshot replacement and resize", () => {
    const initial = state({
      dashboardFocus: header("api", "defaultAgent"),
    });
    const refreshed = replaceSnapshot(initial, {
      ...(initial.snapshot as StationSnapshot),
      generatedAt: "2026-05-20T12:01:00.000Z",
    });
    expect(refreshed.dashboardFocus).toEqual(header("api", "defaultAgent"));

    const snapshot = createDashboardSnapshot();
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      initialState: {
        terminalRows: 40,
        dashboardFocus: header("api", "defaultAgent"),
      },
    });
    store.actions.setTerminalRows(12);
    expect(store.state.getState().dashboardFocus).toEqual(header("api", "defaultAgent"));
    expect(store.state.getState().scrollOffset).toBe(4);
  });

  it("falls forward then backward when snapshot replacement removes focused identity", () => {
    const initial = state({
      terminalRows: 40,
      dashboardFocus: header("web", "shell"),
    });
    const snapshot = initial.snapshot as StationSnapshot;
    const withoutWeb: StationSnapshot = {
      ...snapshot,
      projects: snapshot.projects.filter((project) => project.id !== "web"),
      rows: snapshot.rows.filter((row) => row.projectId !== "web"),
      sessions: snapshot.sessions.filter((candidate) => candidate.projectId !== "web"),
    };
    expect(replaceSnapshot(initial, withoutWeb).dashboardFocus).toEqual(header("api", "primary"));

    const apiFocused = state({
      terminalRows: 40,
      dashboardFocus: header("api", "shell"),
    });
    const withoutApi: StationSnapshot = {
      ...snapshot,
      projects: snapshot.projects.filter((project) => project.id !== "api"),
      rows: snapshot.rows.filter((row) => row.projectId !== "api"),
      sessions: snapshot.sessions.filter((candidate) => candidate.projectId !== "api"),
    };
    expect(replaceSnapshot(apiFocused, withoutApi).dashboardFocus).toEqual(
      session("ses_wt_web_stuck"),
    );
  });
});
