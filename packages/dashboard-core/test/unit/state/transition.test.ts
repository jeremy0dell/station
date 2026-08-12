import { describe, expect, it } from "vitest";
import { dashboardRowIds } from "../../../src/selectors/dashboardTree.js";
import { selectDashboardViewport } from "../../../src/selectors/dashboardViewport.js";
import { deriveTuiInputMode } from "../../../src/state/keymap.js";
import type { TuiKey } from "../../../src/state/keys.js";
import { createInitialTuiState, replaceSnapshot } from "../../../src/state/screen.js";
import { tuiScreenBehavior } from "../../../src/state/screenBehavior.js";
import { openProjectDefaultAgentPicker } from "../../../src/state/screens/projectDefaultAgent.js";
import { openRenameEditForRow } from "../../../src/state/screens/sessionRows.js";
import { addTuiToast } from "../../../src/state/toasts.js";
import { handleTuiKey } from "../../../src/state/transition.js";
import {
  createCommandSnapshot,
  createDashboardSnapshot,
  createExternalAgentSnapshot,
  createGroupedDashboardSnapshot,
  createZeroWorktreeSnapshot,
} from "../../fixtures/snapshots.js";

describe("TUI screen transitions", () => {
  it("dismisses a visible error with Esc before the dashboard popup", () => {
    const state = addTuiToast(
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      { kind: "error", message: "Worktree remove failed." },
      1_000,
    );

    const dismissedError = handleTuiKey(state, { input: "", escape: true });
    expect(dismissedError.state.toasts).toEqual([]);
    expect(dismissedError.operations).toBeUndefined();

    const dismissedPopup = handleTuiKey(dismissedError.state, { input: "", escape: true });
    expect(dismissedPopup.operations).toEqual([{ type: "dismissDashboard" }]);

    const closedImmediately = handleTuiKey(state, { input: "Q" });
    expect(closedImmediately.operations).toEqual([{ type: "exitDashboardRenderer", exitCode: 0 }]);
    expect(closedImmediately.state.toasts).toHaveLength(1);
  });

  it("clears an applied persistent filter before Esc dismisses the dashboard popup", () => {
    const state = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      persistentFilter: { query: "working" },
    });

    const cleared = handleTuiKey(state, { input: "", escape: true });
    expect("persistentFilter" in cleared.state).toBe(false);
    expect(cleared.operations).toBeUndefined();

    const dismissed = handleTuiKey(cleared.state, { input: "", escape: true });
    expect(dismissed.operations).toEqual([{ type: "dismissDashboard" }]);
  });

  it("retains applied dashboard-local filter state when Q closes", () => {
    const state = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      persistentFilter: { query: "working" },
    });

    const closed = handleTuiKey(state, { input: "Q" });

    expect(closed.operations).toEqual([{ type: "exitDashboardRenderer", exitCode: 0 }]);
    expect(closed.state.persistentFilter).toEqual({ query: "working" });
  });

  it("does not let a hidden error intercept Esc from an open modal", () => {
    const state = addTuiToast(
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      { kind: "error", message: "Worktree remove failed." },
      1_000,
    );
    const help = handleTuiKey(state, { input: "H" }).state;

    const closedHelp = handleTuiKey(help, { input: "", escape: true });
    expect(closedHelp.state.screen).toEqual({ name: "dashboard" });
    expect(closedHelp.state.toasts).toHaveLength(1);

    const dismissedError = handleTuiKey(closedHelp.state, { input: "", escape: true });
    expect(dismissedError.state.toasts).toEqual([]);
  });

  it("opens remove session slot selection from the dashboard", () => {
    const state = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
    const transition = handleTuiKey(state, { input: "X" });

    expect(transition.state.screen).toEqual({ name: "removeWorktree", step: "chooseSlot" });
  });

  it("opens rename slot selection from the dashboard and keeps refresh on Z", () => {
    const state = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
    const rename = handleTuiKey(state, { input: "R" });
    const refresh = handleTuiKey(state, { input: "Z" });

    expect(rename.state.screen).toEqual({ name: "renameSession", step: "chooseSlot" });
    expect(refresh.reconcileReason).toBe("tui-refresh");
  });

  it("moves a cursor with arrows and commits the focused row on enter in remove-choose", () => {
    const base = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
    const opened = handleTuiKey(base, { input: "X" }).state;
    expect(opened.screen).toEqual({ name: "removeWorktree", step: "chooseSlot" });

    // Arrows now move the dashboard cursor (was: scroll the viewport).
    const moved = handleTuiKey(opened, { input: "", downArrow: true }).state;
    expect(moved.dashboardFocus).toBeDefined();

    const committed = handleTuiKey(moved, { input: "\r", return: true }).state;
    expect(committed.screen).toMatchObject({ name: "removeWorktree", step: "confirm" });
  });

  it("does not commit a pending-remove focused row on enter in the choose-row trio", () => {
    const base = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
    const withPending: typeof base = {
      ...base,
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_api_working"),
        cellId: "identity",
      },
      localRows: {
        ...base.localRows,
        pendingRemove: [
          {
            localId: "rm:wt_api_working",
            projectId: "api",
            worktreeId: "wt_api_working",
            branch: "queue-worker",
            createdAt: "2026-07-04T00:00:00.000Z",
          },
        ],
      },
    };
    const opened = handleTuiKey(withPending, { input: "X" }).state;
    const committed = handleTuiKey(opened, { input: "\r", return: true }).state;
    // ↵ is inert on a mid-removal row, exactly as the slot path and dashboard activation refuse it.
    expect(committed.screen).toEqual({ name: "removeWorktree", step: "chooseSlot" });
  });

  it("does not commit a collapsed (hidden) focused row on enter in the choose-row trio", () => {
    const base = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      collapsedProjectIds: ["api"],
    });
    const state: typeof base = {
      ...base,
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_api_working"),
        cellId: "identity",
      },
    };
    const opened = handleTuiKey(state, { input: "X" }).state;
    const committed = handleTuiKey(opened, { input: "\r", return: true }).state;
    // The row is filtered out of view; ↵ must not act on a row the user cannot see.
    expect(committed.screen).toEqual({ name: "removeWorktree", step: "chooseSlot" });
  });

  it("scrolls dashboard rows with mouse wheel events", () => {
    const state = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      terminalRows: 10,
    });

    const wheelDown = handleTuiKey(state, { input: "", mouseScroll: "down" });
    const wheelDownAgain = handleTuiKey(wheelDown.state, { input: "", mouseScroll: "down" });
    const wheelUp = handleTuiKey(wheelDownAgain.state, { input: "", mouseScroll: "up" });

    expect(wheelDown.state.scrollOffset).toBe(1);
    expect(wheelDownAgain.state.scrollOffset).toBe(2);
    expect(wheelUp.state.scrollOffset).toBe(1);
  });

  it("clamps dashboard scrolling at the top and bottom", () => {
    const state = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      scrollOffset: 8,
      terminalRows: 10,
    });

    expect(handleTuiKey(state, { input: "", mouseScroll: "down" }).state.scrollOffset).toBe(7);
    expect(
      handleTuiKey({ ...state, scrollOffset: 0 }, { input: "", mouseScroll: "up" }).state
        .scrollOffset,
    ).toBe(0);
  });

  it("starts an agent from a no-agent dashboard slot as a local operation", () => {
    const transition = handleTuiKey(
      createInitialTuiState({ initialSnapshot: createCommandSnapshot("none") }),
      { input: "1" },
    );

    expect(transition.state.localRows.pendingStart).toEqual([]);
    expect(transition.operations).toEqual([
      {
        type: "activateSession",
        sessionId: "ses_wt_web_no_agent",
        localId: "start:wt_web_no_agent",
        preferredObserverAction: "start",
        projectId: "web",
        worktreeId: "wt_web_no_agent",
        branch: "feature-start",
      },
    ]);
  });

  it("resumes a recoverable dashboard slot as a local operation", () => {
    const snapshot = createCommandSnapshot("none");
    const row = {
      ...snapshot.rows[0],
      recovery: {
        kind: "agent-resume" as const,
        handleId: "rec_codex_123",
        provider: "codex",
        targetKind: "native-session" as const,
        sessionId: "ses_wt_web_no_agent",
        lastSeenAt: "2026-06-01T12:00:00.000Z",
      },
    };
    const transition = handleTuiKey(
      createInitialTuiState({ initialSnapshot: { ...snapshot, rows: [row] } }),
      { input: "1" },
    );

    expect(transition.state.localRows.pendingStart).toEqual([]);
    expect(transition.operations).toEqual([
      expect.objectContaining({
        type: "activateSession",
        localId: "resume:wt_web_no_agent",
        preferredObserverAction: "resume",
        projectId: "web",
        worktreeId: "wt_web_no_agent",
      }),
    ]);
  });

  it("keeps agent-backed dashboard slots on the focus command path", () => {
    const transition = handleTuiKey(
      createInitialTuiState({ initialSnapshot: createCommandSnapshot("idle") }),
      { input: "1" },
    );

    expect(transition.operations).toEqual([
      expect.objectContaining({
        type: "activateSession",
        sessionId: "ses_wt_web_idle",
        preferredObserverAction: "focus",
      }),
    ]);
    expect(transition.state.localRows.pendingStart).toEqual([]);
  });

  it("focuses the exact external session when a checkout has mixed membership", () => {
    const external = createExternalAgentSnapshot();
    const retained = createDashboardSnapshot().sessions.find(
      (session) => session.worktreeId === "wt_web_idle",
    );
    const externalSession = external.sessions.find(
      (session) => session.worktreeId === "wt_web_idle",
    );
    if (retained === undefined || externalSession === undefined) {
      throw new Error("missing mixed-membership fixture sessions");
    }
    const focusableExternal = {
      ...externalSession,
      terminal: {
        provider: "tmux",
        state: "open" as const,
        focusable: true,
        closeable: true,
      },
    };
    const snapshot = {
      ...external,
      sessions: [
        retained,
        ...external.sessions.map((session) =>
          session.id === externalSession.id ? focusableExternal : session,
        ),
      ],
    };
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const choice = selectDashboardViewport(snapshot, state).rowChoices.find(
      (candidate) => candidate.value.id === externalSession.id,
    );
    if (choice === undefined) throw new Error("external session must be selectable");

    const transition = handleTuiKey(state, { input: choice.key });

    expect(transition.operations).toEqual([
      expect.objectContaining({
        type: "activateSession",
        sessionId: externalSession.id,
        preferredObserverAction: "focus",
      }),
    ]);
  });

  it("delegates native non-focusable sessions to renderer activation", () => {
    const base = createCommandSnapshot("idle");
    const snapshot = {
      ...base,
      sessions: base.sessions.map((session) =>
        session.terminal === undefined
          ? session
          : {
              ...session,
              terminal: { ...session.terminal, provider: "native", focusable: false },
            },
      ),
    };
    const transition = handleTuiKey(createInitialTuiState({ initialSnapshot: snapshot }), {
      input: "1",
    });

    expect(transition.operations).toEqual([
      expect.objectContaining({ type: "activateSession", preferredObserverAction: "focus" }),
    ]);
    expect(transition.state.screen).toEqual({ name: "dashboard" });
    expect(transition.state.toasts).toEqual([]);
  });

  it("ignores a pending-start slot as an action while preserving dashboard state", () => {
    const snapshot = createCommandSnapshot("none");
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      localRows: {
        pendingCreate: [],
        failedCreate: [],
        pendingRemove: [],
        pendingStart: [
          {
            localId: "start:wt_web_no_agent",
            projectId: "web",
            worktreeId: "wt_web_no_agent",
            branch: "feature-start",
            createdAt: "2026-06-01T12:00:00.000Z",
          },
        ],
      },
    });

    const transition = handleTuiKey(state, { input: "1" });

    expect(transition.state).toBe(state);
    expect(transition.operations).toBeUndefined();
  });

  it("opens remove confirmation for the selected visible row slot", () => {
    const opened = handleTuiKey(
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      { input: "X" },
    );
    const transition = handleTuiKey(opened.state, { input: "4" });

    expect(transition.state.screen).toEqual({
      name: "removeWorktree",
      step: "confirm",
      rowId: "ses_wt_web_idle",
      forceRequired: true,
      label: "fix-nav-mobile",
      actionFocus: "keep",
    });
  });

  it("opens removal information without dispatching for an external unstoppable agent", () => {
    const snapshot = createExternalAgentSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const opened = handleTuiKey(handleTuiKey(state, { input: "X" }).state, { input: "4" });

    expect(opened.state.screen).toEqual({
      name: "removeWorktree",
      step: "unavailable",
    });
    expect(deriveTuiInputMode(opened.state)).toBe("removeUnavailable");

    const attempted = handleTuiKey(opened.state, { input: "y" });
    expect(attempted.state).toBe(opened.state);
    expect(attempted.operations).toBeUndefined();
    expect(attempted.state.localRows.pendingRemove).toEqual([]);

    const closed = handleTuiKey(opened.state, { input: "\r", return: true });
    expect(closed.state.screen).toEqual({ name: "dashboard" });
    expect(closed.operations).toBeUndefined();

    const escaped = handleTuiKey(opened.state, { input: "", escape: true });
    expect(escaped.state.screen).toEqual({ name: "dashboard" });
    expect(escaped.operations).toBeUndefined();
  });

  it("keeps removal confirmation when an external agent has an effective stop path", () => {
    const stoppableSnapshot = createExternalAgentSnapshot();
    const codexHealth = stoppableSnapshot.providerHealth.codex;
    if (codexHealth?.capabilities === undefined) {
      throw new Error("External-agent fixture must expose Codex capabilities.");
    }
    const withProviderStop = {
      ...stoppableSnapshot,
      providerHealth: {
        ...stoppableSnapshot.providerHealth,
        codex: {
          ...codexHealth,
          capabilities: { ...codexHealth.capabilities, canStop: true },
        },
      },
    };
    const withTerminalStop = {
      ...stoppableSnapshot,
      sessions: stoppableSnapshot.sessions.map((session) =>
        session.id === "run_wt_web_idle"
          ? {
              ...session,
              terminal: {
                provider: "tmux",
                state: "open" as const,
                closeable: true,
              },
            }
          : session,
      ),
    };

    for (const snapshot of [withProviderStop, withTerminalStop]) {
      const state = createInitialTuiState({ initialSnapshot: snapshot });
      const opened = handleTuiKey(handleTuiKey(state, { input: "X" }).state, { input: "4" });
      expect(opened.state.screen).toMatchObject({
        name: "removeWorktree",
        step: "confirm",
        rowId: "run_wt_web_idle",
      });
    }
  });

  it("confirms remove worktree with y and returns a remove operation", () => {
    const state = handleTuiKey(
      handleTuiKey(createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }), {
        input: "X",
      }).state,
      { input: "4" },
    ).state;

    const transition = handleTuiKey(state, { input: "y" });

    expect(transition.state.screen).toEqual({ name: "dashboard" });
    expect(transition.state.localRows.pendingRemove).toMatchObject([
      {
        localId: "remove:wt_web_idle",
        worktreeId: "wt_web_idle",
        branch: "fix-nav-mobile",
      },
    ]);
    expect(transition.operations).toEqual([
      expect.objectContaining({
        type: "removeWorktree",
        projectId: "web",
        worktreeId: "wt_web_idle",
        branch: "fix-nav-mobile",
        command: {
          type: "worktree.remove",
          payload: {
            projectId: "web",
            worktreeId: "wt_web_idle",
            expectedPath: "/tmp/station/web/worktrees/fix-nav-mobile",
            expectedBranch: "fix-nav-mobile",
            expectedRegistrationIdentity: "git-registration:wt_web_idle",
            force: true,
          },
        },
      }),
    ]);
  });

  it("refuses removal with an actionable toast when checkout registration is unverified", () => {
    const snapshot = createDashboardSnapshot();
    const rows = snapshot.rows.map((row) => {
      if (row.id !== "wt_web_idle") return row;
      const { registrationIdentity: _registrationIdentity, ...unverified } = row;
      return unverified;
    });
    const state = handleTuiKey(
      handleTuiKey(createInitialTuiState({ initialSnapshot: { ...snapshot, rows } }), {
        input: "X",
      }).state,
      { input: "4" },
    ).state;

    const transition = handleTuiKey(state, { input: "y" });

    expect(transition.operations).toBeUndefined();
    expect(transition.state.screen).toEqual({ name: "dashboard" });
    expect(transition.state.toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: "Station cannot verify this checkout's Git registration.",
      hint: "Refresh the dashboard before trying to remove the checkout.",
    });
  });

  it("remaps remove slot choices to the visible viewport after scrolling", () => {
    const scrolled = handleTuiKey(
      handleTuiKey(
        handleTuiKey(
          createInitialTuiState({
            initialSnapshot: createDashboardSnapshot(),
            terminalRows: 10,
          }),
          { input: "", mouseScroll: "down" },
        ).state,
        { input: "", mouseScroll: "down" },
      ).state,
      { input: "X" },
    );

    const transition = handleTuiKey(scrolled.state, { input: "1" });

    expect(transition.state.screen).toMatchObject({
      name: "removeWorktree",
      step: "confirm",
      rowId: "ses_wt_web_attention",
    });
  });

  it("remaps rename slot choices to the visible viewport after scrolling", () => {
    const scrolled = handleTuiKey(
      handleTuiKey(
        handleTuiKey(
          createInitialTuiState({
            initialSnapshot: createDashboardSnapshot(),
            terminalRows: 10,
          }),
          { input: "", mouseScroll: "down" },
        ).state,
        { input: "", mouseScroll: "down" },
      ).state,
      { input: "R" },
    );

    const transition = handleTuiKey(scrolled.state, { input: "1" });

    expect(transition.state.screen).toMatchObject({
      name: "renameSession",
      step: "editName",
      rowId: "ses_wt_web_attention",
      sessionId: "ses_wt_web_attention",
      currentTitle: "checkout-copy",
      draftTitle: { value: "", cursor: 0 },
    });
  });

  it("keeps scrolling while choosing a rename slot", () => {
    const opened = handleTuiKey(
      createInitialTuiState({
        initialSnapshot: createDashboardSnapshot(),
        terminalRows: 10,
      }),
      { input: "R" },
    );

    const transition = handleTuiKey(opened.state, { input: "", mouseScroll: "down" });

    expect(transition.state.screen).toEqual({ name: "renameSession", step: "chooseSlot" });
    expect(transition.state.scrollOffset).toBe(1);
  });

  it("does not offer a rename slot for a bare worktree", () => {
    const base = createDashboardSnapshot();
    const bare = base.rows.filter((row) => row.id === "wt_web_no_agent");
    const snapshot = { ...base, rows: bare, sessions: [] };
    const opened = handleTuiKey(createInitialTuiState({ initialSnapshot: snapshot }), {
      input: "R",
    });

    const transition = handleTuiKey(opened.state, { input: "1" });

    expect(transition.state.screen).toEqual({ name: "renameSession", step: "chooseSlot" });
    expect(transition.state.toasts).toEqual([]);
  });

  it("opens the rename editor directly for a dashboard row", () => {
    const state = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });

    const next = openRenameEditForRow(state, "ses_wt_web_idle");

    expect(next.screen).toMatchObject({
      name: "renameSession",
      step: "editName",
      rowId: "ses_wt_web_idle",
      sessionId: "ses_wt_web_idle",
      currentTitle: "fix-nav-mobile",
      draftTitle: { value: "", cursor: 0 },
    });
  });

  it("guards direct rename open for stale, no-session, and unrelated screens", () => {
    const dashboard = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
    expect(openRenameEditForRow(dashboard, "missing")).toBe(dashboard);
    expect(openRenameEditForRow(dashboard, "wt_web_no_agent")).toBe(dashboard);

    const filter = {
      ...createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      screen: {
        name: "persistentFilter",
        draft: { value: "", cursor: 0 },
        draftConditions: [],
      } as const,
    };
    expect(openRenameEditForRow(filter, "ses_wt_web_idle")).toBe(filter);
  });

  it("does not open rename for external session membership", () => {
    const state = createInitialTuiState({ initialSnapshot: createExternalAgentSnapshot() });

    expect(openRenameEditForRow(state, "run_wt_web_idle")).toBe(state);
  });

  it("starts a blank rename draft so typing replaces the current title", () => {
    const opened = handleTuiKey(
      handleTuiKey(createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }), {
        input: "R",
      }).state,
      { input: "4" },
    ).state;
    const inserted = handleTuiKey(opened, { input: "!" }).state;

    expect(inserted.screen).toMatchObject({
      name: "renameSession",
      step: "editName",
      currentTitle: "fix-nav-mobile",
      draftTitle: { value: "!", cursor: 1 },
    });
  });

  it("lets direct rename flows skip back to the dashboard on escape", () => {
    const opened = openRenameEditForRow(
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      "ses_wt_web_idle",
      { returnTo: "dashboard" },
    );

    const transition = handleTuiKey(opened, { input: "", escape: true });

    expect(opened.screen).toMatchObject({
      name: "renameSession",
      step: "editName",
      rowId: "ses_wt_web_idle",
      returnTo: "dashboard",
    });
    expect(transition.state.screen).toEqual({ name: "dashboard" });
  });

  it("keeps the rename sheet open with inline validation for empty titles", () => {
    const opened = handleTuiKey(
      handleTuiKey(createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }), {
        input: "R",
      }).state,
      { input: "4" },
    ).state;
    if (opened.screen.name !== "renameSession" || opened.screen.step !== "editName") {
      throw new Error("expected rename edit screen");
    }
    const state = {
      ...opened,
      screen: {
        ...opened.screen,
        draftTitle: { value: "   ", cursor: 3 },
      },
    };

    const transition = handleTuiKey(state, { input: "\r", return: true });

    expect(transition.state.screen).toEqual({
      ...state.screen,
      validationError: "Session title cannot be empty.",
    });
    expect(transition.state.toasts).toEqual([]);
    expect(transition.operations).toBeUndefined();
  });

  it("clears rename validation when the title is edited", () => {
    const opened = handleTuiKey(
      handleTuiKey(createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }), {
        input: "R",
      }).state,
      { input: "4" },
    ).state;
    if (opened.screen.name !== "renameSession" || opened.screen.step !== "editName") {
      throw new Error("expected rename edit screen");
    }
    const state = {
      ...opened,
      screen: {
        ...opened.screen,
        draftTitle: { value: "", cursor: 0 },
        validationError: "Session title cannot be empty.",
      },
    };

    const transition = handleTuiKey(state, { input: "a" });

    expect(transition.state.screen).toMatchObject({
      name: "renameSession",
      step: "editName",
      draftTitle: { value: "a", cursor: 1 },
    });
    expect(
      transition.state.screen.name === "renameSession" &&
        transition.state.screen.step === "editName"
        ? transition.state.screen.validationError
        : undefined,
    ).toBeUndefined();
  });

  it("closes unchanged rename titles without dispatching", () => {
    const state = handleTuiKey(
      handleTuiKey(createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }), {
        input: "R",
      }).state,
      { input: "4" },
    ).state;

    const transition = handleTuiKey(state, { input: "\r", return: true });

    expect(transition.state.screen).toEqual({ name: "dashboard" });
    expect(transition.operations).toBeUndefined();
  });

  it("submits changed rename titles as an optimistic local operation", () => {
    const state = handleTuiKey(
      handleTuiKey(createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }), {
        input: "R",
      }).state,
      { input: "4" },
    ).state;

    const typed = "updated"
      .split("")
      .reduce((current, input) => handleTuiKey(current, { input }).state, state);
    const transition = handleTuiKey(typed, { input: "\r", return: true });

    expect(transition.state.screen).toEqual({ name: "dashboard" });
    expect(transition.state.localRows.pendingRenameTitles?.ses_wt_web_idle?.title).toBe("updated");
    expect(transition.operations).toEqual([
      {
        type: "renameSession",
        sessionId: "ses_wt_web_idle",
        title: "updated",
        command: {
          type: "session.rename",
          payload: {
            sessionId: "ses_wt_web_idle",
            title: "updated",
          },
        },
      },
    ]);
  });

  it.each([
    { input: "n" },
    { input: "N" },
    { input: "", escape: true },
    { input: "\r", return: true },
  ])("cancels remove confirmation without a command", (key: TuiKey) => {
    const state = handleTuiKey(
      handleTuiKey(createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }), {
        input: "X",
      }).state,
      { input: "4" },
    ).state;

    const transition = handleTuiKey(state, key);

    expect(transition.state.screen).toEqual({ name: "dashboard" });
  });

  it("opens new session and submits semantic managed-session product values", () => {
    const opened = handleTuiKey(
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      { input: "N" },
    );
    expect(opened.state.screen.name).toBe("newSession");

    const submitted = handleTuiKey(opened.state, { input: "\r", return: true });

    expect(submitted.state.screen).toEqual({ name: "dashboard" });
    expect(submitted.operations?.[0]).toMatchObject({
      type: "createManagedSession",
      project: { id: "web" },
    });
    const operation = submitted.operations?.[0];
    if (operation?.type !== "createManagedSession") throw new Error("expected create operation");
    expect(operation.title).toBe(operation.hiddenBranch);
    expect(submitted.state.localRows.pendingCreate).toEqual([]);
  });

  it("keeps unavailable project submission inert in New Session", () => {
    const snapshot = createDashboardSnapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === "web");
    if (project === undefined) throw new Error("project fixture missing");
    const error = {
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_PROJECT_ROOT_BARE",
      message: "Project checkout is configured as a bare repository.",
      hint: `Inspect with git -C '${project.root}' config --show-origin --get core.bare. If this is the intended checkout, run git -C '${project.root}' config --local core.bare false; otherwise correct projects.root.`,
      provider: "worktrunk",
      projectId: project.id,
    } as const;
    const unavailable = {
      ...snapshot,
      projects: snapshot.projects.map((candidate) =>
        candidate.id === project.id
          ? {
              ...candidate,
              health: { ...candidate.health, status: "unavailable" as const, lastError: error },
            }
          : candidate,
      ),
    };
    const opened = handleTuiKey(createInitialTuiState({ initialSnapshot: unavailable }), {
      input: "N",
    });

    const submitted = handleTuiKey(opened.state, { input: "\r", return: true });

    expect(submitted).toEqual({ state: opened.state });
  });

  it("seeds and moves the new-session project cursor, committing the choice on enter", () => {
    const base = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
    const review = handleTuiKey(base, { input: "N" }).state;
    const pick = handleTuiKey(review, { input: "P" }).state;
    expect(deriveTuiInputMode(pick)).toBe("newSessionPickProject");
    // Seeded to the current selection (web); arrow down moves to api.
    expect(pick.selection.get("newSessionPickProject")).toBe("web");
    const moved = handleTuiKey(pick, { input: "", downArrow: true }).state;
    expect(moved.selection.get("newSessionPickProject")).toBe("api");

    const committed = handleTuiKey(moved, { input: "\r", return: true }).state;
    expect(committed.screen.name).toBe("newSession");
    if (committed.screen.name !== "newSession") throw new Error("unreachable");
    expect(committed.screen.flow.mode).toBe("review");
    expect(committed.screen.flow.selectedProjectId).toBe("api");
  });

  it("commits a new-session project via a slot key through the engine", () => {
    const base = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
    const review = handleTuiKey(base, { input: "N" }).state;
    const pick = handleTuiKey(review, { input: "P" }).state;
    // Slot "2" resolves to the second project (api) via the shared middleware.
    const committed = handleTuiKey(pick, { input: "2" }).state;
    if (committed.screen.name !== "newSession") throw new Error("unreachable");
    expect(committed.screen.flow.mode).toBe("review");
    expect(committed.screen.flow.selectedProjectId).toBe("api");
  });

  it("commits a new-session agent via the cursor on enter", () => {
    const base = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
    const review = handleTuiKey(base, { input: "N" }).state;
    const pick = handleTuiKey(review, { input: "A" }).state;
    expect(deriveTuiInputMode(pick)).toBe("newSessionPickAgent");
    expect(pick.selection.get("newSessionPickAgent")).toBe("codex");
    const moved = handleTuiKey(pick, { input: "", downArrow: true }).state;
    expect(moved.selection.get("newSessionPickAgent")).toBe("opencode");

    const committed = handleTuiKey(moved, { input: "\r", return: true }).state;
    if (committed.screen.name !== "newSession") throw new Error("unreachable");
    expect(committed.screen.flow.mode).toBe("review");
    expect(committed.screen.flow.selectedHarness).toBe("opencode");
  });

  it("opens and cancels the project default agent picker", () => {
    const state = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
    const opened = openProjectDefaultAgentPicker(state, "web");

    expect(opened.screen).toEqual({ name: "projectDefaultAgent", projectId: "web" });
    expect(handleTuiKey(opened, { input: "", escape: true }).state.screen).toEqual({
      name: "dashboard",
    });
  });

  it("preserves Project-menu header focus through every safe picker return", () => {
    const base = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      dashboardFocus: {
        rowId: dashboardRowIds.project("web"),
        cellId: "menu",
      },
    });
    const expectedFocus = base.dashboardFocus;

    const escaped = handleTuiKey(openProjectDefaultAgentPicker(base, "web"), {
      input: "",
      escape: true,
    }).state;
    expect(escaped.dashboardFocus).toEqual(expectedFocus);

    const openedForClickAway = openProjectDefaultAgentPicker(base, "web");
    const clickAway = tuiScreenBehavior(openedForClickAway.screen).clickAway;
    expect(clickAway?.(openedForClickAway).dashboardFocus).toEqual(expectedFocus);

    const unchanged = handleTuiKey(openProjectDefaultAgentPicker(base, "web"), {
      input: "1",
    }).state;
    expect(unchanged.dashboardFocus).toEqual(expectedFocus);

    const changed = handleTuiKey(openProjectDefaultAgentPicker(base, "web"), {
      input: "2",
    }).state;
    expect(changed.dashboardFocus).toEqual(expectedFocus);
  });

  it("reconciles picker return focus when its project disappears", () => {
    const snapshot = createDashboardSnapshot();
    const base = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        rowId: dashboardRowIds.project("web"),
        cellId: "menu",
      },
    });
    const opened = openProjectDefaultAgentPicker(base, "web");
    const withoutWeb = {
      ...snapshot,
      projects: snapshot.projects.filter((project) => project.id !== "web"),
      rows: snapshot.rows.filter((row) => row.projectId !== "web"),
      sessions: snapshot.sessions.filter((session) => session.projectId !== "web"),
    };
    const replaced = replaceSnapshot(opened, withoutWeb);
    const returned = handleTuiKey(replaced, { input: "", escape: true }).state;

    expect(returned.dashboardFocus).toEqual({
      rowId: dashboardRowIds.project("api"),
      cellId: "identity",
    });
  });

  it("does not open the project default agent picker without a usable project", () => {
    const noSnapshot = createInitialTuiState();
    expect(openProjectDefaultAgentPicker(noSnapshot, "web")).toBe(noSnapshot);

    const snapshot = createDashboardSnapshot();
    const unavailable = {
      ...snapshot,
      projects: snapshot.projects.map((project) =>
        project.id === "web"
          ? { ...project, health: { ...project.health, status: "unavailable" as const } }
          : project,
      ),
    };
    const state = createInitialTuiState({ initialSnapshot: unavailable });

    expect(openProjectDefaultAgentPicker(state, "web").screen).toEqual({ name: "dashboard" });
    expect(openProjectDefaultAgentPicker(state, "ghost").screen).toEqual({ name: "dashboard" });
  });

  it("sets a project default agent from the picker", () => {
    const state = openProjectDefaultAgentPicker(
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      "web",
    );

    const transition = handleTuiKey(state, { input: "2" });

    expect(transition.state.screen).toEqual({ name: "dashboard" });
    expect(transition.operations).toEqual([
      {
        type: "setProjectDefaultHarness",
        command: {
          type: "project.setDefaultHarness",
          payload: {
            projectId: "web",
            harness: "opencode",
          },
        },
      },
    ]);
  });

  it("closes the project default agent picker without dispatching when selection is unchanged", () => {
    const state = openProjectDefaultAgentPicker(
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      "web",
    );

    const transition = handleTuiKey(state, { input: "1" });

    expect(transition.state.screen).toEqual({ name: "dashboard" });
    expect(transition.operations).toBeUndefined();
  });

  it("seeds the default-agent cursor to the project's current default on open", () => {
    const opened = openProjectDefaultAgentPicker(
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      "web",
    );
    // web's default harness is codex (slot 1); the cursor starts there.
    expect(opened.selection.get("projectDefaultAgent")).toBe("codex");
  });

  it("moves the default-agent cursor with arrows and commits it on enter", () => {
    const opened = openProjectDefaultAgentPicker(
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      "web",
    );
    const moved = handleTuiKey(opened, { input: "", downArrow: true }).state;
    expect(moved.selection.get("projectDefaultAgent")).toBe("opencode");

    const committed = handleTuiKey(moved, { input: "\r", return: true });
    expect(committed.state.screen).toEqual({ name: "dashboard" });
    expect(committed.operations).toEqual([
      {
        type: "setProjectDefaultHarness",
        command: {
          type: "project.setDefaultHarness",
          payload: { projectId: "web", harness: "opencode" },
        },
      },
    ]);
  });

  it("enter on the unchanged default-agent cursor closes without dispatching", () => {
    const opened = openProjectDefaultAgentPicker(
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      "web",
    );
    const committed = handleTuiKey(opened, { input: "\r", return: true });
    expect(committed.state.screen).toEqual({ name: "dashboard" });
    expect(committed.operations).toBeUndefined();
  });

  it("clamps the default-agent cursor at the top edge", () => {
    const opened = openProjectDefaultAgentPicker(
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      "web",
    );
    const up = handleTuiKey(opened, { input: "", upArrow: true }).state;
    expect(up.selection.get("projectDefaultAgent")).toBe("codex");
  });

  it("emits focused empty-project Quick Session operations", () => {
    const transition = handleTuiKey(
      createInitialTuiState({
        initialSnapshot: createZeroWorktreeSnapshot(),
        dashboardFocus: { rowId: dashboardRowIds.empty("web"), cellId: "addSession" },
      }),
      { input: "\r", return: true },
    );

    expect(transition.operations?.[0]).toMatchObject({
      type: "quickCreateManagedSession",
      project: { id: "web" },
    });
    expect(transition.state.dashboardFocus).toEqual({
      rowId: dashboardRowIds.empty("web"),
      cellId: "addSession",
    });
  });

  it("keeps unavailable empty-project Quick Session blocked in the pure transition", () => {
    const snapshot = createZeroWorktreeSnapshot();
    const unavailable = {
      ...snapshot,
      projects: snapshot.projects.map((project) =>
        project.id === "web"
          ? { ...project, health: { ...project.health, status: "unavailable" as const } }
          : project,
      ),
    };
    const transition = handleTuiKey(
      createInitialTuiState({
        initialSnapshot: unavailable,
        dashboardFocus: { rowId: dashboardRowIds.empty("web"), cellId: "addSession" },
      }),
      { input: "\r", return: true },
    );

    expect(transition.operations).toBeUndefined();
    expect(transition.state.dashboardFocus).toEqual({
      rowId: dashboardRowIds.empty("web"),
      cellId: "addSession",
    });
    expect(transition.state.toasts.at(-1)?.toast.kind).toBe("error");
  });

  it("keeps stale projects and no-longer-empty actions inert", () => {
    for (const state of [
      createInitialTuiState({
        initialSnapshot: createZeroWorktreeSnapshot(),
        dashboardFocus: { rowId: dashboardRowIds.empty("ghost"), cellId: "addSession" },
      }),
      createInitialTuiState({
        initialSnapshot: createDashboardSnapshot(),
        dashboardFocus: { rowId: dashboardRowIds.empty("web"), cellId: "addSession" },
      }),
    ]) {
      expect(handleTuiKey(state, { input: "\r", return: true })).toEqual({ state });
    }
  });

  it("adds a safe error toast when no project exists for a new session", () => {
    const snapshot = {
      ...createZeroWorktreeSnapshot(),
      projects: [],
      counts: {
        ...createZeroWorktreeSnapshot().counts,
        projects: 0,
      },
    };

    const transition = handleTuiKey(createInitialTuiState({ initialSnapshot: snapshot }), {
      input: "N",
    });

    expect(transition.state.screen).toEqual({ name: "dashboard" });
    expect(transition.state.toasts).toEqual([
      expect.objectContaining({
        toast: expect.objectContaining({
          kind: "error",
          message: "No project is configured for a new session.",
        }),
      }),
    ]);
  });

  it.each([
    ["Help", [{ input: "H" }], { input: "", escape: true }],
    ["New Session", [{ input: "N" }], { input: "", escape: true }],
    ["Add Project", [{ input: "A" }], { input: "", escape: true }],
    ["rename", [{ input: "R" }], { input: "", escape: true }],
    ["fork", [{ input: "F" }], { input: "", escape: true }],
    ["remove", [{ input: "X" }], { input: "", escape: true }],
    ["settings", [{ input: "P" }, { input: "1" }], { input: "", escape: true }],
  ] as const)("returns from %s with the same applied filter", (_label, openKeys, closeKey) => {
    let state = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      persistentFilter: { query: "working" },
    });
    for (const key of openKeys) {
      state = handleTuiKey(state, key).state;
    }

    const returned = handleTuiKey(state, closeKey).state;

    expect(returned.screen).toEqual({ name: "dashboard" });
    expect(returned.persistentFilter).toEqual({ query: "working" });
  });

  it("limits chooser slots and focused Enter to sessions retained by the applied filter", () => {
    const base = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      persistentFilter: { query: "queue-worker" },
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_api_working"),
        cellId: "identity",
      },
    });
    const choosing = handleTuiKey(base, { input: "X" }).state;

    expect(handleTuiKey(choosing, { input: "2" }).state.screen).toEqual({
      name: "removeWorktree",
      step: "chooseSlot",
    });
    expect(handleTuiKey(choosing, { input: "1" }).state.screen).toMatchObject({
      name: "removeWorktree",
      step: "confirm",
      rowId: "ses_wt_api_working",
    });
    expect(handleTuiKey(choosing, { input: "\r", return: true }).state.screen).toMatchObject({
      name: "removeWorktree",
      step: "confirm",
      rowId: "ses_wt_api_working",
    });
  });

  it("clamps dashboard scroll across durable filter containers", () => {
    const opened = handleTuiKey(
      createInitialTuiState({
        initialSnapshot: createDashboardSnapshot(),
        scrollOffset: 4,
        terminalRows: 10,
      }),
      { input: "/" },
    );
    const typed = handleTuiKey(opened.state, { input: "nav" });
    const transition = handleTuiKey(typed.state, { input: "\r", return: true });

    expect(transition.state.persistentFilter).toEqual({ query: "nav" });
    expect(transition.state.scrollOffset).toBe(1);
  });

  it("preserves Group collapse and ordering while applying and clearing a filter", () => {
    const base = createInitialTuiState({
      initialSnapshot: createGroupedDashboardSnapshot(),
      collapsedGroupIds: ["group_active"],
      groupOrderingMode: "alphabetical-interleaved",
    });
    const opened = handleTuiKey(base, { input: "/" });
    const typed = handleTuiKey(opened.state, { input: "active" });
    const applied = handleTuiKey(typed.state, { input: "\r", return: true }).state;
    const cleared = handleTuiKey(applied, { input: "", escape: true }).state;

    expect(applied.collapsedGroupIds).toEqual(base.collapsedGroupIds);
    expect(applied.groupOrderingMode).toBe("alphabetical-interleaved");
    expect(cleared.collapsedGroupIds).toEqual(base.collapsedGroupIds);
    expect(cleared.groupOrderingMode).toBe("alphabetical-interleaved");
  });

  it("clamps dashboard scroll after collapsing a project", () => {
    const opened = handleTuiKey(
      createInitialTuiState({
        initialSnapshot: createDashboardSnapshot(),
        scrollOffset: 8,
        terminalRows: 10,
      }),
      { input: "C" },
    );
    const transition = handleTuiKey(opened.state, { input: "1" });

    expect(transition.state.collapsedProjectIds.has("web")).toBe(true);
    expect(transition.state.scrollOffset).toBe(1);
  });
});
