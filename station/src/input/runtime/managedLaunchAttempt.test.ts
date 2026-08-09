import { describe, expect, it } from "bun:test";
import {
  safeErrorToNotice,
  type AgentPrepareExternalLaunchParams,
  type AgentPrepareExternalLaunchResult,
} from "@station/client";
import type { StationCommand, StationSnapshot, WorktreeRow } from "@station/contracts";
import { selectPaneRecord, selectStationOverlayVisible } from "../../state/selectors.js";
import { createStationStore } from "../../state/store.js";
import { STATION_OVERLAY_ID, type PaneId } from "../../state/types.js";
import { manyProjectsSnapshot } from "../../station/fixtures/scenarios.js";
import { FakeTuiObserverService } from "../../station/test/support/fakeObserverService.js";
import { FakeStationSource } from "../../station/test/support/fakeStationSource.js";
import { createStationTestDashboardRuntime } from "../../station/test/support/makeStationTestRuntime.js";
import type {
  ManagedTerminalAttacher,
  ManagedTerminalFactory,
} from "../../terminal/pty/managedTerminalAttacher.js";
import { createPtyRegistry, type PtyRegistry } from "../../terminal/registry/ptyRegistry.js";
import { createScriptedTerminal } from "../../terminal/testing/scriptedTerminal.js";
import type {
  StationTerminalSize,
  StationTerminalSpawnOptions,
} from "../../terminal/types.js";
import {
  createManagedLaunchAttempt,
  type ManagedLaunchAttemptResult,
  type ManagedLaunchTarget,
} from "./managedLaunchAttempt.js";

const WORKTREE_ID = "wt_station_idle";
const ROW_ID = "ses_wt_station_idle";
const PANE_ID = "agent:wt_station_idle" as PaneId;
const CWD = "/Users/example/.worktrees/station/pty-buffer";
const TERMINAL_TARGET_ID = `native:${WORKTREE_ID}`;
const TARGET: ManagedLaunchTarget = {
  projectId: "station",
  worktreeId: WORKTREE_ID,
  cwd: CWD,
};

function preparedPlan(
  env: Record<string, string> | undefined = {
    STATION_SESSION_ID: "ses_managed",
    STATION_TERMINAL_TARGET_ID: TERMINAL_TARGET_ID,
  },
) {
  const launchPlan: Extract<AgentPrepareExternalLaunchResult, { kind: "prepared" }>["launchPlan"] = {
    provider: "codex",
    command: "codex-custom",
    args: ["--exec", "task"],
    cwd: CWD,
    mode: "interactive",
  };
  if (env !== undefined) {
    launchPlan.env = env;
  }
  return {
    kind: "prepared",
    sessionId: "ses_managed",
    terminalTargetId: TERMINAL_TARGET_ID,
    launchPlan,
  } satisfies AgentPrepareExternalLaunchResult;
}

function compatiblePreparedPlan() {
  return {
    ...preparedPlan(),
    outputCompatibility: "top-region-scrollback",
  } satisfies AgentPrepareExternalLaunchResult;
}

function recoveredPlan(sessionId: string) {
  return {
    ...preparedPlan({
      STATION_SESSION_ID: sessionId,
      STATION_TERMINAL_TARGET_ID: TERMINAL_TARGET_ID,
    }),
    sessionId,
  } satisfies AgentPrepareExternalLaunchResult;
}

function stationHostedSnapshot(): StationSnapshot {
  const snapshot = manyProjectsSnapshot();
  return {
    ...snapshot,
    rows: snapshot.rows.map((row): WorktreeRow => {
      if (row.id !== WORKTREE_ID || row.terminal === undefined) {
        return row;
      }
      return { ...row, terminal: { ...row.terminal, provider: "native", focusable: false } };
    }),
    sessions: snapshot.sessions.map((session) => {
      if (session.id !== ROW_ID || session.terminal === undefined) {
        return session;
      }
      return {
        ...session,
        terminal: { ...session.terminal, provider: "native", focusable: false },
      };
    }),
  };
}

function withoutTerminal(snapshot: StationSnapshot = manyProjectsSnapshot()): StationSnapshot {
  return {
    ...snapshot,
    rows: snapshot.rows.map((row): WorktreeRow => {
      if (row.id !== WORKTREE_ID) {
        return row;
      }
      const next = { ...row };
      delete next.terminal;
      return next;
    }),
    sessions: snapshot.sessions.map((session) => {
      if (session.id !== ROW_ID) {
        return session;
      }
      const next = { ...session };
      delete next.terminal;
      return next;
    }),
  };
}

