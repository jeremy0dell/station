import { describe, expect, it } from "bun:test";
import { dashboardRowIds } from "@station/dashboard-core/selectors";
import { selectActivePaneId, selectStationOverlayVisible } from "../state/selectors.js";
import { createStationStore } from "../state/store.js";
import {
  agentWorktreePaneId,
  MAIN_PANE_ID,
  STATION_OVERLAY_ID,
  worktreePaneId,
  type PaneId,
  type PaneRecord,
} from "../state/types.js";
import type { Automation } from "../config/stationConfig.js";
import { createPtyRegistry, type PtyRegistry } from "../terminal/registry/ptyRegistry.js";
import type { StationTerminalProcess, StationTerminalSpawnOptions } from "../terminal/types.js";
import { createScriptedTerminal } from "../terminal/testing/scriptedTerminal.js";
import { waitFor } from "../terminal/testing/waitFor.js";
import {
  externalAgentSnapshot,
  groupedManyProjectsSnapshot,
  manyProjectsSnapshot,
} from "../station/fixtures/scenarios.js";
import type { StationSnapshot } from "@station/contracts";
import { FakeTuiObserverService } from "../station/test/support/fakeObserverService.js";
import { FakeStationSource } from "../station/test/support/fakeStationSource.js";
import {
  createStationTestDashboardRuntime,
  type StationTestDashboardRuntime,
} from "../station/test/support/makeStationTestRuntime.js";
import { createDashboardCapabilities } from "../app/dashboardCapabilities.js";
import { createPaneEffects } from "./runtime/paneEffects.js";
import type { ManagedLaunch } from "./runtime/managedLaunch.js";
import type { StationMouseEvent } from "./mouse.js";
import { createStationInputRuntime } from "./stationInput.js";

const TMUX_STARTUP_BURST =
  "\x1b]10;rgb:ffff/ffff/ffff\x07" +
  "\x1b]11;rgb:2828/2c2c/3434\x07" +
  "\x1bP>|tmux 3.6b\x1b\\" +
  "\x1b[7;1R\x1b[1;1R\x1b[1;1R" +
  "\x1b[?997;1n" +
  "\x1b[4;2040;2704t";

const LEFT_DOWN: StationMouseEvent = {
  type: "down",
  button: "left",
  rawButton: 0,
  x: 4,
  y: 2,
  modifiers: { shift: false, alt: false, ctrl: false },
};

const RIGHT_DOWN: StationMouseEvent = {
  ...LEFT_DOWN,
  button: "right",
  rawButton: 2,
};

// A hover (mouse move) used to move the context-menu selection onto a row.
const HOVER: StationMouseEvent = { ...LEFT_DOWN, type: "move" };

const wheel = (direction: "up" | "down"): StationMouseEvent => ({
  type: "scroll",
  button: direction === "up" ? "wheel-up" : "wheel-down",
  rawButton: direction === "up" ? 64 : 65,
  x: 4,
  y: 2,
  modifiers: { shift: false, alt: false, ctrl: false },
  scrollDirection: direction,
});

