import { describe, expect, it } from "bun:test";
import type { AgentPrepareExternalLaunchParams, AgentPrepareExternalLaunchResult } from "@station/client";
import type { StationCommand, StationSnapshot, WorktreeRow } from "@station/contracts";
import { createTuiStore } from "@station/dashboard-core";
import { selectStationOverlayVisible } from "../../state/selectors.js";
import { createStationStore } from "../../state/store.js";
import { STATION_OVERLAY_ID, type PaneId } from "../../state/types.js";
import { manyProjectsSnapshot } from "../../station/fixtures/scenarios.js";
import { FakeTuiObserverService } from "../../station/test/support/fakeObserverService.js";
import { FakeStationSource } from "../../station/test/support/fakeStationSource.js";
import type {
  ManagedTerminalAttacher,
  ManagedTerminalFactory,
} from "../../terminal/pty/managedTerminalAttacher.js";
import { createPtyRegistry, type PtyRegistry } from "../../terminal/registry/ptyRegistry.js";
import { createScriptedTerminal } from "../../terminal/testing/scriptedTerminal.js";
import type { StationTerminalSpawnOptions } from "../../terminal/types.js";
import {
  createManagedLaunchAttempt,
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
): AgentPrepareExternalLaunchResult {
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
  };
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
  const stationViewStore = createTuiStore({
    source: new FakeStationSource(snapshot),
    service: observerService,
    initialSnapshot: snapshot,
    persistentPopup: true,
    onDismiss: async () => {},
    initialState: { terminalRows: 12 },
  });
  const scripted = createScriptedTerminal();
  const baseRegistry = createPtyRegistry({ createTerminal: () => scripted.terminal });
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
  const runManagedLaunchAttempt = createManagedLaunchAttempt({
    store,
    stationViewStore,
    observerService: options.observer === false ? undefined : observerService,
    registry: options.registry === false ? undefined : registry,
    managedTerminalAttacher: options.attacher,
  });
  return {
    store,
    stationViewStore,
    observerService,
    prepareCalls,
    calls,
    ensured,
    terminalFactories,
    runManagedLaunchAttempt,
    lastToast: () => stationViewStore.getState().toasts.at(-1)?.toast,
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
    expect(selectStationOverlayVisible(foreground.store.getState())).toBe(false);

    const background = attemptHarness();
    background.store.actions.createPane(PANE_ID, { role: "primary-agent" });
    background.calls.length = 0;
    openOverlay(background);

    await background.runManagedLaunchAttempt(PANE_ID, { ...TARGET, background: true });

    expect(background.prepareCalls).toEqual([]);
    expect(background.calls).toEqual([]);
    expect(selectStationOverlayVisible(background.store.getState())).toBe(true);
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
      kind: "preparation-failed",
      error: {
        tag: "ClientObserverError",
        code: "CLIENT_OBSERVER_OPERATION_FAILED",
        message: "The Station could not complete the observer operation.",
      },
    });
    expect(retry).toEqual({ kind: "settled" });
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

    expect(result).toEqual({ kind: "settled" });
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
    expect(selectStationOverlayVisible(harness.store.getState())).toBe(false);
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

    expect(selectStationOverlayVisible(harness.store.getState())).toBe(false);
    expect(
      harness.store
        .getState()
        .workspace.panes.some((pane) => pane.id === PANE_ID && pane.role === "primary-agent"),
    ).toBe(true);
    expect(harness.stationViewStore.getState().toasts).toEqual([]);
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