function withDetachedTerminal(): StationSnapshot {
  const snapshot = manyProjectsSnapshot();
  return {
    ...snapshot,
    rows: snapshot.rows.map((row): WorktreeRow =>
      row.id === WORKTREE_ID && row.terminal !== undefined
        ? { ...row, terminal: { ...row.terminal, state: "detached" } }
        : row,
    ),
    sessions: snapshot.sessions.map((session) =>
      session.id === ROW_ID && session.terminal !== undefined
        ? { ...session, terminal: { ...session.terminal, state: "detached" } }
        : session,
    ),
  };
}

function withTurnReadiness(): StationSnapshot {
  const snapshot = manyProjectsSnapshot();
  return {
    ...snapshot,
    rows: snapshot.rows.map((row): WorktreeRow => {
      if (row.id !== WORKTREE_ID || row.agent === undefined) {
        return row;
      }
      return {
        ...row,
        agent: {
          ...row.agent,
          turnReadiness: {
            state: "ready_to_read",
            token: "report_station_ready",
            completedAt: "2026-06-17T12:00:00.000Z",
          },
        },
      };
    }),
  };
}

type AttemptHarnessOptions = {
  prepared?: AgentPrepareExternalLaunchResult;
  snapshot?: StationSnapshot;
  observer?: boolean;
  registry?: boolean;
  attacher?: ManagedTerminalAttacher;
  prepare?: (
    params: AgentPrepareExternalLaunchParams,
  ) => Promise<AgentPrepareExternalLaunchResult>;
};

function attemptHarness(options: AttemptHarnessOptions = {}) {
  const snapshot = options.snapshot ?? manyProjectsSnapshot();
  const observerService = new FakeTuiObserverService(snapshot);
  observerService.nextPreparedLaunch = options.prepared ?? preparedPlan();
  const prepareCalls: AgentPrepareExternalLaunchParams[] = [];
  const prepare = options.prepare;
  observerService.prepareExternalLaunch = async (params) => {
    prepareCalls.push(params);
    return prepare === undefined ? observerService.nextPreparedLaunch : await prepare(params);
  };
  const source = new FakeStationSource(snapshot);
  const dashboardRuntime = createStationTestDashboardRuntime({
    source,
    service: observerService,
    initialSnapshot: snapshot,
    persistentPopup: true,
    onDismiss: async () => {},
    initialState: { terminalRows: 12 },
  });
  const scripted = [createScriptedTerminal(), createScriptedTerminal()];
  const spawnSizes: StationTerminalSize[] = [];
  let spawnIndex = 0;
  const baseRegistry = createPtyRegistry({
    createTerminal: (spawnOptions) => {
      const terminal = scripted[spawnIndex]?.terminal;
      if (terminal === undefined) throw new Error("scripted terminal pool exhausted");
      spawnIndex += 1;
      if (spawnOptions.size?.cols !== undefined && spawnOptions.size.rows !== undefined) {
        spawnSizes.push({ cols: spawnOptions.size.cols, rows: spawnOptions.size.rows });
      }
      return terminal;
    },
  });
  const calls: string[] = [];
  const ensured: StationTerminalSpawnOptions[] = [];
  const terminalFactories: ManagedTerminalFactory[] = [];
  const registry: PtyRegistry = {
    ...baseRegistry,
    ensure: (paneId, spawnOptions, createTerminalOverride) => {
      calls.push(`ensure:${paneId}`);
      if (spawnOptions !== undefined) {
        ensured.push(spawnOptions);
      }
      if (createTerminalOverride !== undefined) {
        terminalFactories.push(createTerminalOverride);
      }
      return baseRegistry.ensure(paneId, spawnOptions, createTerminalOverride);
    },
  };
  const store = createStationStore();
  const createPane = store.actions.createPane;
  store.actions.createPane = (paneId, createOptions) => {
    calls.push(`pane:${paneId}:${createOptions?.role ?? "shell"}`);
    createPane(paneId, createOptions);
  };
  const setPrimaryAgent = store.actions.setPrimaryAgent;
  store.actions.setPrimaryAgent = (paneId, identity) => {
    calls.push(`identity:${paneId}:${identity.sessionId}`);
    setPrimaryAgent(paneId, identity);
  };
  const revealPane = store.actions.revealPane;
  store.actions.revealPane = (paneId) => {
    calls.push(`reveal:${paneId}`);
    revealPane(paneId);
  };
  const rawManagedLaunchAttempt = createManagedLaunchAttempt({
    store,
    clientState: source,
    observerService: options.observer === false ? undefined : observerService,
    registry: options.registry === false ? undefined : registry,
    managedTerminalAttacher: options.attacher,
  });
  let lastResult: ManagedLaunchAttemptResult | undefined;
  const runManagedLaunchAttempt = async (
    paneId: PaneId,
    target: ManagedLaunchTarget,
  ): Promise<ManagedLaunchAttemptResult> => {
    lastResult = await rawManagedLaunchAttempt(paneId, target);
    return lastResult;
  };
  return {
    store,
    dashboardRuntime,
    source,
    observerService,
    prepareCalls,
    calls,
    ensured,
    terminalFactories,
    registry,
    baseRegistry,
    scripted,
    spawnSizes,
    runManagedLaunchAttempt,
    lastToast: () =>
      lastResult?.kind === "notice"
        ? lastResult.notice
        : lastResult?.kind === "failure"
          ? safeErrorToNotice(lastResult.error)
          : undefined,
  };
}