describe("createStationInputRuntime", () => {
  function harness(options?: {
    pasteToTerminal?: (paneId: PaneId, text: string) => boolean;
    dashboardRuntime?: StationTestDashboardRuntime;
    automations?: readonly Automation[];
  }) {
    const scripted = createScriptedTerminal();
    const registry = createPtyRegistry({ createTerminal: () => scripted.terminal });
    // First resize spawns the scripted PTY for the initially-focused pane.
    registry.resize(MAIN_PANE_ID, { cols: 36, rows: 8 });
    const store = createStationStore();
    let shutdowns = 0;
    const runtime = createStationInputRuntime({
      store,
      shutdown: () => {
        shutdowns += 1;
      },
      registry,
      pasteToTerminal: options?.pasteToTerminal,
      ...(options?.dashboardRuntime === undefined ? {} : { dashboardRuntime: options.dashboardRuntime }),
      automations: options?.automations,
    });
    return { runtime, scripted, store, registry, shutdowns: () => shutdowns };
  }

  it("consumes outer-terminal reply bursts instead of typing them into the shell", () => {
    const { runtime, scripted } = harness();
    expect(runtime.handleSequence(TMUX_STARTUP_BURST)).toBe(true);
    expect(scripted.helpers.writes.length).toBe(0);
  });

  it("forwards the keystroke remainder of a mixed burst", () => {
    const { runtime, scripted } = harness();
    expect(runtime.handleSequence(`x\x1b[1;1R`)).toBe(true);
    expect(scripted.helpers.writes.join("")).toBe("x");
  });

  it("still matches chords delivered in kitty form", () => {
    const { runtime, scripted, store, shutdowns } = harness();
    expect(runtime.handleSequence("\x1b[113;5u")).toBe(true); // Ctrl-Q
    expect(shutdowns()).toBe(1);
    expect(runtime.handleSequence("\x1b[111;5u")).toBe(true); // Ctrl-O
    expect(selectStationOverlayVisible(store.getState())).toBe(true);
    expect(scripted.helpers.writes.length).toBe(0);
  });

  it("forwards ordinary typing", () => {
    const { runtime, scripted } = harness();
    runtime.handleSequence("l");
    runtime.handleSequence("s");
    runtime.handleSequence("\r");
    expect(scripted.helpers.writes.join("")).toBe("ls\r");
  });

  it("sends xterm Shift+Enter as CR until the focused pane negotiates kitty keyboard protocol", async () => {
    const { runtime, scripted, registry } = harness();
    // Default focus is the shell main pane: Shift+Enter de-escalates to a CR so
    // a plain shell (no kitty mode) submits as before.
    expect(runtime.handleSequence("\x1b[27;2;13~")).toBe(true);
    expect(scripted.helpers.writes.join("")).toBe("\r");

    scripted.helpers.emitData("\x1b[>1u");
    await waitFor(
      () => registry.get(MAIN_PANE_ID)?.screen?.isKittyKeyboardEnabled() === true,
    );
    scripted.helpers.writes.length = 0;
    expect(runtime.handleSequence("\x1b[27;2;13~")).toBe(true);
    expect(scripted.helpers.writes.join("")).toBe("\x1b[13;2u");
  });

  // Plain loop, not it.each: bun's bundled `it` type has no `.each`, so the
  // station-bun typecheck step rejects it even though it runs.
  for (const provider of ["codex", "pi"] as const) {
    it(`preserves xterm Shift+Enter for a warm-attached ${provider} primary-agent pane`, () => {
      const baseSnapshot = manyProjectsSnapshot();
      const snapshot = {
        ...baseSnapshot,
        sessions: baseSnapshot.sessions.map((session) => ({
          ...session,
          harness: {
            ...session.harness,
            provider,
            capabilities: {
              ...session.harness.capabilities,
              supportsModifiedEnterSoftNewline: session.id === "ses_wt_station_idle",
            },
          },
        })),
      };
      const dashboardRuntime = createStationTestDashboardRuntime({
        source: new FakeStationSource(snapshot),
        service: new FakeTuiObserverService(snapshot),
        initialSnapshot: snapshot,
        persistentPopup: true,
        onDismiss: async () => {},
      });
      const { runtime, scripted, store, registry } = harness({ dashboardRuntime });
      const paneId = agentWorktreePaneId("wt_station_idle");
      store.actions.createPane(paneId, { role: "primary-agent" });
      store.actions.setPrimaryAgent(paneId, {
        sessionId: "ses_wt_station_idle",
        terminalTargetId: "native:wt_station_idle",
        harnessProvider: provider,
      });
      store.actions.focusPane(paneId);
      registry.resize(paneId, { cols: 36, rows: 8 });

      expect(runtime.handleSequence("\x1b[27;2;13~")).toBe(true);
      expect(scripted.helpers.writes.join("")).toBe("\x1b[13;2u");
    });
  }

  it("reads modified-enter capability from client truth when dashboard projection is stale", () => {
    const base = manyProjectsSnapshot();
    const stale: StationSnapshot = {
      ...base,
      sessions: base.sessions.map((session) => ({
        ...session,
        harness: {
          ...session.harness,
          capabilities: {
            ...session.harness.capabilities,
            supportsModifiedEnterSoftNewline: false,
          },
        },
      })),
    };
    const canonical: StationSnapshot = {
      ...stale,
      sessions: stale.sessions.map((session) => ({
        ...session,
        harness: {
          ...session.harness,
          capabilities: {
            ...session.harness.capabilities,
            supportsModifiedEnterSoftNewline: session.id === "ses_wt_station_idle",
          },
        },
      })),
    };
    const source = new FakeStationSource(stale);
    const dashboardRuntime = createStationTestDashboardRuntime({
      source,
      service: new FakeTuiObserverService(stale),
      persistentPopup: true,
      onDismiss: async () => {},
    });
    source.setSnapshot(canonical);
    const { runtime, scripted, store, registry } = harness({ dashboardRuntime });
    const paneId = agentWorktreePaneId("wt_station_idle");
    store.actions.createPane(paneId, { role: "primary-agent" });
    store.actions.setPrimaryAgent(paneId, {
      sessionId: "ses_wt_station_idle",
      terminalTargetId: "native:wt_station_idle",
      harnessProvider: "codex",
    });
    store.actions.focusPane(paneId);
    registry.resize(paneId, { cols: 36, rows: 8 });

    expect(
      dashboardRuntime.state.getState().snapshot?.sessions.find(
        (session) => session.id === "ses_wt_station_idle",
      )?.harness.capabilities.supportsModifiedEnterSoftNewline,
    ).toBe(false);
    expect(runtime.handleSequence("\x1b[27;2;13~")).toBe(true);
    expect(scripted.helpers.writes.join("")).toBe("\x1b[13;2u");
  });

  it("matches arrow-key bytes to the focused pane's cursor-key mode", async () => {
    const { runtime, scripted, registry } = harness();
    scripted.helpers.emitData("\x1b[?1h");
    await waitFor(
      () => registry.get(MAIN_PANE_ID)?.screen?.isApplicationCursorKeys() === true,
    );

    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(scripted.helpers.writes.join("")).toBe("\x1bOB");

    scripted.helpers.emitData("\x1b[?1l");
    await waitFor(
      () => registry.get(MAIN_PANE_ID)?.screen?.isApplicationCursorKeys() === false,
    );
    scripted.helpers.writes.length = 0;

    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(scripted.helpers.writes.join("")).toBe("\x1b[B");
  });

  it("swallows typing while the overlay is open but keeps exit and toggle live", () => {
    const { runtime, scripted, store, shutdowns } = harness();
    store.actions.openOverlay(STATION_OVERLAY_ID);
    expect(runtime.handleSequence("a")).toBe(true);
    expect(scripted.helpers.writes.length).toBe(0);
    expect(runtime.handleSequence("\x11")).toBe(true); // Ctrl-Q pierces the swallow
    expect(shutdowns()).toBe(1);
    expect(runtime.handleSequence("\x0f")).toBe(true); // Ctrl-O closes
    expect(selectStationOverlayVisible(store.getState())).toBe(false);
  });

  it("returns false for typing when the focused pane has no live terminal, true for chords", () => {
    const { runtime, registry, shutdowns } = harness();
    registry.dispose(MAIN_PANE_ID);
    expect(runtime.handleSequence("a")).toBe(false);
    expect(runtime.handleSequence("\x11")).toBe(true);
    expect(shutdowns()).toBe(1);
  });

  it("toggles the overlay through header mouse dispatch and typing still flows after", () => {
    const { runtime, scripted, store } = harness();
    expect(runtime.dispatchMouse({ kind: "header" }, LEFT_DOWN)).toBe(true);
    expect(selectStationOverlayVisible(store.getState())).toBe(true);
    expect(runtime.dispatchMouse({ kind: "header" }, LEFT_DOWN)).toBe(true);
    expect(selectStationOverlayVisible(store.getState())).toBe(false);
    runtime.handleSequence("x");
    expect(scripted.helpers.writes.join("")).toBe("x");
  });

  it("opens STATION from welcome keys and swallows ordinary input", () => {
    const store = createStationStore({ boot: "empty" });
    let shutdowns = 0;
    const runtime = createStationInputRuntime({
      store,
      shutdown: () => {
        shutdowns += 1;
      },
    });

    expect(runtime.handleSequence("x")).toBe(true);
    expect(selectStationOverlayVisible(store.getState())).toBe(false);

    expect(runtime.handleSequence("\r")).toBe(true);
    expect(selectStationOverlayVisible(store.getState())).toBe(true);

    store.actions.closeOverlay();
    expect(runtime.handleSequence(" ")).toBe(true);
    expect(selectStationOverlayVisible(store.getState())).toBe(true);

    store.actions.closeOverlay();
    expect(runtime.handleSequence("\x0f")).toBe(true);
    expect(selectStationOverlayVisible(store.getState())).toBe(true);

    store.actions.closeOverlay();
    expect(runtime.handleSequence("\x11")).toBe(true);
    expect(shutdowns).toBe(1);
  });

  it("opens STATION from the welcome CTA mouse target", () => {
    const store = createStationStore({ boot: "empty" });
    const runtime = createStationInputRuntime({ store, shutdown: () => {} });

    expect(runtime.dispatchMouse({ kind: "welcomeOpenProjectView" }, LEFT_DOWN)).toBe(true);

    expect(selectStationOverlayVisible(store.getState())).toBe(true);
    expect(store.getState().input.overlayReturnFocus).toBeNull();
  });

  it("opens a pane context menu on right-click and closes it with Esc", () => {
    const { runtime, store } = harness();

    expect(runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, RIGHT_DOWN)).toBe(true);
    expect(store.getState().input.contextMenu).toMatchObject({
      target: { kind: "pane", paneId: MAIN_PANE_ID },
      anchor: { x: 4, y: 2 },
      activeItemId: "pane.splitRight",
    });
    expect(store.getState().input.focus).toEqual({ kind: "contextMenu" });

    expect(runtime.handleSequence("\x1b")).toBe(true);
    expect(store.getState().input.contextMenu).toBeNull();
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
  });

  it("moves and selects context menu items through the keyboard layer", () => {
    const { runtime, store } = harness();
    store.actions.createPane("pane-second");
    expect(runtime.dispatchMouse({ kind: "pane", paneId: "pane-second" }, RIGHT_DOWN)).toBe(true);

    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(store.getState().input.contextMenu?.activeItemId).toBe("pane.close");
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual([MAIN_PANE_ID]);
    expect(store.getState().input.contextMenu).toBeNull();
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
  });

  it("context-menu Rename from a primary-agent pane opens directly and Esc closes to the dashboard", () => {
    const snapshot = manyProjectsSnapshot();
    const dashboardRuntime = createStationTestDashboardRuntime({
      source: new FakeStationSource(snapshot),
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
    });
    const { runtime, store } = harness({ dashboardRuntime });
    const paneId = agentWorktreePaneId("wt_station_idle");
    store.actions.createPane(paneId, { role: "primary-agent" });
    store.actions.setPrimaryAgent(paneId, {
      sessionId: "ses_wt_station_idle",
      terminalTargetId: "native:wt_station_idle",
    });

    expect(runtime.dispatchMouse({ kind: "pane", paneId }, RIGHT_DOWN)).toBe(true);
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(store.getState().input.contextMenu).toBeNull();
    expect(selectStationOverlayVisible(store.getState())).toBe(true);
    expect(dashboardRuntime.state.getState().screen).toMatchObject({
      name: "renameSession",
      step: "editName",
      rowId: "ses_wt_station_idle",
      returnTo: "dashboard",
    });

    expect(runtime.handleSequence("\x1b")).toBe(true);
    expect(dashboardRuntime.state.getState().screen).toEqual({ name: "dashboard" });
  });

  it("runs an automation: splits a shell pane and executes its command with a trailing Enter", async () => {
    const automation: Automation = {
      id: "see-diff",
      label: "See diff (split right)",
      enabled: true,
      steps: [
        { split: "right", anchor: "origin", command: "echo automation", run: "execute", focus: true },
      ],
    };
    const { runtime, scripted, store, registry } = harness({ automations: [automation] });
    // Right-click the main pane, then pick the automation. It sits after the two
    // split actions, so it is selected explicitly by identity, not by default Enter.
    runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, RIGHT_DOWN);
    runtime.dispatchMouse(
      { kind: "contextMenuItemHover", itemId: "pane.automation.see-diff" },
      HOVER,
    );
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual([
      MAIN_PANE_ID,
      "pane-split-0",
    ]);
    expect(store.getState().workspace.panes.find((pane) => pane.id === "pane-split-0")?.split).toEqual(
      { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    );
    expect(selectActivePaneId(store.getState())).toBe("pane-split-0");
    // The command is held until the pane's PTY spawns on first layout/resize.
    expect(scripted.helpers.writes).not.toContain("echo automation\r");

    registry.resize("pane-split-0", { cols: 36, rows: 8 });
    await waitFor(() => scripted.helpers.writes.includes("echo automation\r"));
    // Executed with a trailing CR — Station's Enter byte, not a bare LF.
    expect(scripted.helpers.writes).toContain("echo automation\r");
  });

  it("writes (without Enter) a step whose run mode is write, leaving it for the user to submit", async () => {
    const automation: Automation = {
      id: "stage-prompt",
      label: "Stage prompt",
      enabled: true,
      steps: [{ split: "below", anchor: "origin", command: 'claude "hi"', run: "write", focus: false }],
    };
    const { runtime, scripted, registry } = harness({ automations: [automation] });
    runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, RIGHT_DOWN);
    runtime.dispatchMouse(
      { kind: "contextMenuItemHover", itemId: "pane.automation.stage-prompt" },
      HOVER,
    );
    expect(runtime.handleSequence("\r")).toBe(true);

    registry.resize("pane-split-0", { cols: 36, rows: 8 });
    await waitFor(() => scripted.helpers.writes.includes('claude "hi"'));
    // Written, not executed: the exact command with no trailing Enter (CR).
    expect(scripted.helpers.writes).toContain('claude "hi"');
    expect(scripted.helpers.writes).not.toContain('claude "hi"\r');
  });

  it("chains a multi-step automation: each previous-anchored step splits off the prior pane", () => {
    const automation: Automation = {
      id: "triage",
      label: "Triage",
      enabled: true,
      steps: [
        { split: "right", anchor: "origin", command: "a", run: "execute", focus: false },
        { split: "below", anchor: "previous", command: "b", run: "write", focus: true },
      ],
    };
    const { runtime, store } = harness({ automations: [automation] });
    runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, RIGHT_DOWN);
    runtime.dispatchMouse(
      { kind: "contextMenuItemHover", itemId: "pane.automation.triage" },
      HOVER,
    );
    expect(runtime.handleSequence("\r")).toBe(true);

    const panes = store.getState().workspace.panes;
    expect(panes.map((pane) => pane.id)).toEqual([MAIN_PANE_ID, "pane-split-0", "pane-split-1"]);
    expect(panes.find((pane) => pane.id === "pane-split-0")?.split).toEqual({
      anchorPaneId: MAIN_PANE_ID,
      direction: "right",
    });
    expect(panes.find((pane) => pane.id === "pane-split-1")?.split).toEqual({
      anchorPaneId: "pane-split-0",
      direction: "below",
    });
    // focus: true on the second step wins over the default last-pane focus.
    expect(selectActivePaneId(store.getState())).toBe("pane-split-1");
  });

  it("drops a queued automation command when the pane is closed before it lays out", () => {
    const automation: Automation = {
      id: "see-diff",
      label: "See diff (split right)",
      enabled: true,
      steps: [
        { split: "right", anchor: "origin", command: "echo automation", run: "execute", focus: true },
      ],
    };
    const { runtime, scripted, registry } = harness({ automations: [automation] });
    runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, RIGHT_DOWN);
    runtime.dispatchMouse(
      { kind: "contextMenuItemHover", itemId: "pane.automation.see-diff" },
      HOVER,
    );
    expect(runtime.handleSequence("\r")).toBe(true);

    // The split pane never laid out (no resize), so its PTY never spawned. Closing
    // it disposes the registry entry and notifies sendWhenReady, which finds the
    // entry gone, stops listening, and never writes the command into a dead pane.
    registry.dispose("pane-split-0");

    expect(scripted.helpers.writes).not.toContain("echo automation\r");
  });

  it("drops a queued automation command when its pane never lays out before the timeout", () => {
    const automation: Automation = {
      id: "see-diff",
      label: "See diff (split right)",
      enabled: true,
      steps: [
        { split: "right", anchor: "origin", command: "echo automation", run: "execute", focus: true },
      ],
    };
    // Fire the 10s send-timeout (the registry-subscription leak guard) deterministically
    // instead of waiting AUTOMATION_SEND_TIMEOUT_MS; sub-second debounce/settle timers pass through.
    const realSetTimeout = globalThis.setTimeout;
    const longTimers: Array<() => void> = [];
    globalThis.setTimeout = ((
      callback: (...callbackArgs: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (typeof ms === "number" && ms >= 5000) {
        longTimers.push(() => callback(...rest));
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(callback, ms, ...rest);
    }) as typeof globalThis.setTimeout;
    try {
      const { runtime, scripted, registry } = harness({ automations: [automation] });
      runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, RIGHT_DOWN);
      runtime.dispatchMouse(
        { kind: "contextMenuItemHover", itemId: "pane.automation.see-diff" },
        HOVER,
      );
      expect(runtime.handleSequence("\r")).toBe(true);

      expect(longTimers).toHaveLength(1);
      for (const fire of longTimers) {
        fire();
      }

      // A layout arriving after the timeout finds no subscriber: the command is dropped.
      registry.resize("pane-split-0", { cols: 36, rows: 8 });
      expect(scripted.helpers.writes).not.toContain("echo automation\r");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it("focuses a pane on a primary click through the focus outcome", () => {
    const { runtime, store } = harness();
    store.actions.createPane("pane-second");
    store.actions.focusPane("pane-second");
    expect(selectActivePaneId(store.getState())).toBe("pane-second");

    expect(runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, LEFT_DOWN)).toBe(true);
    expect(selectActivePaneId(store.getState())).toBe(MAIN_PANE_ID);
  });

  it("ignores an overlay paste that sanitizes to nothing", () => {
    const snapshot = manyProjectsSnapshot();
    const dashboardRuntime = createStationTestDashboardRuntime({
      source: new FakeStationSource(snapshot),
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
    });
    const { runtime, store } = harness({ dashboardRuntime });
    store.actions.openOverlay(STATION_OVERLAY_ID);
    const before = dashboardRuntime.state.getState().screen;

    let prevented = false;
    runtime.handlePaste({
      bytes: new TextEncoder().encode("\x00\x01\x02"),
      preventDefault: () => {
        prevented = true;
      },
    });

    // The overlay claims the paste (preventDefault) but a control-only chunk
    // sanitizes to empty, so nothing reaches the dashboard machine.
    expect(prevented).toBe(true);
    expect(dashboardRuntime.state.getState().screen).toEqual(before);
  });

  it("highlights a context menu item on hover via mouse dispatch", () => {
    const { runtime, store } = harness();
    store.actions.createPane("pane-second");
    expect(runtime.dispatchMouse({ kind: "pane", paneId: "pane-second" }, RIGHT_DOWN)).toBe(true);
    expect(store.getState().input.contextMenu?.activeItemId).toBe("pane.splitRight");

    const hover: StationMouseEvent = { ...LEFT_DOWN, type: "move" };
    expect(
      runtime.dispatchMouse({ kind: "contextMenuItemHover", itemId: "pane.close" }, hover),
    ).toBe(true);
    expect(store.getState().input.contextMenu?.activeItemId).toBe("pane.close");
  });

  it("does not activate a fallback when a pointer identity is stale", () => {
    const { runtime, store } = harness();
    runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, RIGHT_DOWN);

    expect(
      runtime.dispatchMouse(
        { kind: "contextMenuItem", itemId: "station.renameSession" },
        LEFT_DOWN,
      ),
    ).toBe(true);

    expect(store.getState().workspace.panes).toHaveLength(1);
    expect(store.getState().input.contextMenu).not.toBeNull();
  });

  it("closes the context menu before Ctrl-O can toggle the overlay underneath", () => {
    const { runtime, store } = harness();
    runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, RIGHT_DOWN);

    expect(runtime.handleSequence("\x0f")).toBe(true);

    expect(store.getState().input.contextMenu).toBeNull();
    expect(selectStationOverlayVisible(store.getState())).toBe(false);
  });

  it("blocks paste while the context menu is focused", () => {
    const delivered: string[] = [];
    const { runtime, store } = harness({
      pasteToTerminal: (_paneId, text) => {
        delivered.push(text);
        return true;
      },
    });
    runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, RIGHT_DOWN);
    let prevented = 0;

    runtime.handlePaste({
      bytes: new TextEncoder().encode("blocked"),
      preventDefault: () => {
        prevented += 1;
      },
    });

    expect(prevented).toBe(1);
    expect(delivered).toEqual([]);
    expect(store.getState().input.contextMenu !== null).toBe(true);
  });

  it("prevents default only when a paste was actually delivered", () => {
    const delivered: string[] = [];
    const { runtime, store } = harness({
      pasteToTerminal: (_paneId, text) => {
        delivered.push(text);
        return true;
      },
    });
    let prevented = 0;
    const pasteEvent = (text: string) => ({
      bytes: new TextEncoder().encode(text),
      preventDefault: () => {
        prevented += 1;
      },
    });

    runtime.handlePaste(pasteEvent("hello"));
    expect(delivered).toEqual(["hello"]);
    expect(prevented).toBe(1);

    store.actions.openOverlay(STATION_OVERLAY_ID);
    runtime.handlePaste(pasteEvent("blocked"));
    expect(delivered).toEqual(["hello"]);
    expect(prevented).toBe(1);
  });

  it("leaves the paste event un-prevented when the focused pane has no live terminal", () => {
    const { runtime, registry } = harness();
    registry.dispose(MAIN_PANE_ID); // registry routing returns false with no live pane
    let prevented = 0;
    runtime.handlePaste({
      bytes: new TextEncoder().encode("orphan"),
      preventDefault: () => {
        prevented += 1;
      },
    });
    expect(prevented).toBe(0);
  });

  describe("pane scrolling", () => {
    const manyLines = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\r\n");

    it("scrolls the pane's scrollback on a wheel tick in the normal buffer", async () => {
      const { runtime, registry, scripted } = harness();
      const screen = registry.get(MAIN_PANE_ID)?.screen;
      expect(screen == null).toBe(false);
      scripted.helpers.emitData(manyLines);
      await screen?.whenIdle();

      expect(runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, wheel("up"))).toBe(true);
      expect(screen?.getScrollOffset()).toBe(3);
      runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, wheel("down"));
      expect(screen?.getScrollOffset()).toBe(0);
    });

    it("forwards the wheel as arrow keys to an alt-screen pager", async () => {
      const { runtime, registry, scripted } = harness();
      const screen = registry.get(MAIN_PANE_ID)?.screen;
      scripted.helpers.emitData("\x1b[?1049h");
      await screen?.whenIdle();
      const before = scripted.helpers.writes.length;

      expect(runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, wheel("down"))).toBe(true);
      expect(scripted.helpers.writes.slice(before).join("")).toBe("\x1b[B\x1b[B\x1b[B");
      expect(screen?.getScrollOffset()).toBe(0);
    });

    it("forwards the wheel as an SGR wheel event to a mouse-reporting app", async () => {
      const { runtime, registry, scripted } = harness();
      const screen = registry.get(MAIN_PANE_ID)?.screen;
      // Negotiate SGR (1006) alongside mouse reporting (1000) so the wheel
      // forward stays on the SGR path this test asserts; without 1006 the app
      // is on legacy encoding and the report would be legacy-encoded instead.
      scripted.helpers.emitData("\x1b[?1000h\x1b[?1006h");
      await screen?.whenIdle();
      const before = scripted.helpers.writes.length;

      expect(runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, wheel("up"))).toBe(true);
      // Synthetic wheel aimed at the center of the 36x8 pane.
      expect(scripted.helpers.writes.slice(before).join("")).toBe("\x1b[<64;18;4M");
    });

    it("snaps a scrolled-back pane to the bottom when the user types", async () => {
      const { runtime, registry, scripted } = harness();
      const screen = registry.get(MAIN_PANE_ID)?.screen;
      scripted.helpers.emitData(manyLines);
      await screen?.whenIdle();
      runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, wheel("up"));
      expect(screen?.getScrollOffset()).toBe(3);

      runtime.handleSequence("x");
      expect(screen?.getScrollOffset()).toBe(0);
    });
  });
});

