import { describe, expect, it } from "bun:test";
import { createTuiStore, selectDashboardViewport, type TuiStore } from "@station/dashboard-core";
import type { StoreApi } from "zustand/vanilla";
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
import type {
  ManagedTerminalAttacher,
  ManagedTerminalFactory,
} from "../terminal/pty/managedTerminalAttacher.js";
import { createScriptedTerminal } from "../terminal/testing/scriptedTerminal.js";
import { waitFor } from "../terminal/testing/waitFor.js";
import {
  externalAgentSnapshot,
  manyProjectsSnapshot,
} from "../station/fixtures/scenarios.js";
import type { AgentPrepareExternalLaunchResult } from "@station/client";
import type { StationSnapshot, WorktreeRow } from "@station/contracts";
import { FakeTuiObserverService } from "../station/test/support/fakeObserverService.js";
import { FakeStationSource } from "../station/test/support/fakeStationSource.js";
import { resolveForkSessionSubmit, resolveNewSessionSubmit } from "../station/input/stationActions.js";
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
    stationViewStore?: StoreApi<TuiStore>;
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
      ...(options?.stationViewStore === undefined ? {} : { stationViewStore: options.stationViewStore }),
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
      const stationViewStore = createTuiStore({
        source: new FakeStationSource(snapshot),
        service: new FakeTuiObserverService(snapshot),
        initialSnapshot: snapshot,
        persistentPopup: true,
        onDismiss: async () => {},
      });
      const { runtime, scripted, store, registry } = harness({ stationViewStore });
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

  it("swallows typing while the overlay is open but keeps reserved chords live", () => {
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
      activeIndex: 0,
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
    expect(store.getState().input.contextMenu?.activeIndex).toBe(2);
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual([MAIN_PANE_ID]);
    expect(store.getState().input.contextMenu).toBeNull();
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
  });

  it("context-menu Rename from a primary-agent pane opens directly and Esc closes to the dashboard", () => {
    const snapshot = manyProjectsSnapshot();
    const stationViewStore = createTuiStore({
      source: new FakeStationSource(snapshot),
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
    });
    const { runtime, store } = harness({ stationViewStore });
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
    expect(stationViewStore.getState().screen).toMatchObject({
      name: "renameSession",
      step: "editName",
      rowId: "ses_wt_station_idle",
      returnTo: "dashboard",
    });

    expect(runtime.handleSequence("\x1b")).toBe(true);
    expect(stationViewStore.getState().screen).toEqual({ name: "dashboard" });
  });

  it("runs an automation: splits a shell pane and executes its command with a trailing Enter", async () => {
    const automation: Automation = {
      id: "see-diff",
      label: "See diff (split right)",
      enabled: true,
      steps: [
        { split: "right", anchor: "origin", command: "git diff | diffnav", run: "execute", focus: true },
      ],
    };
    const { runtime, scripted, store, registry } = harness({ automations: [automation] });
    // Right-click the main pane, then pick the automation. It sits after the two
    // split actions (index 2), so it is selected explicitly, not by default Enter.
    runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, RIGHT_DOWN);
    runtime.dispatchMouse({ kind: "contextMenuItemHover", itemIndex: 2 }, HOVER);
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
    expect(scripted.helpers.writes).not.toContain("git diff | diffnav\r");

    registry.resize("pane-split-0", { cols: 36, rows: 8 });
    await waitFor(() => scripted.helpers.writes.includes("git diff | diffnav\r"));
    // Executed with a trailing CR — Station's Enter byte, not a bare LF.
    expect(scripted.helpers.writes).toContain("git diff | diffnav\r");
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
    runtime.dispatchMouse({ kind: "contextMenuItemHover", itemIndex: 2 }, HOVER);
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
    runtime.dispatchMouse({ kind: "contextMenuItemHover", itemIndex: 2 }, HOVER);
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
        { split: "right", anchor: "origin", command: "git diff | diffnav", run: "execute", focus: true },
      ],
    };
    const { runtime, scripted, registry } = harness({ automations: [automation] });
    runtime.dispatchMouse({ kind: "pane", paneId: MAIN_PANE_ID }, RIGHT_DOWN);
    runtime.dispatchMouse({ kind: "contextMenuItemHover", itemIndex: 2 }, HOVER);
    expect(runtime.handleSequence("\r")).toBe(true);

    // The split pane never laid out (no resize), so its PTY never spawned. Closing
    // it disposes the registry entry and notifies sendWhenReady, which finds the
    // entry gone, stops listening, and never writes the command into a dead pane.
    registry.dispose("pane-split-0");

    expect(scripted.helpers.writes).not.toContain("git diff | diffnav\r");
  });

  it("drops a queued automation command when its pane never lays out before the timeout", () => {
    const automation: Automation = {
      id: "see-diff",
      label: "See diff (split right)",
      enabled: true,
      steps: [
        { split: "right", anchor: "origin", command: "git diff | diffnav", run: "execute", focus: true },
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
      runtime.dispatchMouse({ kind: "contextMenuItemHover", itemIndex: 2 }, HOVER);
      expect(runtime.handleSequence("\r")).toBe(true);

      expect(longTimers).toHaveLength(1);
      for (const fire of longTimers) {
        fire();
      }

      // A layout arriving after the timeout finds no subscriber: the command is dropped.
      registry.resize("pane-split-0", { cols: 36, rows: 8 });
      expect(scripted.helpers.writes).not.toContain("git diff | diffnav\r");
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
    const stationViewStore = createTuiStore({
      source: new FakeStationSource(snapshot),
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
      initialState: { terminalRows: 12 },
    });
    const { runtime, store } = harness({ stationViewStore });
    store.actions.openOverlay(STATION_OVERLAY_ID);
    const before = stationViewStore.getState().screen;

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
    expect(stationViewStore.getState().screen).toEqual(before);
  });

  it("highlights a context menu item on hover via mouse dispatch", () => {
    const { runtime, store } = harness();
    store.actions.createPane("pane-second");
    expect(runtime.dispatchMouse({ kind: "pane", paneId: "pane-second" }, RIGHT_DOWN)).toBe(true);
    expect(store.getState().input.contextMenu?.activeIndex).toBe(0);

    const hover: StationMouseEvent = { ...LEFT_DOWN, type: "move" };
    expect(runtime.dispatchMouse({ kind: "contextMenuItemHover", itemIndex: 2 }, hover)).toBe(true);
    expect(store.getState().input.contextMenu?.activeIndex).toBe(2);
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
  // wt_station_idle -> branch pty-buffer; the fixture derives both ids and path.
  const WORKTREE_ID = "wt_station_idle";
  const SESSION_ID = "ses_wt_station_idle";
  const PANE_ID = worktreePaneId(WORKTREE_ID);
  const CWD = "/Users/example/.worktrees/station/pty-buffer";

  function paneHarness(options?: {
    autoCloseOverlayOnPaneOpen?: boolean;
    storeOptions?: Parameters<typeof createStationStore>[0];
  }) {
    const snapshot = manyProjectsSnapshot();
    const stationViewStore = createTuiStore({
      source: new FakeStationSource(snapshot),
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
      initialState: { terminalRows: 12 },
    });
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
    const origCreate = store.actions.createPane;
    store.actions.createPane = (paneId, options) => {
      calls.push(
        `createPane:${paneId}:${options?.split?.anchorPaneId ?? ""}:${options?.split?.direction ?? ""}`,
      );
      origCreate(paneId, options);
    };
    const origReveal = store.actions.revealPane;
    store.actions.revealPane = (paneId) => {
      calls.push(`revealPane:${paneId}`);
      origReveal(paneId);
    };
    const runtime = createStationInputRuntime({
      store,
      shutdown: () => {},
      stationViewStore,
      registry,
      autoCloseOverlayOnPaneOpen: options?.autoCloseOverlayOnPaneOpen ?? false,
    });
    const clickRowAffordance = (): boolean =>
      runtime.dispatchMouse(
        { kind: "station", target: { kind: "openShellForRow", rowId: SESSION_ID } },
        LEFT_DOWN,
      );
    return { runtime, store, calls, clickRowAffordance };
  }

  it("ensures the pane with its cwd before createPane on first open", () => {
    const { store, calls, clickRowAffordance } = paneHarness();
    store.actions.openOverlay(STATION_OVERLAY_ID);

    expect(clickRowAffordance()).toBe(true);

    // No worktree agent pane here, so the shell tiles off the active pane
    // rather than rooting its own session (which stacked it full-screen).
    expect(calls).toEqual([
      `ensure:${PANE_ID}:${CWD}`,
      `createPane:${PANE_ID}:${MAIN_PANE_ID}:right`,
    ]);
    expect(store.getState().workspace.panes.some((pane) => pane.id === PANE_ID)).toBe(true);
  });

  it("tiles a shell into the visible session when no pane is active (restored layout)", () => {
    const existing = "pane-restored";
    const { store, calls, clickRowAffordance } = paneHarness({
      storeOptions: {
        initialWorkspace: {
          panes: [{ id: existing, split: null, role: "shell" }],
          activePaneId: null,
        },
      },
    });
    store.actions.openOverlay(STATION_OVERLAY_ID);

    expect(clickRowAffordance()).toBe(true);

    // activePaneId is null but a session is on screen; the shell tiles into it
    // (the first record roots the visible tree) rather than covering it.
    expect(calls).toContain(`createPane:${PANE_ID}:${existing}:right`);
    expect(store.getState().workspace.panes.find((pane) => pane.id === PANE_ID)?.split).toEqual({
      anchorPaneId: existing,
      direction: "right",
    });
  });

  it("dismisses the boot intro into the active restored session on Continue", () => {
    const { runtime, store } = paneHarness({
      storeOptions: {
        initialWorkspace: {
          panes: [{ id: "pane-a", split: null, role: "shell" }],
          activePaneId: "pane-a",
        },
        welcomeIntroOnBoot: true,
      },
    });
    expect(store.getState().input.introVisible).toBe(true);

    runtime.dispatchMouse({ kind: "welcomeContinue" }, LEFT_DOWN);

    expect(store.getState().input.introVisible).toBe(false);
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: "pane-a" });
  });

  it("Enter on the intro continues into the restored session", () => {
    const { runtime, store } = paneHarness({
      storeOptions: {
        initialWorkspace: {
          panes: [{ id: "pane-a", split: null, role: "shell" }],
          activePaneId: "pane-a",
        },
        welcomeIntroOnBoot: true,
      },
    });

    expect(runtime.handleSequence("\r")).toBe(true);

    expect(store.getState().input.introVisible).toBe(false);
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: "pane-a" });
  });

  it("reuses the running pane via revealPane without a second ensure", () => {
    const { store, calls, clickRowAffordance } = paneHarness();
    store.actions.openOverlay(STATION_OVERLAY_ID);

    clickRowAffordance();
    clickRowAffordance();

    expect(calls).toEqual([
      `ensure:${PANE_ID}:${CWD}`,
      `createPane:${PANE_ID}:${MAIN_PANE_ID}:right`,
      `revealPane:${PANE_ID}`,
    ]);
    // Open-or-focus: exactly one pane record, no second shell.
    expect(store.getState().workspace.panes.filter((pane) => pane.id === PANE_ID)).toHaveLength(1);
  });

  it("keeps the overlay up by default, queuing the pane as return focus", () => {
    const { store, clickRowAffordance } = paneHarness();
    store.actions.openOverlay(STATION_OVERLAY_ID);

    clickRowAffordance();

    expect(selectStationOverlayVisible(store.getState())).toBe(true);
    expect(selectActivePaneId(store.getState())).toBe(PANE_ID);
    expect(store.getState().input.overlayReturnFocus).toEqual({ kind: "pane", paneId: PANE_ID });
  });

  it("auto-closes the overlay onto the new shell when opted in", () => {
    const { store, clickRowAffordance } = paneHarness({ autoCloseOverlayOnPaneOpen: true });
    store.actions.openOverlay(STATION_OVERLAY_ID);

    clickRowAffordance();

    expect(selectStationOverlayVisible(store.getState())).toBe(false);
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: PANE_ID });
  });

  it("opens a worktree shell as a split beside its primary agent pane", () => {
    const { store, calls, clickRowAffordance } = paneHarness();
    const agentPaneId = agentWorktreePaneId(WORKTREE_ID);
    store.actions.createPane(agentPaneId, { role: "primary-agent" });
    store.actions.setPrimaryAgent(agentPaneId, {
      sessionId: "ses_managed",
      terminalTargetId: "native:wt_station_idle",
    });
    store.actions.openOverlay(STATION_OVERLAY_ID);

    expect(clickRowAffordance()).toBe(true);

    expect(calls).toContain(
      `createPane:${PANE_ID}:${agentPaneId}:right`,
    );
    expect(store.getState().workspace.panes.find((pane) => pane.id === PANE_ID)?.split).toEqual({
      anchorPaneId: agentPaneId,
      direction: "right",
    });
    expect(selectStationOverlayVisible(store.getState())).toBe(true);
  });

  it("passes STATION link clicks to the external URL opener", () => {
    const snapshot = manyProjectsSnapshot();
    const stationViewStore = createTuiStore({
      source: new FakeStationSource(snapshot),
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
      initialState: { terminalRows: 12 },
    });
    const store = createStationStore();
    const opened: string[] = [];
    const runtime = createStationInputRuntime({
      store,
      shutdown: () => {},
      stationViewStore,
      openExternalUrl: (url) => {
        opened.push(url);
      },
    });
    const url = "https://github.com/example/station/pull/73";
    store.actions.openOverlay(STATION_OVERLAY_ID);

    expect(runtime.dispatchMouse({ kind: "station", target: { kind: "link", url } }, LEFT_DOWN)).toBe(
      true,
    );

    expect(opened).toEqual([url]);
    expect(selectStationOverlayVisible(store.getState())).toBe(true);
  });

  // The load-bearing invariant: the cwd seeded by ensure(paneId,{cwd}) before
  // createPane must survive the reconciler's later no-option ensure(paneId) and
  // reach the spawned shell. Exercise it through a real PtyRegistry + a
  // StationApp-equivalent reconciler, then spawn on first resize and assert the
  // captured cwd — closing the gap the plan flagged as manual-smoke-only.
  it("threads the worktree cwd to the spawned shell through the real reconciler", () => {
    const snapshot = manyProjectsSnapshot();
    const stationViewStore = createTuiStore({
      source: new FakeStationSource(snapshot),
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
      initialState: { terminalRows: 12 },
    });
    const scripted = createScriptedTerminal();
    const spawns: Array<{ paneCwd: string | undefined }> = [];
    const registry = createPtyRegistry({
      createTerminal: (options) => {
        spawns.push({ paneCwd: options.cwd });
        return scripted.terminal;
      },
    });
    const store = createStationStore();
    // Mirror StationApp.reconcilePanes: ensure (NO options) every member, dispose
    // entries no longer in the store. The no-option ensure is the step that must
    // preserve — not clobber — the cwd seeded by openPane.
    let lastPanes: readonly PaneRecord[] | undefined;
    const reconcile = (): void => {
      const panes = store.getState().workspace.panes;
      if (panes === lastPanes) {
        return;
      }
      lastPanes = panes;
      for (const pane of panes) {
        registry.ensure(pane.id);
      }
      for (const entry of registry.entries()) {
        if (!panes.some((pane) => pane.id === entry.paneId)) {
          registry.dispose(entry.paneId);
        }
      }
    };
    store.subscribe(reconcile);
    reconcile();
    const runtime = createStationInputRuntime({ store, shutdown: () => {}, stationViewStore, registry });
    const expectedCwd = snapshot.rows.find((row) => row.id === WORKTREE_ID)?.path;

    store.actions.openOverlay(STATION_OVERLAY_ID);
    runtime.dispatchMouse(
      { kind: "station", target: { kind: "openShellForRow", rowId: SESSION_ID } },
      LEFT_DOWN,
    );
    // Lazy spawn-on-first-resize: the shell starts here, at the cwd that must
    // have survived openPane's ensure -> createPane -> reconciler's no-option ensure.
    registry.resize(PANE_ID, { cols: 80, rows: 24 });

    expect(typeof expectedCwd).toBe("string");
    expect(spawns.map((spawn) => spawn.paneCwd)).toContain(expectedCwd);
  });
});