function openOverlay(harness: ReturnType<typeof attemptHarness>): void {
  harness.store.actions.openOverlay(STATION_OVERLAY_ID);
}

describe("createManagedLaunchAttempt", () => {
  it("reveals an existing pane without preparing, while a background attempt does neither", async () => {
    const foreground = attemptHarness();
    foreground.store.actions.createPane(PANE_ID, { role: "primary-agent" });
    foreground.calls.length = 0;
    openOverlay(foreground);

    await foreground.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(foreground.prepareCalls).toEqual([]);
    expect(foreground.calls).toEqual([`reveal:${PANE_ID}`]);
    expect(selectStationOverlayVisible(foreground.store.getState())).toBe(true);

    const background = attemptHarness();
    background.store.actions.createPane(PANE_ID, { role: "primary-agent" });
    background.calls.length = 0;
    openOverlay(background);

    await background.runManagedLaunchAttempt(PANE_ID, { ...TARGET, background: true });

    expect(background.prepareCalls).toEqual([]);
    expect(background.calls).toEqual([]);
    expect(selectStationOverlayVisible(background.store.getState())).toBe(true);
  });

  it("recycles an exited pane under its recovered identity while preserving child layout", async () => {
    const harness = attemptHarness({ prepared: recoveredPlan("ses_old") });
    harness.store.actions.createPane(PANE_ID, { role: "primary-agent" });
    harness.store.actions.setPrimaryAgent(PANE_ID, {
      sessionId: "ses_old",
      terminalTargetId: TERMINAL_TARGET_ID,
      harnessProvider: "codex",
    });
    harness.store.actions.createPane("pane-child", {
      split: { anchorPaneId: PANE_ID, direction: "right" },
    });
    harness.baseRegistry.ensure(PANE_ID, { cwd: CWD });
    harness.baseRegistry.resize(PANE_ID, { cols: 90, rows: 24 });
    const oldEntry = harness.baseRegistry.get(PANE_ID);
    harness.scripted[0].helpers.emitExit({ exitCode: 0 });
    harness.calls.length = 0;
    openOverlay(harness);

    await harness.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(harness.prepareCalls).toHaveLength(1);
    expect(harness.baseRegistry.get(PANE_ID)).not.toBe(oldEntry);
    expect(harness.baseRegistry.get(PANE_ID)?.terminal).toBe(harness.scripted[1].terminal);
    expect(
      harness.store.getState().workspace.panes.find((pane) => pane.id === "pane-child"),
    ).toEqual({
      id: "pane-child",
      split: { anchorPaneId: PANE_ID, direction: "right" },
      role: "shell",
    });
    expect(selectPaneRecord(harness.store.getState(), PANE_ID)?.agentIdentity).toEqual({
      sessionId: "ses_old",
      terminalTargetId: TERMINAL_TARGET_ID,
      harnessProvider: "codex",
    });
    expect(selectStationOverlayVisible(harness.store.getState())).toBe(true);
  });

  it("waits for current layout before spawning a newly revealed exited pane", async () => {
    const harness = attemptHarness();
    harness.store.actions.createPane(PANE_ID, { role: "primary-agent" });
    harness.store.actions.setPrimaryAgent(PANE_ID, {
      sessionId: "ses_old",
      terminalTargetId: TERMINAL_TARGET_ID,
    });
    harness.baseRegistry.resize(PANE_ID, { cols: 90, rows: 24 });
    harness.scripted[0].helpers.emitExit({ exitCode: 0 });
    harness.store.actions.createPane("pane-other", { role: "primary-agent" });
    openOverlay(harness);

    await harness.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(harness.baseRegistry.get(PANE_ID)?.terminal).toBeNull();
    const current = { cols: 52, rows: 14 };
    harness.baseRegistry.resize(PANE_ID, current);
    expect(harness.baseRegistry.get(PANE_ID)?.terminal).toBe(harness.scripted[1].terminal);
    expect(harness.spawnSizes).toEqual([{ cols: 90, rows: 24 }, current]);
  });

  it("rechecks tree activity when another session closes during preparation", async () => {
    let release!: (result: AgentPrepareExternalLaunchResult) => void;
    const gate = new Promise<AgentPrepareExternalLaunchResult>((resolve) => {
      release = resolve;
    });
    const harness = attemptHarness({ prepare: async () => await gate });
    harness.store.actions.createPane(PANE_ID, { role: "primary-agent" });
    harness.store.actions.setPrimaryAgent(PANE_ID, {
      sessionId: "ses_old",
      terminalTargetId: TERMINAL_TARGET_ID,
    });
    harness.baseRegistry.resize(PANE_ID, { cols: 90, rows: 24 });
    harness.scripted[0].helpers.emitExit({ exitCode: 0 });
    harness.store.actions.createPane("pane-other", { role: "primary-agent" });

    const attempt = harness.runManagedLaunchAttempt(PANE_ID, TARGET);
    await Promise.resolve();
    harness.store.actions.closePaneTree("pane-other");
    release(preparedPlan());
    await attempt;

    expect(harness.baseRegistry.get(PANE_ID)?.terminal).toBe(harness.scripted[1].terminal);
    expect(harness.spawnSizes).toEqual([
      { cols: 90, rows: 24 },
      { cols: 90, rows: 24 },
    ]);
  });

  it("preserves the exited pane when replacement preparation fails", async () => {
    const harness = attemptHarness({
      prepare: async () => {
        throw new Error("prepare failed");
      },
    });
    harness.store.actions.createPane(PANE_ID, { role: "primary-agent" });
    harness.store.actions.setPrimaryAgent(PANE_ID, {
      sessionId: "ses_old",
      terminalTargetId: TERMINAL_TARGET_ID,
    });
    harness.baseRegistry.ensure(PANE_ID, { cwd: CWD });
    harness.baseRegistry.resize(PANE_ID, { cols: 90, rows: 24 });
    const oldEntry = harness.baseRegistry.get(PANE_ID);
    harness.scripted[0].helpers.emitExit({ exitCode: 0 });
    openOverlay(harness);

    const result = await harness.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(result.kind).toBe("failure");
    expect(harness.baseRegistry.get(PANE_ID)).toBe(oldEntry);
    expect(harness.scripted[0].helpers.isDisposed()).toBe(false);
    expect(selectStationOverlayVisible(harness.store.getState())).toBe(true);
  });

  it("reports a detached terminal without preparing or closing the overlay", async () => {
    const harness = attemptHarness({ snapshot: withDetachedTerminal() });
    openOverlay(harness);

    await harness.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(harness.prepareCalls).toEqual([]);
    expect(harness.lastToast()).toMatchObject({ kind: "info" });
    expect(harness.lastToast()?.message).toContain("detached");
    expect(selectStationOverlayVisible(harness.store.getState())).toBe(true);
  });

  it("resolves existing-session targets from client truth when dashboard projection is stale", async () => {
    const existing: AgentPrepareExternalLaunchResult = {
      kind: "existing-session",
      sessionId: "ses_elsewhere",
      harnessProvider: "codex",
    };
    const harness = attemptHarness({ prepared: existing });
    harness.source.setSnapshot(withoutTerminal());

    expect(
      harness.dashboardRuntime.state.getState().snapshot?.rows.find(
        (row) => row.id === WORKTREE_ID,
      )?.terminal?.provider,
    ).toBe("tmux");
    await harness.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(harness.observerService.dispatched).toEqual([
      { type: "terminal.focus", payload: { sessionId: "ses_elsewhere" } },
    ]);
  });

  it("acknowledges readiness from client truth when dashboard projection is stale", async () => {
    const harness = attemptHarness();
    harness.source.setSnapshot(withTurnReadiness());

    expect(
      harness.dashboardRuntime.state.getState().snapshot?.rows.find(
        (row) => row.id === WORKTREE_ID,
      )?.agent?.turnReadiness,
    ).toBeUndefined();
    await harness.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(
      harness.observerService.dispatched.some(
        (command) =>
          command.type === "session.acknowledgeTurn" &&
          command.payload.sessionId === ROW_ID &&
          command.payload.token === "report_station_ready",
      ),
    ).toBe(true);
  });

  it("deduplicates preparation while one pane launch is in flight", async () => {
    let release!: (result: AgentPrepareExternalLaunchResult) => void;
    const gate = new Promise<AgentPrepareExternalLaunchResult>((resolve) => {
      release = resolve;
    });
    const harness = attemptHarness({ prepare: async () => await gate });

    const first = harness.runManagedLaunchAttempt(PANE_ID, TARGET);
    const duplicate = harness.runManagedLaunchAttempt(PANE_ID, TARGET);
    await Promise.resolve();

    expect(harness.prepareCalls).toHaveLength(1);
    release(preparedPlan());
    await Promise.all([first, duplicate]);
  });

  it("deduplicates preparation across replacement HMR compositions", async () => {
    let release!: (result: AgentPrepareExternalLaunchResult) => void;
    const gate = new Promise<AgentPrepareExternalLaunchResult>((resolve) => {
      release = resolve;
    });
    const harness = attemptHarness({ prepare: async () => await gate });
    const replacementRunner = createManagedLaunchAttempt({
      store: harness.store,
      clientState: harness.source,
      observerService: harness.observerService,
      registry: harness.registry,
      managedTerminalAttacher: undefined,
    });

    const first = harness.runManagedLaunchAttempt(PANE_ID, TARGET);
    const duplicate = replacementRunner(PANE_ID, TARGET);
    await Promise.resolve();

    expect(harness.prepareCalls).toHaveLength(1);
    release(preparedPlan());
    await Promise.all([first, duplicate]);
  });

  it("releases an unplaced local target when the exited pane changes during preparation", async () => {
    let release!: (result: AgentPrepareExternalLaunchResult) => void;
    const gate = new Promise<AgentPrepareExternalLaunchResult>((resolve) => {
      release = resolve;
    });
    const harness = attemptHarness({ prepare: async () => await gate });
    harness.store.actions.createPane(PANE_ID, { role: "primary-agent" });
    harness.store.actions.setPrimaryAgent(PANE_ID, {
      sessionId: "ses_old",
      terminalTargetId: TERMINAL_TARGET_ID,
    });
    harness.baseRegistry.resize(PANE_ID, { cols: 90, rows: 24 });
    harness.scripted[0].helpers.emitExit({ exitCode: 0 });

    const attempt = harness.runManagedLaunchAttempt(PANE_ID, TARGET);
    await Promise.resolve();
    harness.store.actions.setPrimaryAgent(PANE_ID, {
      sessionId: "ses_other",
      terminalTargetId: "native:other",
    });
    release(preparedPlan());
    await attempt;

    expect(harness.observerService.reportedExits).toEqual([
      {
        terminalTargetId: TERMINAL_TARGET_ID,
        expectedSessionId: "ses_managed",
      },
    ]);
    expect(harness.baseRegistry.get(PANE_ID)?.exited).toBe(true);
  });

  it("toasts and keeps the overlay open when the exited pane's identity changes during preparation", async () => {
    let release!: (result: AgentPrepareExternalLaunchResult) => void;
    const gate = new Promise<AgentPrepareExternalLaunchResult>((resolve) => {
      release = resolve;
    });
    const harness = attemptHarness({ prepare: async () => await gate });
    harness.store.actions.createPane(PANE_ID, { role: "primary-agent" });
    harness.store.actions.setPrimaryAgent(PANE_ID, {
      sessionId: "ses_old",
      terminalTargetId: TERMINAL_TARGET_ID,
    });
    harness.baseRegistry.resize(PANE_ID, { cols: 90, rows: 24 });
    harness.scripted[0].helpers.emitExit({ exitCode: 0 });
    openOverlay(harness);

    const attempt = harness.runManagedLaunchAttempt(PANE_ID, TARGET);
    await Promise.resolve();
    harness.store.actions.setPrimaryAgent(PANE_ID, {
      sessionId: "ses_other",
      terminalTargetId: "native:other",
    });
    release(preparedPlan());
    await attempt;

    expect(harness.lastToast()).toMatchObject({
      kind: "info",
      message: "The agent pane changed while Station was preparing its relaunch.",
    });
    expect(selectStationOverlayVisible(harness.store.getState())).toBe(true);
    expect(harness.baseRegistry.get(PANE_ID)?.exited).toBe(true);
  });

  it("refuses to replace an exited entry superseded during preparation", async () => {
    let release!: (result: AgentPrepareExternalLaunchResult) => void;
    const gate = new Promise<AgentPrepareExternalLaunchResult>((resolve) => {
      release = resolve;
    });
    const harness = attemptHarness({ prepare: async () => await gate });
    harness.store.actions.createPane(PANE_ID, { role: "primary-agent" });
    harness.store.actions.setPrimaryAgent(PANE_ID, {
      sessionId: "ses_old",
      terminalTargetId: TERMINAL_TARGET_ID,
    });
    harness.baseRegistry.resize(PANE_ID, { cols: 90, rows: 24 });
    harness.scripted[0].helpers.emitExit({ exitCode: 0 });
    openOverlay(harness);

    const attempt = harness.runManagedLaunchAttempt(PANE_ID, TARGET);
    await Promise.resolve();
    harness.baseRegistry.dispose(PANE_ID);
    harness.baseRegistry.ensure(PANE_ID, { cwd: CWD });
    release(preparedPlan());
    await attempt;

    expect(harness.lastToast()).toMatchObject({
      kind: "info",
      message: "The agent pane changed while Station was preparing its relaunch.",
    });
    expect(harness.observerService.reportedExits).toEqual([
      {
        terminalTargetId: TERMINAL_TARGET_ID,
        expectedSessionId: "ses_managed",
      },
    ]);
    expect(selectStationOverlayVisible(harness.store.getState())).toBe(true);
  });

  it("surfaces uncertain cleanup when an unplaced local target cannot be released", async () => {
    let release!: (result: AgentPrepareExternalLaunchResult) => void;
    const gate = new Promise<AgentPrepareExternalLaunchResult>((resolve) => {
      release = resolve;
    });
    const harness = attemptHarness({ prepare: async () => await gate });
    harness.observerService.reportExternalExit = async () => {
      throw new Error("observer disconnected");
    };
    harness.store.actions.createPane(PANE_ID, { role: "primary-agent" });
    harness.store.actions.setPrimaryAgent(PANE_ID, {
      sessionId: "ses_old",
      terminalTargetId: TERMINAL_TARGET_ID,
    });
    harness.baseRegistry.resize(PANE_ID, { cols: 90, rows: 24 });
    harness.scripted[0].helpers.emitExit({ exitCode: 0 });

    const attempt = harness.runManagedLaunchAttempt(PANE_ID, TARGET);
    await Promise.resolve();
    harness.store.actions.setPrimaryAgent(PANE_ID, {
      sessionId: "ses_other",
      terminalTargetId: "native:other",
    });
    release(preparedPlan());
    await attempt;

    expect(harness.lastToast()).toMatchObject({ kind: "error" });
  });

  it("releases the in-flight guard after a failed preparation so retry is accepted", async () => {
    let attempts = 0;
    const harness = attemptHarness({
      prepare: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("prepare failed");
        }
        return preparedPlan();
      },
    });

    const failure = await harness.runManagedLaunchAttempt(PANE_ID, TARGET);
    const retry = await harness.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(harness.prepareCalls).toHaveLength(2);
    expect(failure).toEqual({
      kind: "failure",
      error: {
        tag: "ClientObserverError",
        code: "CLIENT_OBSERVER_OPERATION_FAILED",
        message: "The Station could not complete the observer operation.",
      },
    });
    expect(retry).toEqual({ kind: "success", landed: true });
    expect(harness.calls).toEqual([
      `ensure:${PANE_ID}`,
      `pane:${PANE_ID}:primary-agent`,
      `identity:${PANE_ID}:ses_managed`,
    ]);
  });

  it("resolves an advertised attachment before ensure, pane, and identity publication", async () => {
    const attachment = {
      kind: "managed-terminal",
      terminalTargetId: `${TERMINAL_TARGET_ID}-host`,
    } as const;
    const base = preparedPlan();
    if (base.kind !== "prepared") {
      throw new Error("expected a prepared launch fixture");
    }
    const order: string[] = [];
    const scripted = createScriptedTerminal();
    const factory: ManagedTerminalFactory = () => scripted.terminal;
    const harness = attemptHarness({
      prepared: { ...base, attachment },
      attacher: {
        resolve: async () => {
          order.push("resolve");
          return factory;
        },
      },
    });
    const originalPush = harness.calls.push.bind(harness.calls);
    harness.calls.push = (...items) => {
      order.push(...items);
      return originalPush(...items);
    };

    await harness.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(order).toEqual([
      "resolve",
      `ensure:${PANE_ID}`,
      `pane:${PANE_ID}:primary-agent`,
      `identity:${PANE_ID}:ses_managed`,
    ]);
    expect(harness.ensured).toEqual([{ cwd: CWD }]);
    expect(harness.terminalFactories).toEqual([factory]);
  });

  it("never falls back to local ensure when an advertised attachment is missing or fails", async () => {
    const attachment = {
      kind: "managed-terminal",
      terminalTargetId: `${TERMINAL_TARGET_ID}-gone`,
    } as const;
    const base = preparedPlan();
    if (base.kind !== "prepared") {
      throw new Error("expected a prepared launch fixture");
    }
    const missing = attemptHarness({ prepared: { ...base, attachment } });

    await missing.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(missing.calls).toEqual([]);
    expect(missing.lastToast()).toMatchObject({ kind: "error" });

    const failing = attemptHarness({
      prepared: { ...base, attachment },
      attacher: {
        resolve: async () => {
          throw {
            tag: "TerminalProviderError",
            code: "HOST_ATTACH_FAILED",
            message: "attachment failed",
            provider: "native",
          };
        },
      },
    });

    const result = await failing.runManagedLaunchAttempt(PANE_ID, TARGET);
    await failing.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(result).toMatchObject({
      kind: "failure",
      error: { code: "HOST_ATTACH_FAILED", message: "attachment failed" },
    });
    expect(failing.prepareCalls).toHaveLength(2);
    expect(failing.calls).toEqual([]);
    expect(failing.lastToast()?.message).toContain("attachment failed");
  });

  it("publishes a fresh spawn with command, arguments, optional environment, and ordering", async () => {
    const harness = attemptHarness();

    await harness.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(harness.calls).toEqual([
      `ensure:${PANE_ID}`,
      `pane:${PANE_ID}:primary-agent`,
      `identity:${PANE_ID}:ses_managed`,
    ]);
    expect(harness.ensured).toEqual([
      {
        cwd: CWD,
        command: "codex-custom",
        args: ["--exec", "task"],
        env: {
          STATION_SESSION_ID: "ses_managed",
          STATION_TERMINAL_TARGET_ID: TERMINAL_TARGET_ID,
        },
      },
    ]);

    const planWithoutEnvironment = preparedPlan();
    if (planWithoutEnvironment.kind !== "prepared") {
      throw new Error("expected a prepared launch fixture");
    }
    const launchPlanWithoutEnvironment = { ...planWithoutEnvironment.launchPlan };
    delete launchPlanWithoutEnvironment.env;
    const withoutEnvironment = attemptHarness({
      prepared: { ...planWithoutEnvironment, launchPlan: launchPlanWithoutEnvironment },
    });
    await withoutEnvironment.runManagedLaunchAttempt(PANE_ID, TARGET);
    expect("env" in (withoutEnvironment.ensured[0] ?? {})).toBe(false);
  });

  it("passes generic output compatibility to a local PTY spawn", async () => {
    const harness = attemptHarness({ prepared: compatiblePreparedPlan() });

    await harness.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(harness.ensured).toEqual([
      {
        cwd: CWD,
        command: "codex-custom",
        args: ["--exec", "task"],
        env: {
          STATION_SESSION_ID: "ses_managed",
          STATION_TERMINAL_TARGET_ID: TERMINAL_TARGET_ID,
        },
        outputCompatibility: "top-region-scrollback",
      },
    ]);
  });

  it("keeps external and non-attachable Station existing sessions as informational notices", async () => {
    const existing: AgentPrepareExternalLaunchResult = {
      kind: "existing-session",
      sessionId: "ses_elsewhere",
      harnessProvider: "codex",
    };
    const external = attemptHarness({ prepared: existing });
    openOverlay(external);

    await external.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(external.observerService.dispatched).toEqual([]);
    expect(external.lastToast()).toMatchObject({ kind: "info" });
    expect(external.lastToast()?.message).toContain("tmux");
    expect(selectStationOverlayVisible(external.store.getState())).toBe(true);

    const station = attemptHarness({ prepared: existing, snapshot: stationHostedSnapshot() });
    openOverlay(station);

    await station.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(station.observerService.dispatched).toEqual([]);
    expect(station.lastToast()).toMatchObject({ kind: "info" });
    expect(station.lastToast()?.message).toContain("no attachable host PTY");
    expect(selectStationOverlayVisible(station.store.getState())).toBe(true);
  });

  it("focuses and lands only after a visibly actionable existing session succeeds", async () => {
    const harness = attemptHarness({
      prepared: {
        kind: "existing-session",
        sessionId: "ses_elsewhere",
        harnessProvider: "codex",
      },
      snapshot: withoutTerminal(),
    });
    openOverlay(harness);

    await harness.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(harness.observerService.dispatched).toEqual([
      { type: "terminal.focus", payload: { sessionId: "ses_elsewhere" } },
    ]);
    expect(selectStationOverlayVisible(harness.store.getState())).toBe(true);
  });

  it("does not land after rejected, failed, or thrown focus operations", async () => {
    const existing: AgentPrepareExternalLaunchResult = {
      kind: "existing-session",
      sessionId: "ses_elsewhere",
      harnessProvider: "codex",
    };

    const rejected = attemptHarness({ prepared: existing, snapshot: withoutTerminal() });
    rejected.observerService.nextReceipt = {
      commandId: "cmd_tui_1",
      accepted: false,
      status: "rejected",
    };
    openOverlay(rejected);
    await rejected.runManagedLaunchAttempt(PANE_ID, TARGET);
    expect(selectStationOverlayVisible(rejected.store.getState())).toBe(true);

    const failed = attemptHarness({ prepared: existing, snapshot: withoutTerminal() });
    failed.observerService.nextCompletion = {
      status: "failed",
      commandId: "cmd_tui_1",
      error: { tag: "ClientObserverError", code: "FOCUS_FAILED", message: "focus failed" },
    };
    openOverlay(failed);
    await failed.runManagedLaunchAttempt(PANE_ID, TARGET);
    expect(selectStationOverlayVisible(failed.store.getState())).toBe(true);

    const thrown = attemptHarness({ prepared: existing, snapshot: withoutTerminal() });
    thrown.observerService.dispatch = async () => {
      throw new Error("focus threw");
    };
    openOverlay(thrown);
    await thrown.runManagedLaunchAttempt(PANE_ID, TARGET);
    expect(selectStationOverlayVisible(thrown.store.getState())).toBe(true);
  });

  it("does not focus or land an existing session for a background launch", async () => {
    const harness = attemptHarness({
      prepared: {
        kind: "existing-session",
        sessionId: "ses_elsewhere",
        harnessProvider: "codex",
      },
      snapshot: withoutTerminal(),
    });
    openOverlay(harness);

    await harness.runManagedLaunchAttempt(PANE_ID, { ...TARGET, background: true });

    expect(harness.observerService.dispatched).toEqual([]);
    expect(selectStationOverlayVisible(harness.store.getState())).toBe(true);
  });

  it("keeps readiness acknowledgement best-effort after a successful open", async () => {
    const harness = attemptHarness({ snapshot: withTurnReadiness() });
    harness.observerService.dispatch = async (command: StationCommand) => {
      if (command.type === "session.acknowledgeTurn") {
        throw new Error("ack failed");
      }
      return harness.observerService.nextReceipt;
    };
    openOverlay(harness);

    await harness.runManagedLaunchAttempt(PANE_ID, TARGET);

    expect(selectStationOverlayVisible(harness.store.getState())).toBe(true);
    expect(
      harness.store
        .getState()
        .workspace.panes.some((pane) => pane.id === PANE_ID && pane.role === "primary-agent"),
    ).toBe(true);
    expect(harness.dashboardRuntime.state.getState().toasts).toEqual([]);
  });

  it("releases the in-flight guard after informational and focus-failure completions", async () => {
    const existing: AgentPrepareExternalLaunchResult = {
      kind: "existing-session",
      sessionId: "ses_elsewhere",
      harnessProvider: "codex",
    };
    const notice = attemptHarness({ prepared: existing });
    await notice.runManagedLaunchAttempt(PANE_ID, TARGET);
    await notice.runManagedLaunchAttempt(PANE_ID, TARGET);
    expect(notice.prepareCalls).toHaveLength(2);

    const focusFailure = attemptHarness({ prepared: existing, snapshot: withoutTerminal() });
    focusFailure.observerService.nextCompletion = {
      status: "failed",
      commandId: "cmd_tui_1",
      error: { tag: "ClientObserverError", code: "FOCUS_FAILED", message: "focus failed" },
    };
    await focusFailure.runManagedLaunchAttempt(PANE_ID, TARGET);
    await focusFailure.runManagedLaunchAttempt(PANE_ID, TARGET);
    expect(focusFailure.prepareCalls).toHaveLength(2);
  });
});