describe("createStationInputRuntime open-pane wiring", () => {
  const WORKTREE_ID = "wt_station_idle";
  const SESSION_ID = "ses_wt_station_idle";
  const PANE_ID = worktreePaneId(WORKTREE_ID);
  const CWD = "/Users/example/.worktrees/station/pty-buffer";
  const managedLaunch: ManagedLaunch = {
    activate: async () => ({ kind: "success", landed: true }),
    create: async () => ({ kind: "success", landed: false }),
    fork: async () => ({ kind: "success", landed: false }),
  };

  function paneHarness(options?: {
    autoCloseOverlayOnPaneOpen?: boolean;
    storeOptions?: Parameters<typeof createStationStore>[0];
  }) {
    const snapshot = manyProjectsSnapshot();
    const source = new FakeStationSource(snapshot);
    const service = new FakeTuiObserverService(snapshot);
    const scripted = createScriptedTerminal();
    const base = createPtyRegistry({ createTerminal: () => scripted.terminal });
    const calls: string[] = [];
    const registry: PtyRegistry = {
      ...base,
      ensure: (paneId, spawnOptions) => {
        calls.push(`ensure:${paneId}:${spawnOptions?.cwd ?? ""}`);
        return base.ensure(paneId, spawnOptions);
      },
    };
    const store = createStationStore(options?.storeOptions);
    const originalCreate = store.actions.createPane;
    store.actions.createPane = (paneId, createOptions) => {
      calls.push(
        `createPane:${paneId}:${createOptions?.split?.anchorPaneId ?? ""}:${createOptions?.split?.direction ?? ""}`,
      );
      originalCreate(paneId, createOptions);
    };
    const originalReveal = store.actions.revealPane;
    store.actions.revealPane = (paneId) => {
      calls.push(`revealPane:${paneId}`);
      originalReveal(paneId);
    };
    const paneEffects = createPaneEffects({
      store,
      clientState: source,
      registry,
      resolveAuxShellPlacement: undefined,
      autoCloseOverlay: options?.autoCloseOverlayOnPaneOpen ?? false,
      automations: [],
      writeToTerminal: undefined,
      pasteToTerminal: undefined,
    });
    const dashboardRuntime = createStationTestDashboardRuntime({
      source,
      service,
      initialSnapshot: snapshot,
      capabilities: createDashboardCapabilities({
        clientState: source,
        observerService: service,
        store,
        paneEffects,
        registry,
        managedLaunch,
      }),
    });
    const runtime = createStationInputRuntime({
      store,
      shutdown: () => {},
      dashboardRuntime,
      registry,
      paneEffects,
    });
    const clickRowShell = (): boolean =>
      runtime.dispatchMouse(
        { kind: "station", target: { kind: "openShellForRow", rowId: SESSION_ID } },
        LEFT_DOWN,
      );
    return { runtime, store, calls, clickRowShell };
  }

  it("ensures a row shell with its cwd before adding it beside the active pane", () => {
    const { store, calls, clickRowShell } = paneHarness();
    store.actions.openOverlay(STATION_OVERLAY_ID);

    expect(clickRowShell()).toBe(true);
    expect(calls).toEqual([
      `ensure:${PANE_ID}:${CWD}`,
      `createPane:${PANE_ID}:${MAIN_PANE_ID}:right`,
    ]);
    expect(store.getState().workspace.panes.some((pane) => pane.id === PANE_ID)).toBe(true);
  });

  it("tiles a row shell into a restored layout with no active pane", () => {
    const existing = "pane-restored";
    const { store, calls, clickRowShell } = paneHarness({
      storeOptions: {
        initialWorkspace: {
          panes: [{ id: existing, split: null, role: "shell" }],
          activePaneId: null,
        },
      },
    });
    store.actions.openOverlay(STATION_OVERLAY_ID);

    expect(clickRowShell()).toBe(true);
    expect(calls).toContain(`createPane:${PANE_ID}:${existing}:right`);
    expect(store.getState().workspace.panes.find((pane) => pane.id === PANE_ID)?.split).toEqual({
      anchorPaneId: existing,
      direction: "right",
    });
  });

  it("dismisses the boot intro into a restored session from mouse and Enter", () => {
    for (const activate of [
      (runtime: ReturnType<typeof paneHarness>["runtime"]) =>
        runtime.dispatchMouse({ kind: "welcomeContinue" }, LEFT_DOWN),
      (runtime: ReturnType<typeof paneHarness>["runtime"]) => runtime.handleSequence("\r"),
    ]) {
      const { runtime, store } = paneHarness({
        storeOptions: {
          initialWorkspace: {
            panes: [{ id: "pane-a", split: null, role: "shell" }],
            activePaneId: "pane-a",
          },
          welcomeIntroOnBoot: true,
        },
      });

      expect(activate(runtime)).toBe(true);
      expect(store.getState().input.introVisible).toBe(false);
      expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: "pane-a" });
    }
  });

  it("reveals a reused row shell and keeps the overlay queued to it", () => {
    const { store, calls, clickRowShell } = paneHarness();
    store.actions.openOverlay(STATION_OVERLAY_ID);

    clickRowShell();
    clickRowShell();

    expect(calls).toEqual([
      `ensure:${PANE_ID}:${CWD}`,
      `createPane:${PANE_ID}:${MAIN_PANE_ID}:right`,
      `revealPane:${PANE_ID}`,
    ]);
    expect(store.getState().workspace.panes.filter((pane) => pane.id === PANE_ID)).toHaveLength(1);
    expect(selectStationOverlayVisible(store.getState())).toBe(true);
    expect(selectActivePaneId(store.getState())).toBe(PANE_ID);
    expect(store.getState().input.overlayReturnFocus).toEqual({ kind: "pane", paneId: PANE_ID });
  });

  it("auto-closes the overlay onto a row shell only when configured", () => {
    const { store, clickRowShell } = paneHarness({ autoCloseOverlayOnPaneOpen: true });
    store.actions.openOverlay(STATION_OVERLAY_ID);

    clickRowShell();

    expect(selectStationOverlayVisible(store.getState())).toBe(false);
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: PANE_ID });
  });

  it("opens a row shell beside its primary agent pane", () => {
    const { store, calls, clickRowShell } = paneHarness();
    const agentPaneId = agentWorktreePaneId(WORKTREE_ID);
    store.actions.createPane(agentPaneId, { role: "primary-agent" });
    store.actions.setPrimaryAgent(agentPaneId, {
      sessionId: "ses_managed",
      terminalTargetId: "native:wt_station_idle",
    });
    store.actions.openOverlay(STATION_OVERLAY_ID);

    expect(clickRowShell()).toBe(true);
    expect(calls).toContain(`createPane:${PANE_ID}:${agentPaneId}:right`);
    expect(store.getState().workspace.panes.find((pane) => pane.id === PANE_ID)?.split).toEqual({
      anchorPaneId: agentPaneId,
      direction: "right",
    });
  });

  it("passes STATION link clicks to the external URL opener", () => {
    const snapshot = manyProjectsSnapshot();
    const dashboardRuntime = createStationTestDashboardRuntime({
      source: new FakeStationSource(snapshot),
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
    });
    const store = createStationStore();
    const opened: string[] = [];
    const runtime = createStationInputRuntime({
      store,
      shutdown: () => {},
      dashboardRuntime,
      openExternalUrl: (url) => opened.push(url),
    });
    const url = "https://github.com/example/station/pull/73";
    store.actions.openOverlay(STATION_OVERLAY_ID);

    expect(runtime.dispatchMouse({ kind: "station", target: { kind: "link", url } }, LEFT_DOWN)).toBe(
      true,
    );
    expect(opened).toEqual([url]);
    expect(selectStationOverlayVisible(store.getState())).toBe(true);
  });

  it("preserves the row cwd through the reconciler's no-option ensure", () => {
    const snapshot = manyProjectsSnapshot();
    const scripted = createScriptedTerminal();
    const spawns: Array<{ paneCwd: string | undefined }> = [];
    const registry = createPtyRegistry({
      createTerminal: (options) => {
        spawns.push({ paneCwd: options.cwd });
        return scripted.terminal;
      },
    });
    const source = new FakeStationSource(snapshot);
    const service = new FakeTuiObserverService(snapshot);
    const store = createStationStore();
    const paneEffects = createPaneEffects({
      store,
      clientState: source,
      registry,
      resolveAuxShellPlacement: undefined,
      autoCloseOverlay: false,
      automations: [],
      writeToTerminal: undefined,
      pasteToTerminal: undefined,
    });
    const dashboardRuntime = createStationTestDashboardRuntime({
      source,
      service,
      initialSnapshot: snapshot,
      capabilities: createDashboardCapabilities({
        clientState: source,
        observerService: service,
        store,
        paneEffects,
        registry,
        managedLaunch,
      }),
    });
    let lastPanes: readonly PaneRecord[] | undefined;
    const reconcile = (): void => {
      const panes = store.getState().workspace.panes;
      if (panes === lastPanes) return;
      lastPanes = panes;
      for (const pane of panes) registry.ensure(pane.id);
      for (const entry of registry.entries()) {
        if (!panes.some((pane) => pane.id === entry.paneId)) registry.dispose(entry.paneId);
      }
    };
    store.subscribe(reconcile);
    reconcile();
    const runtime = createStationInputRuntime({
      store,
      shutdown: () => {},
      dashboardRuntime,
      registry,
      paneEffects,
    });

    store.actions.openOverlay(STATION_OVERLAY_ID);
    runtime.dispatchMouse(
      { kind: "station", target: { kind: "openShellForRow", rowId: SESSION_ID } },
      LEFT_DOWN,
    );
    registry.resize(PANE_ID, { cols: 80, rows: 24 });

    expect(spawns.map((spawn) => spawn.paneCwd)).toContain(CWD);
  });
});