describe("createStationInputRuntime STATION context-menu actions", () => {
  function contextMenuHarness(snapshot: StationSnapshot = manyProjectsSnapshot()) {
    const stationViewStore = createTuiStore({
      source: new FakeStationSource(snapshot),
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
      initialState: { terminalRows: 12 },
    });
    const store = createStationStore();
    const runtime = createStationInputRuntime({
      store,
      shutdown: () => {},
      stationViewStore,
    });
    store.actions.openOverlay(STATION_OVERLAY_ID);
    const rightClickRow = (rowId = "ses_wt_station_idle"): boolean =>
      runtime.dispatchMouse({ kind: "station", target: { kind: "row", rowId } }, RIGHT_DOWN);
    return { runtime, store, stationViewStore, rightClickRow };
  }

  it("opens the shared rename edit sheet from a row context menu", () => {
    const { runtime, store, stationViewStore, rightClickRow } = contextMenuHarness();

    expect(rightClickRow()).toBe(true);
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(store.getState().input.contextMenu).toBeNull();
    expect(stationViewStore.getState().screen).toMatchObject({
      name: "renameSession",
      step: "editName",
      rowId: "ses_wt_station_idle",
      sessionId: "ses_wt_station_idle",
      currentTitle: "pty-buffer",
    });
  });

  it("opens the fork details sheet from a row context menu", () => {
    const { runtime, store, stationViewStore, rightClickRow } = contextMenuHarness();

    rightClickRow();
    // Menu order: Rename, Fork, Delete Session — one down reaches the fork.
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(store.getState().input.contextMenu).toBeNull();
    expect(stationViewStore.getState().screen).toMatchObject({
      name: "fork",
      step: "details",
      sourceWorktreeId: "wt_station_idle",
      returnTo: "dashboard",
    });
  });

  it("opens the shared remove-session confirmation from a row context menu", () => {
    const { runtime, store, stationViewStore, rightClickRow } = contextMenuHarness();

    rightClickRow();
    // Menu order: Rename, Fork, Delete Session — two downs reach the delete.
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(store.getState().input.contextMenu).toBeNull();
    expect(stationViewStore.getState().screen).toEqual({
      name: "removeWorktree",
      step: "confirm",
      rowId: "ses_wt_station_idle",
      forceRequired: true,
      label: "pty-buffer",
    });
  });

  it("opens removal information for an external unstoppable agent", () => {
    const { runtime, stationViewStore, rightClickRow } = contextMenuHarness(
      externalAgentSnapshot(),
    );

    rightClickRow("run_wt_station_idle");
    // Menu order: Fork, Delete Worktree… — one down reaches the informational action.
    runtime.handleSequence("\x1b[B");
    runtime.handleSequence("\r");

    expect(stationViewStore.getState().screen).toEqual({
      name: "removeWorktree",
      step: "unavailable",
    });
    stationViewStore.getState().handleKey({ input: "y" });
    expect(stationViewStore.getState().localRows.pendingRemove).toEqual([]);
  });

  it("confirms right-click remove through the optimistic remove-worktree path", () => {
    const { runtime, stationViewStore, rightClickRow } = contextMenuHarness();

    rightClickRow();
    runtime.handleSequence("\x1b[B");
    runtime.handleSequence("\x1b[B");
    runtime.handleSequence("\r");
    stationViewStore.getState().handleKey({ input: "y" });

    expect(stationViewStore.getState().localRows.pendingRemove).toMatchObject([
      {
        localId: "remove:wt_station_idle",
        worktreeId: "wt_station_idle",
        branch: "pty-buffer",
      },
    ]);
  });

  it("cancels right-click remove back to dashboard rather than slot select", () => {
    const { runtime, stationViewStore, rightClickRow } = contextMenuHarness();

    rightClickRow();
    runtime.handleSequence("\x1b[B");
    runtime.handleSequence("\x1b[B");
    runtime.handleSequence("\r");
    stationViewStore.getState().handleKey({ input: "", escape: true });

    expect(stationViewStore.getState().screen).toEqual({ name: "dashboard" });
  });

  it("does not clobber active STATION search flow from an inert row context menu", () => {
    const { runtime, stationViewStore, rightClickRow } = contextMenuHarness();
    stationViewStore.getState().handleKey({ input: "/" });
    stationViewStore.getState().handleKey({ input: "pty" });

    rightClickRow();
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(stationViewStore.getState().screen).toEqual({ name: "search", value: "pty" });
  });

  it("opens the default-agent picker from a project-header context menu", () => {
    const { runtime, store, stationViewStore } = contextMenuHarness();

    // Right-click a project header opens the project menu: [Set Default Agent, Project Settings…].
    runtime.dispatchMouse(
      { kind: "station", target: { kind: "projectHeader", projectId: "station" } },
      RIGHT_DOWN,
    );
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(store.getState().input.contextMenu).toBeNull();
    expect(stationViewStore.getState().screen).toMatchObject({
      name: "projectDefaultAgent",
      projectId: "station",
    });
  });

  it("opens project settings from a project-header context menu", () => {
    const { runtime, store, stationViewStore } = contextMenuHarness();

    runtime.dispatchMouse(
      { kind: "station", target: { kind: "projectHeader", projectId: "station" } },
      RIGHT_DOWN,
    );
    // Menu order: Set Default Agent, Project Settings… — one down reaches settings.
    expect(runtime.handleSequence("\x1b[B")).toBe(true);
    expect(runtime.handleSequence("\r")).toBe(true);

    expect(store.getState().input.contextMenu).toBeNull();
    expect(stationViewStore.getState().screen).toMatchObject({
      name: "projectSettings",
      projectId: "station",
    });
  });
});

