import type { StationSnapshot } from "@station/contracts";
import type { DashboardFocus, ProjectHeaderControl, TuiState } from "@station/dashboard-core";
import {
  clearDashboardFocus,
  createInitialTuiState,
  createTuiStore,
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

  it("clears synchronized session focus when search or collapse hides it", () => {
    const searched = state({ searchQuery: "cache-refactor", scrollOffset: 2 });
    expect("dashboardFocus" in focusDashboardSession(searched, "ses_wt_api_working")).toBe(false);

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
    const store = createTuiStore({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      initialState: { terminalRows: 12 },
    });
    store.getState().focusDashboardSession("ses_wt_web_attention");
    store.getState().handleKey(DOWN);
    expect(store.getState().dashboardFocus).toEqual(session("ses_wt_web_exited"));
    store.getState().clearDashboardFocus();
    expect("dashboardFocus" in store.getState()).toBe(false);
    expect(typeof store.getState().handleKey).toBe("function");
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
    const row = handleTuiKey(shell, DOWN).state;
    expect(handleTuiKey(row, LEFT).state).toBe(row);
    expect(handleTuiKey(row, RIGHT).state).toBe(row);
    expect(handleTuiKey(row, UP).state.dashboardFocus).toEqual(header("web", "primary"));
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

  it("keeps empty projects focusable only through their headers", () => {
    const empty = createInitialTuiState({
      initialSnapshot: createZeroWorktreeSnapshot(),
      terminalRows: 40,
    });
    const web = handleTuiKey(empty, DOWN).state;
    const api = handleTuiKey(web, DOWN).state;
    expect(web.dashboardFocus).toEqual(header("web", "primary"));
    expect(api.dashboardFocus).toEqual(header("api", "primary"));
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
    expect(handleTuiKey(focused, RETURN).commands).toEqual([
      { type: "terminal.focus", payload: { sessionId: "ses_wt_web_working" } },
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
    expect(transition.commands).toBeUndefined();
    expect(transition.operations).toBeUndefined();
  });

  it("reconciles an accepted search at the old visual position", () => {
    let current = state({
      terminalRows: 40,
      dashboardFocus: session("ses_wt_web_idle"),
    });
    current = handleTuiKey(current, { input: "/" }).state;
    current = handleTuiKey(current, { input: "queue-worker" }).state;
    current = handleTuiKey(current, RETURN).state;

    expect(current.searchQuery).toBe("queue-worker");
    expect(current.dashboardFocus).toEqual(session("ses_wt_api_working"));
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
    const store = createTuiStore({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      initialState: {
        terminalRows: 40,
        dashboardFocus: header("api", "defaultAgent"),
      },
    });
    store.getState().setTerminalRows(12);
    expect(store.getState().dashboardFocus).toEqual(header("api", "defaultAgent"));
    expect(store.getState().scrollOffset).toBe(4);
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