describe("createStationInputRuntime STATION context-menu actions", () => {
  function contextMenuHarness(snapshot: StationSnapshot = manyProjectsSnapshot()) {
    const service = new FakeTuiObserverService(snapshot);
    const dashboardRuntime = createStationTestDashboardRuntime({
      source: new FakeStationSource(snapshot),
      service,
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
    });
    const store = createStationStore();
    const runtime = createStationInputRuntime({
      store,
      shutdown: () => {},
      dashboardRuntime,
    });
    store.actions.openOverlay(STATION_OVERLAY_ID);
    const rightClickRow = (rowId = "ses_wt_station_idle"): boolean =>
      runtime.dispatchMouse(
        {
          kind: "station",
          target: {
            kind: "dashboardCell",
            rowId: dashboardRowIds.session(rowId),
            cellId: "identity",
          },
        },
        RIGHT_DOWN,
      );
    return { runtime, store, dashboardRuntime, service, rightClickRow };
  }

  it("opens the shared rename edit sheet from a row context menu", () => {
    const { runtime, store, dashboardRuntime, rightClickRow } = contextMenuHarness();

    expect(rightClickRow()).toBe(true);
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(store.getState().input.contextMenu).toBeNull();
    expect(dashboardRuntime.state.getState().screen).toMatchObject({
      name: "renameSession",
      step: "editName",
      rowId: "ses_wt_station_idle",
      sessionId: "ses_wt_station_idle",
      currentTitle: "pty-buffer",
    });
  });

  it("opens Move to Group directly for a row context-menu session", () => {
    const { runtime, store, dashboardRuntime, rightClickRow } = contextMenuHarness();

    rightClickRow();
    runtime.handleSequence("\x1b[B");
    runtime.handleSequence("\r");

    expect(store.getState().input.contextMenu).toBeNull();
    expect(dashboardRuntime.state.getState().screen).toMatchObject({
      name: "moveToGroup",
      step: "chooseDestination",
      sessionId: "ses_wt_station_idle",
      submitting: false,
    });
  });

  it("opens the fork details sheet from a row context menu", () => {
    const { runtime, store, dashboardRuntime, rightClickRow } = contextMenuHarness();

    rightClickRow();
    // Menu order: Rename, Move, Fork, Delete Session — two downs reach the fork.
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(store.getState().input.contextMenu).toBeNull();
    expect(dashboardRuntime.state.getState().screen).toMatchObject({
      name: "fork",
      step: "details",
      sourceWorktreeId: "wt_station_idle",
      returnTo: "dashboard",
    });
  });

  it("opens the shared remove-session confirmation from a row context menu", () => {
    const { runtime, store, dashboardRuntime, rightClickRow } = contextMenuHarness();

    rightClickRow();
    // Menu order: Rename, Move, Fork, Delete Session — three downs reach delete.
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(store.getState().input.contextMenu).toBeNull();
    expect(dashboardRuntime.state.getState().screen).toEqual({
      name: "removeWorktree",
      step: "confirm",
      rowId: "ses_wt_station_idle",
      forceRequired: true,
      label: "pty-buffer",
      actionFocus: "keep",
    });
  });

  it("opens removal information for an external unstoppable agent", () => {
    const { runtime, dashboardRuntime, rightClickRow } = contextMenuHarness(
      externalAgentSnapshot(),
    );

    rightClickRow("run_wt_station_idle");
    // Menu order: Move, Fork, Delete Worktree… — two downs reach the informational action.
    runtime.handleSequence("\x1b[B");
    runtime.handleSequence("\x1b[B");
    runtime.handleSequence("\r");

    expect(dashboardRuntime.state.getState().screen).toEqual({
      name: "removeWorktree",
      step: "unavailable",
    });
    dashboardRuntime.actions.handleKey({ input: "y" });
    expect(dashboardRuntime.state.getState().localRows.pendingRemove).toEqual([]);
  });

  it("confirms right-click remove through the optimistic remove-worktree path", () => {
    const { runtime, dashboardRuntime, rightClickRow } = contextMenuHarness();

    rightClickRow();
    runtime.handleSequence("\x1b[B");
    runtime.handleSequence("\x1b[B");
    runtime.handleSequence("\x1b[B");
    runtime.handleSequence("\r");
    dashboardRuntime.actions.handleKey({ input: "y" });

    expect(dashboardRuntime.state.getState().localRows.pendingRemove).toMatchObject([
      {
        localId: "remove:wt_station_idle",
        worktreeId: "wt_station_idle",
        branch: "pty-buffer",
      },
    ]);
  });

  it("cancels right-click remove back to dashboard rather than slot select", () => {
    const { runtime, dashboardRuntime, rightClickRow } = contextMenuHarness();

    rightClickRow();
    runtime.handleSequence("\x1b[B");
    runtime.handleSequence("\x1b[B");
    runtime.handleSequence("\x1b[B");
    runtime.handleSequence("\r");
    dashboardRuntime.actions.handleKey({ input: "", escape: true });

    expect(dashboardRuntime.state.getState().screen).toEqual({ name: "dashboard" });
  });

  it("does not clobber active STATION filter flow from an inert row context menu", () => {
    const { runtime, dashboardRuntime, rightClickRow } = contextMenuHarness();
    dashboardRuntime.actions.handleKey({ input: "/" });
    dashboardRuntime.actions.handleKey({ input: "pty" });

    rightClickRow();
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(dashboardRuntime.state.getState().screen).toMatchObject({
      name: "persistentFilter",
      draft: { value: "pty", cursor: 3 },
    });
  });

  it("dispatches Group Quick Session with the Q context-menu shortcut", async () => {
    const { runtime, store, dashboardRuntime, service } = contextMenuHarness(
      groupedManyProjectsSnapshot(),
    );

    runtime.dispatchMouse(
      {
        kind: "station",
        target: {
          kind: "dashboardCell",
          rowId: dashboardRowIds.group("group_design_refresh"),
          cellId: "identity",
        },
      },
      RIGHT_DOWN,
    );
    expect(runtime.handleSequence("Q")).toBe(true);
    expect(store.getState().input.contextMenu).toBeNull();
    expect(dashboardRuntime.state.getState().dashboardFocus).toEqual({
      rowId: dashboardRowIds.group("group_design_refresh"),
      cellId: "menu",
    });
    await waitFor(() => service.dispatched.some((command) => command.type === "session.create"));
    await dashboardRuntime.dispose();
  });

  for (const [key, screenName, section] of [
    ["N", "newSession", undefined],
    ["S", "groupSettings", "general"],
    ["R", "groupSettings", "remove"],
  ] as const) {
    it(`routes the ${key} Group context-menu shortcut`, () => {
      const { runtime, store, dashboardRuntime } = contextMenuHarness(
        groupedManyProjectsSnapshot(),
      );

      runtime.dispatchMouse(
        {
          kind: "station",
          target: {
            kind: "dashboardCell",
            rowId: dashboardRowIds.group("group_design_refresh"),
            cellId: "menu",
          },
        },
        RIGHT_DOWN,
      );
      expect(runtime.handleSequence(key)).toBe(true);

      expect(store.getState().input.contextMenu).toBeNull();
      const screen = dashboardRuntime.state.getState().screen;
      expect(screen.name).toBe(screenName);
      if (screen.name === "newSession") {
        expect(screen.flow).toMatchObject({
          selectedProjectId: "station",
          groupSelection: { kind: "existing", groupId: "group_design_refresh" },
        });
      } else {
        expect(screen).toMatchObject({
          name: "groupSettings",
          groupId: "group_design_refresh",
          section,
        });
      }
    });
  }

  it("dispatches Quick Group from a project-header context menu", async () => {
    const { runtime, dashboardRuntime, service } = contextMenuHarness();

    runtime.dispatchMouse(
      { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.project("station"), cellId: "identity" } },
      RIGHT_DOWN,
    );
    expect(runtime.handleSequence("\r")).toBe(true);
    await waitFor(() => service.dispatched.some((command) => command.type === "sessionGroup.create"));

    const command = service.dispatched.find(
      (candidate) => candidate.type === "sessionGroup.create",
    );
    expect(command).toMatchObject({ payload: { projectId: "station" } });
    expect(command?.type === "sessionGroup.create" ? command.payload.name : "").toMatch(
      /^Quick Group [0-9a-f]{6}$/,
    );
    expect(dashboardRuntime.state.getState().screen).toEqual({ name: "dashboard" });
  });

  it("opens Create Group from a project-header context menu", () => {
    const { runtime, dashboardRuntime } = contextMenuHarness();

    runtime.dispatchMouse(
      { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.project("station"), cellId: "identity" } },
      RIGHT_DOWN,
    );
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(dashboardRuntime.state.getState().screen).toMatchObject({
      name: "createGroup",
      projectId: "station",
      quickSession: false,
      focus: "name",
      returnTo: "projectHeader",
    });
  });

  it("opens the default-agent picker from a project-header context menu", () => {
    const { runtime, store, dashboardRuntime } = contextMenuHarness();

    // Quick Group and New Group lead the Project context menu.
    runtime.dispatchMouse(
      { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.project("station"), cellId: "identity" } },
      RIGHT_DOWN,
    );
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(store.getState().input.contextMenu).toBeNull();
    expect(dashboardRuntime.state.getState().screen).toMatchObject({
      name: "projectDefaultAgent",
      projectId: "station",
    });
  });

  it("opens project settings from a project-header context menu", () => {
    const { runtime, store, dashboardRuntime } = contextMenuHarness();

    runtime.dispatchMouse(
      { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.project("station"), cellId: "identity" } },
      RIGHT_DOWN,
    );
    // Three rows down reaches Project Settings after the two Group actions.
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(store.getState().input.contextMenu).toBeNull();
    expect(dashboardRuntime.state.getState().screen).toMatchObject({
      name: "projectSettings",
      projectId: "station",
    });
  });
});