describe("createStationInputRuntime managed primary-agent launch", () => {
  // Same fixture row as the shell wiring suite (wt_station_idle, branch pty-buffer,
  // project station), but the agent lands in the distinct agent pane id, not the
  // [+sh] shell pane. The launch command/args/env come from the observer's plan.
  const WORKTREE_ID = "wt_station_idle";
  const ROW_ID = "ses_wt_station_idle";
  const AGENT_PANE_ID = agentWorktreePaneId(WORKTREE_ID);
  const CWD = "/Users/example/.worktrees/station/pty-buffer";
  const TERMINAL_TARGET_ID = `native:${WORKTREE_ID}`;

  function preparedPlan(): AgentPrepareExternalLaunchResult {
    return {
      kind: "prepared",
      sessionId: "ses_managed",
      terminalTargetId: TERMINAL_TARGET_ID,
      launchPlan: {
        provider: "codex",
        command: "codex",
        args: ["--exec"],
        cwd: CWD,
        env: { STATION_SESSION_ID: "ses_managed", STATION_TERMINAL_TARGET_ID: TERMINAL_TARGET_ID },
        mode: "interactive",
      },
    };
  }

  // Records the role on createPane, the spawn options on ensure, and every
  // setPrimaryAgent — so order and arguments are assertable. The observer is a
  // configurable fake; settle() flushes the fire-and-forget async launch.
  function agentHarness(
    prepared: AgentPrepareExternalLaunchResult = preparedPlan(),
    snapshot: StationSnapshot = manyProjectsSnapshot(),
    managedTerminalAttacher?: ManagedTerminalAttacher,
  ) {
    const observerService = new FakeTuiObserverService(snapshot);
    observerService.nextPreparedLaunch = prepared;
    const stationViewStore = createTuiStore({
      source: new FakeStationSource(snapshot),
      service: observerService,
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
      initialState: { terminalRows: 12 },
    });
    const scripted = createScriptedTerminal();
    const base = createPtyRegistry({ createTerminal: () => scripted.terminal });
    const calls: string[] = [];
    const ensured: StationTerminalSpawnOptions[] = [];
    const terminalFactories: ManagedTerminalFactory[] = [];
    const registry: PtyRegistry = {
      ...base,
      ensure: (paneId, spawnOptions, createTerminalOverride) => {
        if (spawnOptions !== undefined) {
          ensured.push(spawnOptions);
        }
        if (createTerminalOverride !== undefined) {
          terminalFactories.push(createTerminalOverride);
        }
        calls.push(
          `ensure:${paneId}:${spawnOptions?.cwd ?? ""}:${spawnOptions?.command ?? ""}:${(spawnOptions?.args ?? []).join(",")}`,
        );
        return base.ensure(paneId, spawnOptions, createTerminalOverride);
      },
    };
    const store = createStationStore();
    const origCreate = store.actions.createPane;
    store.actions.createPane = (paneId, options) => {
      calls.push(`createPane:${paneId}:${options?.role ?? "shell"}`);
      origCreate(paneId, options);
    };
    const origSetPrimary = store.actions.setPrimaryAgent;
    store.actions.setPrimaryAgent = (paneId, identity) => {
      calls.push(`setPrimaryAgent:${paneId}:${identity.sessionId}:${identity.terminalTargetId}`);
      origSetPrimary(paneId, identity);
    };
    const runtime = createStationInputRuntime({
      store,
      shutdown: () => {},
      stationViewStore,
      registry,
      observerService,
      ...(managedTerminalAttacher === undefined ? {} : { managedTerminalAttacher }),
    });
    const dispatch = (
      target: { kind: "row"; rowId: string } | { kind: "openShellForRow"; rowId: string },
    ): boolean => runtime.dispatchMouse({ kind: "station", target }, LEFT_DOWN);
    const pressKey = (sequence: string): boolean => runtime.handleSequence(sequence);
    // The launch is fire-and-forget; flush its microtask chain.
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    return {
      store,
      calls,
      ensured,
      terminalFactories,
      dispatch,
      pressKey,
      settle,
      observerService,
      stationViewStore,
    };
  }

  function stationHostedSnapshot(
    terminalOverrides: Partial<NonNullable<WorktreeRow["terminal"]>> = {},
  ): StationSnapshot {
    const snapshot = manyProjectsSnapshot();
    return {
      ...snapshot,
      rows: snapshot.rows.map((row): WorktreeRow => {
        if (row.id !== WORKTREE_ID || row.terminal === undefined) {
          return row;
        }
        return { ...row, terminal: { ...row.terminal, provider: "native", ...terminalOverrides } };
      }),
      sessions: snapshot.sessions.map((session) => {
        if (session.id !== ROW_ID || session.terminal === undefined) {
          return session;
        }
        return {
          ...session,
          terminal: { ...session.terminal, provider: "native", ...terminalOverrides },
        };
      }),
    };
  }

  function liveAgentWithoutTerminalSnapshot(): StationSnapshot {
    const snapshot = manyProjectsSnapshot();
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

  function withTurnReadiness(snapshot: StationSnapshot): StationSnapshot {
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

  // The slot key the dashboard assigns to ROW_ID — pressing it is the keyboard
  // "open" gesture, the twin of clicking the row.
  function slotKeyFor(stationViewStore: ReturnType<typeof agentHarness>["stationViewStore"]): string {
    const state = stationViewStore.getState();
    const snapshot = state.snapshot;
    if (snapshot === undefined) {
      throw new Error("fixture snapshot is missing");
    }
    const slot = selectDashboardViewport(snapshot, state).rowChoices.find(
      (choice) => choice.value.id === ROW_ID,
    )?.key;
    if (slot === undefined) {
      throw new Error(`row ${ROW_ID} has no slot key`);
    }
    return slot;
  }

  it("prepares with the observer, then ensures the plan before createPane and records identity", async () => {
    const { store, calls, ensured, dispatch, settle, observerService } = agentHarness();
    store.actions.openOverlay(STATION_OVERLAY_ID);

    expect(dispatch({ kind: "row", rowId: ROW_ID })).toBe(true);
    await settle();

    expect(observerService.preparedLaunches).toEqual([
      { projectId: "station", worktreeId: WORKTREE_ID },
    ]);
    // Order is load-bearing: ensure (with the observer's plan) → createPane → setPrimaryAgent.
    expect(calls).toEqual([
      `ensure:${AGENT_PANE_ID}:${CWD}:codex:--exec`,
      `createPane:${AGENT_PANE_ID}:primary-agent`,
      `setPrimaryAgent:${AGENT_PANE_ID}:ses_managed:${TERMINAL_TARGET_ID}`,
    ]);
    // The launch plan's env (the STATION identity) reaches the spawn options.
    expect(ensured[0]?.env).toMatchObject({ STATION_SESSION_ID: "ses_managed" });
    const agentRecord = store.getState().workspace.panes.find((pane) => pane.id === AGENT_PANE_ID);
    expect(agentRecord?.role).toEqual("primary-agent");
    expect(agentRecord?.agentIdentity).toEqual({
      sessionId: "ses_managed",
      terminalTargetId: TERMINAL_TARGET_ID,
      harnessProvider: "codex",
    });
  });

  it("launches identically from the row's slot key as from a click", async () => {
    // The user's expectation, end to end: pressing the row's accelerator drives
    // the SAME observer prepare and the SAME ensure→createPane→setPrimaryAgent
    // ordering a click does — never the machine's start-or-focus against the
    // default terminal Station does not spawn into.
    const { store, calls, pressKey, settle, observerService, stationViewStore } = agentHarness();
    store.actions.openOverlay(STATION_OVERLAY_ID);

    expect(pressKey(slotKeyFor(stationViewStore))).toBe(true);
    await settle();

    expect(observerService.preparedLaunches).toEqual([
      { projectId: "station", worktreeId: WORKTREE_ID },
    ]);
    expect(calls).toEqual([
      `ensure:${AGENT_PANE_ID}:${CWD}:codex:--exec`,
      `createPane:${AGENT_PANE_ID}:primary-agent`,
      `setPrimaryAgent:${AGENT_PANE_ID}:ses_managed:${TERMINAL_TARGET_ID}`,
    ]);
    expect(selectStationOverlayVisible(store.getState())).toBe(false);
  });

  it("brings the user to the agent: launching it closes the overlay onto its pane", async () => {
    const { store, dispatch, settle } = agentHarness();
    store.actions.openOverlay(STATION_OVERLAY_ID);

    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    expect(selectStationOverlayVisible(store.getState())).toBe(false);
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: AGENT_PANE_ID });
  });

  it("acknowledges a ready turn after a successful managed pane open", async () => {
    const { store, dispatch, settle, observerService } = agentHarness(
      preparedPlan(),
      withTurnReadiness(manyProjectsSnapshot()),
    );
    store.actions.openOverlay(STATION_OVERLAY_ID);

    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    expect(observerService.dispatched).toEqual([
      {
        type: "session.acknowledgeTurn",
        payload: { sessionId: "ses_wt_station_idle", token: "report_station_ready" },
      },
    ]);
    expect(observerService.waitedForCommandIds).toEqual(["cmd_tui_1"]);
  });

  it("reveals the existing agent pane on re-click without preparing a second launch", async () => {
    const { store, dispatch, settle, observerService } = agentHarness();
    store.actions.openOverlay(STATION_OVERLAY_ID);
    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    store.actions.openOverlay(STATION_OVERLAY_ID);
    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    expect(observerService.preparedLaunches).toHaveLength(1);
    expect(selectStationOverlayVisible(store.getState())).toBe(false);
  });

  it("ignores a second click while the first launch is still preparing", async () => {
    const { store, dispatch, settle, observerService } = agentHarness();
    store.actions.openOverlay(STATION_OVERLAY_ID);

    // Two synchronous clicks before the async prepare resolves (no settle
    // between): the in-flight guard makes the second a no-op, so the observer is
    // asked to prepare exactly one launch — no orphaned second session/target.
    dispatch({ kind: "row", rowId: ROW_ID });
    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    expect(observerService.preparedLaunches).toHaveLength(1);
  });

  it("surfaces a notice for an existing tmux session it can't display, without a dead focus", async () => {
    // The observer reports a live agent already in this worktree, hosted by an
    // external terminal (the fixture rows are tmux) Station can't render. Focusing
    // it would have no visible effect — which reads as "clicking did nothing" — so
    // Station explains that instead of dispatching the focus.
    const { store, calls, dispatch, settle, observerService, stationViewStore } = agentHarness({
      kind: "existing-session",
      sessionId: "ses_elsewhere",
      harnessProvider: "codex",
    });
    store.actions.openOverlay(STATION_OVERLAY_ID);

    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    expect(calls).toEqual([]);
    expect(store.getState().workspace.panes.some((pane) => pane.role === "primary-agent")).toBe(false);
    expect(observerService.dispatched).toEqual([]);
    expect(observerService.waitedForCommandIds).toEqual([]);
    const notice = stationViewStore.getState().toasts.at(-1)?.toast;
    expect(notice?.kind).toBe("info");
    expect(notice?.message).toContain("tmux");
    // The overlay STAYS open so the user actually reads the notice.
    expect(selectStationOverlayVisible(store.getState())).toBe(true);
  });

  it("attaches a non-focusable native session from its slot key and acknowledges readiness", async () => {
    const attachment = {
      kind: "managed-terminal",
      terminalTargetId: `${TERMINAL_TARGET_ID}-host`,
    } as const;
    const resolutions: unknown[] = [];
    const scripted = createScriptedTerminal();
    const { store, pressKey, settle, observerService, stationViewStore } = agentHarness(
      {
        kind: "existing-session",
        sessionId: "ses_wt_station_idle",
        harnessProvider: "codex",
        attachment,
      },
      withTurnReadiness(stationHostedSnapshot({ focusable: false })),
      {
        resolve: async (candidate) => {
          resolutions.push(candidate);
          return () => scripted.terminal;
        },
      },
    );
    store.actions.openOverlay(STATION_OVERLAY_ID);

    expect(pressKey(slotKeyFor(stationViewStore))).toBe(true);
    await settle();

    expect(resolutions).toEqual([attachment]);
    expect(observerService.dispatched).toEqual([
      {
        type: "session.acknowledgeTurn",
        payload: { sessionId: "ses_wt_station_idle", token: "report_station_ready" },
      },
    ]);
    expect(observerService.waitedForCommandIds).toEqual(["cmd_tui_1"]);
    expect(selectStationOverlayVisible(store.getState())).toBe(false);
  });

  it("toasts for an existing Station-hosted worktree with no attachable host PTY", async () => {
    const { store, calls, dispatch, settle, observerService, stationViewStore } = agentHarness(
      { kind: "existing-session", sessionId: "ses_elsewhere", harnessProvider: "codex" },
      stationHostedSnapshot({ focusable: false }),
    );
    store.actions.openOverlay(STATION_OVERLAY_ID);

    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    expect(calls).toEqual([]);
    expect(observerService.dispatched).toEqual([]);
    expect(observerService.waitedForCommandIds).toEqual([]);
    expect(stationViewStore.getState().toasts.at(-1)?.toast).toMatchObject({
      kind: "info",
      message: "pty-buffer: Station has no attachable host PTY for this existing agent.",
    });
    expect(selectStationOverlayVisible(store.getState())).toBe(true);
  });

  it("toasts where a detached-terminal row lives instead of a silent focus no-op", async () => {
    // A row whose agent sits in a detached terminal (e.g. a detached tmux
    // session) can't be rendered as a Station pane; clicking it used to dispatch
    // a focus the observer accepts but that paints nothing. Now it explains
    // where the agent lives and leaves the overlay open to pick another row.
    const base = manyProjectsSnapshot();
    const snapshot: StationSnapshot = {
      ...base,
      rows: base.rows.map((row): WorktreeRow =>
        row.id === WORKTREE_ID && row.terminal !== undefined
          ? { ...row, terminal: { ...row.terminal, state: "detached" } }
          : row,
      ),
      sessions: base.sessions.map((session) =>
        session.id === ROW_ID && session.terminal !== undefined
          ? { ...session, terminal: { ...session.terminal, state: "detached" } }
          : session,
      ),
    };
    const { store, calls, dispatch, settle, observerService, stationViewStore } = agentHarness(
      preparedPlan(),
      snapshot,
    );
    store.actions.openOverlay(STATION_OVERLAY_ID);

    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    // No prepare, no spawn: Station does not try to launch or focus it.
    expect(observerService.preparedLaunches).toEqual([]);
    expect(calls).toEqual([]);
    expect(stationViewStore.getState().toasts.at(-1)?.toast).toMatchObject({
      kind: "info",
      message: "pty-buffer: agent is detached under 'tmux'; Station can't focus it here.",
    });
    // Overlay stays open so the toast is read in context.
    expect(selectStationOverlayVisible(store.getState())).toBe(true);
  });

  it("resolves a prepared attachment before seeding the managed pane", async () => {
    const attachment = {
      kind: "managed-terminal",
      terminalTargetId: `${TERMINAL_TARGET_ID}-host`,
    } as const;
    const base = preparedPlan();
    if (base.kind !== "prepared") {
      throw new Error("preparedPlan must be a prepared launch");
    }
    const resolutions: unknown[] = [];
    const scripted = createScriptedTerminal();
    const factory: ManagedTerminalFactory = () => scripted.terminal;
    const managedTerminalAttacher: ManagedTerminalAttacher = {
      resolve: async (candidate) => {
        resolutions.push(candidate);
        return factory;
      },
    };
    const { store, calls, ensured, terminalFactories, dispatch, settle } = agentHarness(
      { ...base, attachment },
      manyProjectsSnapshot(),
      managedTerminalAttacher,
    );
    store.actions.openOverlay(STATION_OVERLAY_ID);

    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    expect(resolutions).toEqual([attachment]);
    expect(calls).toEqual([
      `ensure:${AGENT_PANE_ID}:${CWD}::`,
      `createPane:${AGENT_PANE_ID}:primary-agent`,
      `setPrimaryAgent:${AGENT_PANE_ID}:ses_managed:${attachment.terminalTargetId}`,
    ]);
    expect(ensured[0]).toEqual({ cwd: CWD });
    expect(terminalFactories).toEqual([factory]);
    expect(
      store.getState().workspace.panes.find((pane) => pane.id === AGENT_PANE_ID)?.agentIdentity,
    ).toEqual({
      sessionId: "ses_managed",
      terminalTargetId: attachment.terminalTargetId,
      harnessProvider: "codex",
    });
  });

  it("uses the resolver and records the provider for an existing attached agent", async () => {
    const attachment = {
      kind: "managed-terminal",
      terminalTargetId: `${TERMINAL_TARGET_ID}-host`,
    } as const;
    const resolutions: unknown[] = [];
    const scripted = createScriptedTerminal();
    const { store, calls, dispatch, settle, observerService } = agentHarness(
      {
        kind: "existing-session",
        sessionId: "ses_live",
        harnessProvider: "codex",
        attachment,
      },
      stationHostedSnapshot({ focusable: false }),
      {
        resolve: async (candidate) => {
          resolutions.push(candidate);
          return () => scripted.terminal;
        },
      },
    );
    store.actions.openOverlay(STATION_OVERLAY_ID);

    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    expect(resolutions).toEqual([attachment]);
    expect(calls).toEqual([
      `ensure:${AGENT_PANE_ID}:${CWD}::`,
      `createPane:${AGENT_PANE_ID}:primary-agent`,
      `setPrimaryAgent:${AGENT_PANE_ID}:ses_live:${attachment.terminalTargetId}`,
    ]);
    expect(
      store.getState().workspace.panes.find((pane) => pane.id === AGENT_PANE_ID)?.agentIdentity,
    ).toEqual({
      sessionId: "ses_live",
      terminalTargetId: attachment.terminalTargetId,
      harnessProvider: "codex",
    });
    expect(observerService.dispatched).toEqual([]);
    expect(selectStationOverlayVisible(store.getState())).toBe(false);
  });

  it("toasts attachment resolution failures without creating or locally spawning a pane", async () => {
    const attachment = {
      kind: "managed-terminal",
      terminalTargetId: `${TERMINAL_TARGET_ID}-gone`,
    } as const;
    const base = preparedPlan();
    if (base.kind !== "prepared") {
      throw new Error("preparedPlan must be a prepared launch");
    }
    const { store, calls, dispatch, settle, stationViewStore } = agentHarness(
      { ...base, attachment },
      manyProjectsSnapshot(),
      {
        resolve: async () => {
          throw {
            tag: "TerminalProviderError",
            code: "HOST_ATTACH_GONE",
            message: "The managed terminal is no longer available.",
            provider: "native",
          };
        },
      },
    );
    store.actions.openOverlay(STATION_OVERLAY_ID);

    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    expect(calls).toEqual([]);
    expect(store.getState().workspace.panes.some((pane) => pane.role === "primary-agent")).toBe(false);
    expect(stationViewStore.getState().toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: "The managed terminal is no longer available.",
    });
    expect(selectStationOverlayVisible(store.getState())).toBe(true);
  });

  it("toasts the observer's error when prepareExternalLaunch rejects", async () => {
    const { store, calls, dispatch, settle, observerService, stationViewStore } = agentHarness();
    observerService.prepareExternalLaunch = async () => {
      throw {
        tag: "CommandValidationError",
        code: "HARNESS_HOOKS_NOT_INSTALLED",
        message: "Claude hooks are not installed.",
        hint: "Run 'stn hooks install claude'.",
      };
    };
    store.actions.openOverlay(STATION_OVERLAY_ID);

    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    expect(calls).toEqual([]);
    // Routed through safeErrorToNotice now, so message and hint stay distinct
    // fields rather than being concatenated into one string.
    expect(stationViewStore.getState().toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: "Claude hooks are not installed.",
      hint: "Run 'stn hooks install claude'.",
    });
  });

  it("toasts when launched with no observer service (no spawn)", async () => {
    const snapshot = manyProjectsSnapshot();
    const stationViewStore = createTuiStore({
      source: new FakeStationSource(snapshot),
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
      initialState: { terminalRows: 12 },
    });
    const store = createStationStore();
    // No observerService threaded in → the launch can't prepare anything.
    const runtime = createStationInputRuntime({ store, shutdown: () => {}, stationViewStore });
    store.actions.openOverlay(STATION_OVERLAY_ID);

    runtime.dispatchMouse({ kind: "station", target: { kind: "row", rowId: ROW_ID } }, LEFT_DOWN);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const toast = stationViewStore.getState().toasts.at(-1)?.toast;
    expect(toast?.kind).toBe("error");
    expect(toast?.message).toContain("No observer connection");
    expect(store.getState().workspace.panes.some((pane) => pane.role === "primary-agent")).toBe(false);
  });

  it("leaves the [+sh] shell path role-shell with no managed launch", () => {
    const { store, calls, dispatch, observerService } = agentHarness();
    store.actions.openOverlay(STATION_OVERLAY_ID);

    expect(dispatch({ kind: "openShellForRow", rowId: ROW_ID })).toBe(true);

    const shellPaneId = worktreePaneId(WORKTREE_ID);
    // No command/args seeded (default shell), role shell, and no observer prepare.
    expect(calls).toEqual([`ensure:${shellPaneId}:${CWD}::`, `createPane:${shellPaneId}:shell`]);
    expect(store.getState().workspace.panes.find((pane) => pane.id === shellPaneId)?.role).toEqual(
      "shell",
    );
    expect(store.getState().workspace.panes.some((pane) => pane.role === "primary-agent")).toBe(false);
    expect(observerService.preparedLaunches).toEqual([]);
  });

  it("toasts and keeps the overlay open when focusing an existing session is rejected", async () => {
    const { store, dispatch, settle, observerService, stationViewStore } = agentHarness(
      { kind: "existing-session", sessionId: "ses_elsewhere", harnessProvider: "codex" },
      liveAgentWithoutTerminalSnapshot(),
    );
    observerService.nextReceipt = {
      commandId: "cmd_tui_1",
      accepted: false,
      status: "rejected",
      error: {
        tag: "ClientObserverError",
        code: "STATION_FOCUS_REJECTED",
        message: "Focus was rejected.",
      },
    };
    store.actions.openOverlay(STATION_OVERLAY_ID);

    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    expect(observerService.dispatched).toEqual([
      { type: "terminal.focus", payload: { sessionId: "ses_elsewhere" } },
    ]);
    expect(stationViewStore.getState().toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: "Focus was rejected.",
    });
    expect(selectStationOverlayVisible(store.getState())).toBe(true);
  });

  it("toasts and keeps the overlay open when the focus command completion fails", async () => {
    const { store, dispatch, settle, observerService, stationViewStore } = agentHarness(
      { kind: "existing-session", sessionId: "ses_elsewhere", harnessProvider: "codex" },
      liveAgentWithoutTerminalSnapshot(),
    );
    observerService.nextCompletion = {
      status: "failed",
      commandId: "cmd_tui_1",
      error: {
        tag: "ClientObserverError",
        code: "STATION_FOCUS_FAILED",
        message: "Focus never completed.",
      },
    };
    store.actions.openOverlay(STATION_OVERLAY_ID);

    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    expect(observerService.waitedForCommandIds).toEqual(["cmd_tui_1"]);
    expect(stationViewStore.getState().toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: "Focus never completed.",
    });
    expect(selectStationOverlayVisible(store.getState())).toBe(true);
  });

  it("toasts and keeps the overlay open when the focus dispatch throws", async () => {
    const { store, dispatch, settle, observerService, stationViewStore } = agentHarness(
      { kind: "existing-session", sessionId: "ses_elsewhere", harnessProvider: "codex" },
      liveAgentWithoutTerminalSnapshot(),
    );
    observerService.dispatch = async () => {
      throw {
        tag: "ClientObserverError",
        code: "STATION_FOCUS_THREW",
        message: "Observer is gone.",
      };
    };
    store.actions.openOverlay(STATION_OVERLAY_ID);

    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    expect(stationViewStore.getState().toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: "Observer is gone.",
    });
    expect(selectStationOverlayVisible(store.getState())).toBe(true);
  });

  it("still opens the pane when acknowledging the ready turn fails", async () => {
    const { store, dispatch, settle, observerService, stationViewStore } = agentHarness(
      preparedPlan(),
      withTurnReadiness(manyProjectsSnapshot()),
    );
    // Only the turn ack throws; the launch itself is unaffected. A failed best-effort
    // ack must not turn a successful open into an error.
    observerService.dispatch = async (command) => {
      if (command.type === "session.acknowledgeTurn") {
        throw { tag: "ClientObserverError", code: "ACK_FAILED", message: "ack failed" };
      }
      return observerService.nextReceipt;
    };
    store.actions.openOverlay(STATION_OVERLAY_ID);

    dispatch({ kind: "row", rowId: ROW_ID });
    await settle();

    // The open succeeded: overlay closed onto the new primary-agent pane...
    expect(selectStationOverlayVisible(store.getState())).toBe(false);
    expect(store.getState().workspace.panes.find((pane) => pane.id === AGENT_PANE_ID)?.role).toBe(
      "primary-agent",
    );
    // ...and the swallowed ack error produced no error toast.
    expect(stationViewStore.getState().toasts.some((entry) => entry.toast.kind === "error")).toBe(
      false,
    );
  });
});