describe("createStationInputRuntime pane split/focus/close", () => {
  function harness(
    options: {
      dashboardRuntime?: StationTestDashboardRuntime;
      automations?: readonly Automation[];
    } = {},
  ) {
    const spawnOptions: StationTerminalSpawnOptions[] = [];
    const registry = createPtyRegistry({
      createTerminal: (spawn) => {
        spawnOptions.push(spawn);
        return createScriptedTerminal().terminal;
      },
    });
    // Spawn the boot pane so it behaves like a live focused pane.
    registry.resize(MAIN_PANE_ID, { cols: 36, rows: 8 });
    const store = createStationStore();
    const runtimeOptions: Parameters<typeof createStationInputRuntime>[0] = {
      store,
      shutdown: () => {},
      registry,
    };
    if (options.dashboardRuntime !== undefined) {
      runtimeOptions.dashboardRuntime = options.dashboardRuntime;
    }
    if (options.automations !== undefined) {
      runtimeOptions.automations = options.automations;
    }
    const runtime = createStationInputRuntime(runtimeOptions);
    return { runtime, store, registry, spawnOptions };
  }

  function worktreeSplitHarness(
    worktreeId = "wt_station_idle",
    automations?: readonly Automation[],
  ) {
    const snapshot = manyProjectsSnapshot();
    const row = snapshot.rows.find((candidate) => candidate.id === worktreeId);
    if (row === undefined) {
      throw new Error(`fixture row ${worktreeId} is missing`);
    }
    const dashboardRuntime = createStationTestDashboardRuntime({
      source: new FakeStationSource(snapshot),
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
    });
    const result = harness(
      automations === undefined ? { dashboardRuntime } : { dashboardRuntime, automations },
    );
    const agentPaneId = agentWorktreePaneId(row.id);
    result.store.actions.createPane(agentPaneId, { role: "primary-agent" });
    result.store.actions.setPrimaryAgent(agentPaneId, {
      sessionId: `ses_${row.id}`,
      terminalTargetId: `native:${row.id}`,
    });
    result.store.actions.focusPane(agentPaneId);
    return { ...result, row, agentPaneId };
  }

  it("keeps native pane commands inert while the dashboard is open", () => {
    for (const sequence of ["\x1c", "\x1e", "\x1d", "\x1f"]) {
      const { runtime, store } = harness();
      store.actions.createPane("pane-b");
      store.actions.focusPane(MAIN_PANE_ID);
      store.actions.openOverlay(STATION_OVERLAY_ID);

      expect(runtime.handleSequence(sequence)).toBe(true);
      expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual([
        MAIN_PANE_ID,
        "pane-b",
      ]);
      expect(store.getState().workspace.activePaneId).toBe(MAIN_PANE_ID);
      expect(store.getState().input.overlayReturnFocus).toEqual({
        kind: "pane",
        paneId: MAIN_PANE_ID,
      });
    }
  });

  it("Ctrl-\\ splits the active pane right and focuses the new pane", () => {
    const { runtime, store } = harness();
    expect(runtime.handleSequence("\x1c")).toBe(true);
    const panes = store.getState().workspace.panes;
    expect(panes).toHaveLength(2);
    expect(panes[1]).toEqual({
      id: "pane-split-0",
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
      role: "shell",
    });
    expect(store.getState().workspace.activePaneId).toBe("pane-split-0");
  });

  it("Ctrl-\\ splits a primary-agent pane in that worktree cwd", () => {
    const { runtime, registry, spawnOptions, row } = worktreeSplitHarness();

    expect(runtime.handleSequence("\x1c")).toBe(true);
    registry.resize("pane-split-0", { cols: 36, rows: 8 });

    expect(spawnOptions.at(-1)?.cwd).toBe(row.path);
  });

  it("opens automation panes in the anchor worktree root, not the anchor's live cwd", () => {
    const automation: Automation = {
      id: "see-diff",
      label: "See diff (split right)",
      enabled: true,
      steps: [
        { split: "right", anchor: "origin", command: "echo automation", run: "execute", focus: true },
      ],
    };
    const { runtime, registry, spawnOptions, row, agentPaneId } = worktreeSplitHarness(
      "wt_station_idle",
      [automation],
    );
    // Seed the anchor with a *different* live spawn cwd. runAutomation must still
    // open in the worktree root (splitCwdForAnchor) — the inverse precedence of a
    // plain split, which prefers the anchor's live cwd.
    registry.ensure(agentPaneId, { cwd: "/some/other/live/dir" });

    // A primary-agent pane's menu leads with Rename, so its order is
    // [Rename, Split Right, Split Below, See diff, Close]: the automation is at
    // after the two splits.
    runtime.dispatchMouse({ kind: "pane", paneId: agentPaneId }, RIGHT_DOWN);
    runtime.dispatchMouse(
      { kind: "contextMenuItemHover", itemId: "pane.automation.see-diff" },
      HOVER,
    );
    expect(runtime.handleSequence("\r")).toBe(true);
    registry.resize("pane-split-0", { cols: 36, rows: 8 });

    expect(spawnOptions.at(-1)?.cwd).toBe(row.path);
  });

  it("keeps the session cwd when splitting an existing split pane", () => {
    const { runtime, registry, spawnOptions, row } = worktreeSplitHarness();

    runtime.handleSequence("\x1c");
    runtime.handleSequence("\x1c");
    registry.resize("pane-split-1", { cols: 36, rows: 8 });

    expect(spawnOptions.at(-1)?.cwd).toBe(row.path);
  });

  it("keeps default cwd for panes not tied to a STATION worktree", () => {
    const { runtime, registry, spawnOptions } = harness();

    runtime.handleSequence("\x1c");
    registry.resize("pane-split-0", { cols: 36, rows: 8 });

    expect(spawnOptions.at(-1)?.cwd).toBeUndefined();
  });

  it("Ctrl-^ splits the active pane below", () => {
    const { runtime, store } = harness();
    runtime.handleSequence("\x1e");
    expect(store.getState().workspace.panes[1]?.split).toEqual({
      anchorPaneId: MAIN_PANE_ID,
      direction: "below",
    });
  });

  it("inherits the anchor pane's spawn cwd into the new split", () => {
    const scripted = createScriptedTerminal();
    const registry = createPtyRegistry({ createTerminal: () => scripted.terminal });
    // Seed the anchor with a cwd the way openPane/launch does, then lay it out.
    registry.ensure(MAIN_PANE_ID, { cwd: "/work/anchor" });
    registry.resize(MAIN_PANE_ID, { cols: 36, rows: 8 });
    const store = createStationStore();
    const runtime = createStationInputRuntime({ store, shutdown: () => {}, registry });

    runtime.handleSequence("\x1c"); // split right off MAIN

    expect(registry.get("pane-split-0")?.cwd).toBe("/work/anchor");
  });

  it("leaves the split cwd undefined when the anchor has none", () => {
    const { runtime, registry } = harness();
    runtime.handleSequence("\x1c");
    expect(registry.get("pane-split-0")?.cwd).toBeUndefined();
  });

  it("matches a split chord delivered in kitty form", () => {
    const { runtime, store } = harness();
    expect(runtime.handleSequence("\x1b[92;5u")).toBe(true); // Ctrl-\
    expect(store.getState().workspace.panes).toHaveLength(2);
  });

  it("mints distinct ids across successive splits", () => {
    const { runtime, store } = harness();
    runtime.handleSequence("\x1c"); // splits main -> pane-split-0 (now active)
    runtime.handleSequence("\x1c"); // splits pane-split-0 -> pane-split-1
    expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual([
      MAIN_PANE_ID,
      "pane-split-0",
      "pane-split-1",
    ]);
  });

  it("re-seeds splitSeq above restored split ids so a new split never collides", () => {
    const scripted = createScriptedTerminal();
    const registry = createPtyRegistry({ createTerminal: () => scripted.terminal });
    // A restored workspace whose highest split id is pane-split-5.
    const store = createStationStore({
      initialWorkspace: {
        panes: [
          { id: "pane-main", split: null, role: "shell" },
          { id: "pane-split-5", split: { anchorPaneId: "pane-main", direction: "right" }, role: "shell" },
        ],
        activePaneId: "pane-split-5",
      },
    });
    const runtime = createStationInputRuntime({ store, shutdown: () => {}, registry });

    runtime.handleSequence("\x1c"); // split the active (restored) pane

    const ids = store.getState().workspace.panes.map((pane) => pane.id);
    expect(ids).toContain("pane-split-6");
    // The restored pane-split-5 survived (no collision swallowed the new pane).
    expect(ids).toEqual(["pane-main", "pane-split-5", "pane-split-6"]);
  });

  it("Ctrl-] cycles within the active session, wrapping, and never crosses sessions", () => {
    const { runtime, store } = harness();
    store.actions.createPane("pane-b"); // a separate session root
    store.actions.createPane("pane-a2", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    store.actions.focusPane(MAIN_PANE_ID);
    expect(runtime.handleSequence("\x1d")).toBe(true);
    // Moves to MAIN's on-screen split sibling, not the other session's pane-b.
    expect(store.getState().workspace.activePaneId).toBe("pane-a2");
    runtime.handleSequence("\x1d");
    expect(store.getState().workspace.activePaneId).toBe(MAIN_PANE_ID);
  });

  it("Ctrl-_ closes the active pane and is inert on the last pane", () => {
    const { runtime, store } = harness();
    store.actions.createPane("pane-b"); // active = pane-b
    expect(runtime.handleSequence("\x1f")).toBe(true);
    expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual([MAIN_PANE_ID]);
    // Only the boot pane remains: the close guard makes this a no-op.
    expect(runtime.handleSequence("\x1f")).toBe(true);
    expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual([MAIN_PANE_ID]);
  });

  it("closing a pane kills its terminal (close = destroy, so a host-owned aux PTY is not orphaned)", () => {
    let killCount = 0;
    const killable = (): StationTerminalProcess => ({
      id: "killable",
      command: "x",
      pid: 1,
      size: { cols: 36, rows: 8 },
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      onDiagnostic: () => ({ dispose() {} }),
      write() {},
      resize() {},
      kill() {
        killCount += 1;
      },
      dispose() {},
    });
    const registry = createPtyRegistry({ createTerminal: () => killable() });
    registry.resize(MAIN_PANE_ID, { cols: 36, rows: 8 }); // spawn the boot pane
    const store = createStationStore();
    const runtime = createStationInputRuntime({ store, shutdown: () => {}, registry });

    runtime.handleSequence("\x1c"); // split right → pane-split-0 active
    registry.resize("pane-split-0", { cols: 36, rows: 8 }); // lazy-spawn its terminal
    expect(killCount).toBe(0);

    runtime.handleSequence("\x1f"); // close the active split pane
    expect(killCount).toBe(1); // its terminal was killed; the boot pane's was not
  });

  it("context-menu Split Right creates a right split off the right-clicked pane and closes the menu", () => {
    const { runtime, store } = harness();
    runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, RIGHT_DOWN);
    // Split Right is the default semantic item.
    expect(runtime.handleSequence("\r")).toBe(true);
    const created = store
      .getState()
      .workspace.panes.find((pane) => pane.split?.anchorPaneId === MAIN_PANE_ID);
    expect(created?.split).toEqual({ anchorPaneId: MAIN_PANE_ID, direction: "right" });
    expect(store.getState().input.contextMenu).toBeNull();
  });

  it("context-menu Split Below uses the below direction", () => {
    const { runtime, store } = harness();
    runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, RIGHT_DOWN);
    runtime.dispatchMouse({ kind: "contextMenuItem", itemId: "pane.splitBelow" }, LEFT_DOWN);
    const created = store.getState().workspace.panes.find((pane) => pane.split !== null);
    expect(created?.split).toEqual({ anchorPaneId: MAIN_PANE_ID, direction: "below" });
  });
});