describe("createStationInputRuntime New Session hosted launch", () => {
  // Driven end to end through the public runtime: open the overlay, "N" opens the
  // wizard's review screen, Enter submits as a Station-hosted launch (worktree.create
  // + a background managed launch) instead of the machine's tmux session.create.
  const PROJECT_ID = "station";

  function newSessionPlan(worktreeId: string): AgentPrepareExternalLaunchResult {
    return {
      kind: "prepared",
      sessionId: "ses_new",
      terminalTargetId: `native:${worktreeId}`,
      launchPlan: {
        provider: "codex",
        command: "codex",
        args: ["--exec"],
        cwd: "/tmp/new",
        env: {},
        mode: "interactive",
      },
    };
  }

  function newSessionHarness() {
    const snapshot = manyProjectsSnapshot();
    const observerService = new FakeTuiObserverService(snapshot);
    const source = new FakeStationSource(snapshot);
    const stationViewStore = createTuiStore({
      source,
      service: observerService,
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
      initialState: { terminalRows: 12 },
    });
    // Attach the source so source.setSnapshot later propagates to the store —
    // the seam waitForWorktreeByBranch subscribes against.
    stationViewStore.getState().start();
    const scripted = createScriptedTerminal();
    const registry = createPtyRegistry({ createTerminal: () => scripted.terminal });
    const store = createStationStore();
    const runtime = createStationInputRuntime({
      store,
      shutdown: () => {},
      stationViewStore,
      registry,
      observerService,
    });
    const pressKey = (sequence: string): boolean => runtime.handleSequence(sequence);
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    return { store, runtime, observerService, source, stationViewStore, pressKey, settle, snapshot };
  }

  // Open the wizard and read the branch the submit will use, without coupling to
  // the internal screen shape (resolveNewSessionSubmit is the same resolver the
  // overlay layer drives on Enter).
  function openWizardAndCaptureBranch(harness: ReturnType<typeof newSessionHarness>): string {
    harness.store.actions.openOverlay(STATION_OVERLAY_ID);
    harness.pressKey("N");
    const submit = resolveNewSessionSubmit(harness.stationViewStore);
    if (submit.kind !== "submit") {
      throw new Error("expected the New Session wizard to be on the review screen");
    }
    return submit.branch;
  }

  // Clone the snapshot with a freshly-created (agentless) worktree row for branch,
  // mirroring what the observer's post-create reconcile delivers.
  function snapshotWithWorktree(
    base: StationSnapshot,
    worktreeId: string,
    branch: string,
  ): StationSnapshot {
    const template = base.rows.find((row) => row.projectId === PROJECT_ID);
    if (template === undefined) {
      throw new Error("fixture has no station row to clone");
    }
    const fresh: WorktreeRow = {
      ...template,
      id: worktreeId,
      branch,
      path: `/Users/example/.worktrees/station/${branch}`,
      display: { ...template.display },
    };
    delete fresh.agent;
    delete fresh.terminal;
    return { ...base, rows: [...base.rows, fresh] };
  }

  it("creates the worktree, launches the agent in the background, and keeps the overlay open", async () => {
    const harness = newSessionHarness();
    const worktreeId = "wt_new_session";
    harness.observerService.nextPreparedLaunch = newSessionPlan(worktreeId);
    const branch = openWizardAndCaptureBranch(harness);
    const localId = `station-create:${PROJECT_ID}:${branch}`;

    expect(harness.pressKey("\r")).toBe(true);
    // Optimistic create row appears synchronously on submit, before the real
    // worktree reaches the snapshot (which would prune it).
    expect(
      harness.stationViewStore
        .getState()
        .localRows.pendingCreate.map((row) => row.localId),
    ).toContain(localId);

    // Let worktree.create dispatch + completion resolve and waitForWorktreeByBranch
    // subscribe, then deliver the created worktree row so the launch proceeds.
    await harness.settle();
    harness.source.setSnapshot(snapshotWithWorktree(harness.snapshot, worktreeId, branch));
    await harness.settle();

    const createCommand = harness.observerService.dispatched.find(
      (command) => command.type === "worktree.create",
    );
    expect(createCommand).toEqual({
      type: "worktree.create",
      payload: { projectId: PROJECT_ID, branch },
    });
    // The New Session flow forwards the wizard's harness pick to the prepare.
    expect(harness.observerService.preparedLaunches).toEqual([
      { projectId: PROJECT_ID, worktreeId, harness: "codex" },
    ]);
    const agentPaneId = agentWorktreePaneId(worktreeId);
    expect(harness.store.getState().workspace.panes.some((pane) => pane.id === agentPaneId)).toBe(
      true,
    );
    // Background launch: the dashboard overlay stays up and focus is not yanked
    // into the new pane.
    expect(selectStationOverlayVisible(harness.store.getState())).toBe(true);
    expect(harness.store.getState().input.focus).not.toEqual({ kind: "pane", paneId: agentPaneId });
  });

  it("removes the optimistic row and toasts when the worktree create is rejected", async () => {
    const harness = newSessionHarness();
    harness.observerService.nextReceipt = {
      commandId: "cmd_tui_1",
      accepted: false,
      status: "rejected",
      error: {
        tag: "CommandValidationError",
        code: "WORKTREE_BRANCH_EXISTS",
        message: "That branch already exists.",
      },
    };
    const branch = openWizardAndCaptureBranch(harness);

    expect(harness.pressKey("\r")).toBe(true);
    await harness.settle();

    expect(harness.stationViewStore.getState().localRows.pendingCreate).toEqual([]);
    const toast = harness.stationViewStore.getState().toasts.at(-1)?.toast;
    expect(toast?.kind).toBe("error");
    expect(toast?.message).toContain("That branch already exists.");
    // No agent was launched: the create failed before any prepare.
    expect(harness.observerService.preparedLaunches).toEqual([]);
    expect(branch.length).toBeGreaterThan(0);
  });

  it("removes the optimistic row and toasts when the worktree create completion fails", async () => {
    const harness = newSessionHarness();
    harness.observerService.nextCompletion = {
      status: "failed",
      commandId: "cmd_tui_1",
      error: {
        tag: "ClientObserverError",
        code: "WORKTREE_CREATE_FAILED",
        message: "Create failed mid-flight.",
      },
    };
    const branch = openWizardAndCaptureBranch(harness);

    expect(harness.pressKey("\r")).toBe(true);
    await harness.settle();

    expect(harness.stationViewStore.getState().localRows.pendingCreate).toEqual([]);
    expect(harness.stationViewStore.getState().toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: "Create failed mid-flight.",
    });
    // The create never completed, so no agent launch was prepared.
    expect(harness.observerService.preparedLaunches).toEqual([]);
    expect(branch.length).toBeGreaterThan(0);
  });

  it("toasts and clears the optimistic row when there is no observer connection", async () => {
    const snapshot = manyProjectsSnapshot();
    const stationViewStore = createTuiStore({
      source: new FakeStationSource(snapshot),
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
      initialState: { terminalRows: 12 },
    });
    const store = createStationStore();
    // No observerService threaded in → the New Session create cannot dispatch.
    const runtime = createStationInputRuntime({ store, shutdown: () => {}, stationViewStore });
    store.actions.openOverlay(STATION_OVERLAY_ID);
    runtime.handleSequence("N");
    expect(runtime.handleSequence("\r")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stationViewStore.getState().localRows.pendingCreate).toEqual([]);
    expect(stationViewStore.getState().toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: "No observer connection; cannot create the session.",
    });
  });

  it("toasts when the created worktree never reaches the snapshot in time", async () => {
    const harness = newSessionHarness();
    const branch = openWizardAndCaptureBranch(harness);
    const localId = `station-create:${PROJECT_ID}:${branch}`;

    // Fire the 10s "worktree appeared" timeout deterministically instead of waiting
    // WORKTREE_APPEAR_TIMEOUT_MS; sub-second settle timers pass through.
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
      expect(harness.pressKey("\r")).toBe(true);
      // Let create dispatch + completion resolve and waitForWorktreeByBranch subscribe.
      await harness.settle();
      // The row never arrives; fire the appear-timeout so the wait resolves undefined.
      for (const fire of longTimers) {
        fire();
      }
      await harness.settle();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    expect(
      harness.stationViewStore.getState().localRows.pendingCreate.map((row) => row.localId),
    ).not.toContain(localId);
    expect(harness.stationViewStore.getState().toasts.at(-1)?.toast).toMatchObject({
      kind: "info",
      message:
        "Created the worktree, but it didn't appear in time to launch the agent — open it from the dashboard.",
    });
    // The launch never proceeded past the missing row.
    expect(harness.observerService.preparedLaunches).toEqual([]);
  });
});

describe("createStationInputRuntime Fork hosted launch", () => {
  // Driven end to end through the public runtime: open the overlay, "F" + a slot
  // open the fork details, Enter submits as a Station-hosted launch (worktree.fork
  // + a background managed launch) instead of the machine's tmux session.fork.
  function forkPlan(worktreeId: string): AgentPrepareExternalLaunchResult {
    return {
      kind: "prepared",
      sessionId: "ses_fork",
      terminalTargetId: `native:${worktreeId}`,
      launchPlan: {
        provider: "codex",
        command: "codex",
        args: ["--exec"],
        cwd: "/tmp/fork",
        env: {},
        mode: "interactive",
      },
    };
  }

  function forkHarness() {
    const snapshot = manyProjectsSnapshot();
    const observerService = new FakeTuiObserverService(snapshot);
    const source = new FakeStationSource(snapshot);
    const stationViewStore = createTuiStore({
      source,
      service: observerService,
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
      initialState: { terminalRows: 12 },
    });
    stationViewStore.getState().start();
    const scripted = createScriptedTerminal();
    const registry = createPtyRegistry({ createTerminal: () => scripted.terminal });
    const store = createStationStore();
    const runtime = createStationInputRuntime({
      store,
      shutdown: () => {},
      stationViewStore,
      registry,
      observerService,
    });
    const pressKey = (sequence: string): boolean => runtime.handleSequence(sequence);
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    return { store, runtime, observerService, source, stationViewStore, pressKey, settle, snapshot };
  }

  // Open fork details for the first row and read the submit the overlay drives on
  // Enter (resolveForkSessionSubmit), without coupling to the screen shape.
  function openForkAndCaptureSubmit(harness: ReturnType<typeof forkHarness>) {
    harness.store.actions.openOverlay(STATION_OVERLAY_ID);
    harness.pressKey("F");
    harness.pressKey("1");
    const submit = resolveForkSessionSubmit(harness.stationViewStore);
    if (submit.kind !== "submit") {
      throw new Error("expected the fork flow to be on the details screen");
    }
    return submit;
  }

  // The harness Station inherits for the fork: the source row's live/recovery
  // harness, else the project default — the same resolution the executor uses.
  function inheritedHarness(harness: ReturnType<typeof forkHarness>, submit: { projectId: string; sourceWorktreeId: string }) {
    const sourceRow = harness.snapshot.rows.find((row) => row.id === submit.sourceWorktreeId);
    const project = harness.snapshot.projects.find((candidate) => candidate.id === submit.projectId);
    return sourceRow?.agent?.harness ?? sourceRow?.recovery?.provider ?? project?.defaults.harness;
  }

  function snapshotWithWorktree(
    base: StationSnapshot,
    projectId: string,
    worktreeId: string,
    branch: string,
  ): StationSnapshot {
    const template = base.rows.find((row) => row.projectId === projectId);
    if (template === undefined) {
      throw new Error(`fixture has no ${projectId} row to clone`);
    }
    const fresh: WorktreeRow = {
      ...template,
      id: worktreeId,
      branch,
      path: `/Users/example/.worktrees/${projectId}/${branch}`,
      display: { ...template.display },
    };
    delete fresh.agent;
    delete fresh.terminal;
    return { ...base, rows: [...base.rows, fresh] };
  }

  it("forks the worktree, shows an optimistic row, and launches the inherited agent in the background", async () => {
    const harness = forkHarness();
    const worktreeId = "wt_forked";
    harness.observerService.nextPreparedLaunch = forkPlan(worktreeId);
    const submit = openForkAndCaptureSubmit(harness);
    const localId = `station-fork:${submit.sourceWorktreeId}:${submit.branch}`;
    const harnessProvider = inheritedHarness(harness, submit);

    expect(harness.pressKey("\r")).toBe(true);
    // Optimistic row appears synchronously on submit, carrying the inherited harness,
    // before the real worktree reaches the snapshot (which would prune it).
    expect(
      harness.stationViewStore
        .getState()
        .localRows.pendingCreate.find((row) => row.localId === localId)?.harnessProvider,
    ).toBe(harnessProvider);

    await harness.settle();
    harness.source.setSnapshot(
      snapshotWithWorktree(harness.snapshot, submit.projectId, worktreeId, submit.branch),
    );
    await harness.settle();

    const forkCommand = harness.observerService.dispatched.find(
      (command) => command.type === "worktree.fork",
    );
    expect(forkCommand).toEqual({
      type: "worktree.fork",
      payload: {
        projectId: submit.projectId,
        sourceWorktreeId: submit.sourceWorktreeId,
        branch: submit.branch,
        copyDirty: true,
      },
    });
    // The inherited harness is forwarded to the prepare for the new worktree.
    expect(harness.observerService.preparedLaunches).toEqual([
      { projectId: submit.projectId, worktreeId, harness: harnessProvider },
    ]);
    const agentPaneId = agentWorktreePaneId(worktreeId);
    expect(harness.store.getState().workspace.panes.some((pane) => pane.id === agentPaneId)).toBe(
      true,
    );
    // Background launch: the dashboard overlay stays up.
    expect(selectStationOverlayVisible(harness.store.getState())).toBe(true);
  });

  it("removes the optimistic row and toasts when the worktree fork is rejected", async () => {
    const harness = forkHarness();
    harness.observerService.nextReceipt = {
      commandId: "cmd_tui_1",
      accepted: false,
      status: "rejected",
      error: {
        tag: "WorktreeProviderError",
        code: "WORKTREE_CREATE_FAILED",
        message: "Could not seed the fork.",
      },
    };
    const submit = openForkAndCaptureSubmit(harness);
    const localId = `station-fork:${submit.sourceWorktreeId}:${submit.branch}`;

    expect(harness.pressKey("\r")).toBe(true);
    await harness.settle();

    expect(
      harness.stationViewStore
        .getState()
        .localRows.pendingCreate.some((row) => row.localId === localId),
    ).toBe(false);
    const toast = harness.stationViewStore.getState().toasts.at(-1)?.toast;
    expect(toast?.kind).toBe("error");
    expect(toast?.message).toContain("Could not seed the fork.");
    expect(harness.observerService.preparedLaunches).toEqual([]);
  });
});

describe("createStationInputRuntime pane split/focus/close", () => {
  function harness(
    options: { stationViewStore?: StoreApi<TuiStore>; automations?: readonly Automation[] } = {},
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
    if (options.stationViewStore !== undefined) {
      runtimeOptions.stationViewStore = options.stationViewStore;
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
    const stationViewStore = createTuiStore({
      source: new FakeStationSource(snapshot),
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {},
    });
    const result = harness(
      automations === undefined ? { stationViewStore } : { stationViewStore, automations },
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
        { split: "right", anchor: "origin", command: "git diff | diffnav", run: "execute", focus: true },
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
    // index 3, after the two splits.
    runtime.dispatchMouse({ kind: "pane", paneId: agentPaneId }, RIGHT_DOWN);
    runtime.dispatchMouse({ kind: "contextMenuItemHover", itemIndex: 3 }, HOVER);
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
    // Split Right is item index 0 (the default active index).
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
    runtime.dispatchMouse({ kind: "contextMenuItem", itemIndex: 1 }, LEFT_DOWN);
    const created = store.getState().workspace.panes.find((pane) => pane.split !== null);
    expect(created?.split).toEqual({ anchorPaneId: MAIN_PANE_ID, direction: "below" });
  });
});
