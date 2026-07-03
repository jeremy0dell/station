import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { TopRowWidgetRuntimeDeps, TuiConfig } from "@station/dashboard-core/widgets/types";
import type { StationMouseEvent } from "../input/mouse.js";
import { createStation, StationApp } from "./createStation.js";
import { NO_OP_CLIPBOARD_EFFECTS } from "../copy/testing.js";
import { selectStationOverlayVisible } from "../state/selectors.js";
import { createStationStore } from "../state/store.js";
import type { StationLayoutSnapshot } from "../state/layout/layoutSnapshot.js";
import { agentWorktreePaneId, MAIN_PANE_ID, STATION_OVERLAY_ID } from "../state/types.js";
import { createScriptedTerminal } from "../terminal/testing/scriptedTerminal.js";
import { waitFor } from "../terminal/testing/waitFor.js";
import { manyProjectsSnapshot, noProjectsSnapshot } from "../station/fixtures/scenarios.js";
import { FakeStationSource } from "../station/test/support/fakeStationSource.js";
import { FakeTuiObserverService } from "../station/test/support/fakeObserverService.js";
import { createStationStubObserverService } from "../station/store/stubObserverService.js";
import { stationPopupLayout } from "../station/StationOverlay.js";

const SURFACE = { width: 100, height: 28 };
const teardowns: Array<() => void> = [];
const LEFT_DOWN: StationMouseEvent = {
  type: "down",
  button: "left",
  rawButton: 0,
  x: 2,
  y: 0,
  modifiers: { shift: false, alt: false, ctrl: false },
};
const RIGHT_DOWN: StationMouseEvent = {
  ...LEFT_DOWN,
  button: "right",
  rawButton: 2,
};

describe("Station app composition", () => {
  afterEach(() => {
    for (const teardown of teardowns.splice(0)) {
      teardown();
    }
  });

  it("wires overlay input, source updates, preserved view state, and teardown", async () => {
    const station = await renderComposedStation();

    station.setup.mockInput.pressKey("o", { ctrl: true });
    await waitFor(() => overlayVisible(station));
    expect(await waitForFrame(station, (frame) => frame.includes("station  5 sessions"))).toContain(
      "station  5 sessions",
    );

    await station.setup.mockInput.typeText("blocked");
    expect(station.scripted.helpers.writes.join("")).not.toContain("blocked");

    await station.setup.mockInput.typeText("C1");
    await waitFor(() => station.composition.stationViewStore.getState().collapsedProjectIds.has("station"));
    station.setup.mockInput.pressKey("o", { ctrl: true });
    await waitFor(() => !overlayVisible(station));
    station.setup.mockInput.pressKey("o", { ctrl: true });
    await waitFor(() => overlayVisible(station));
    expect(station.composition.stationViewStore.getState().collapsedProjectIds.has("station")).toBe(true);

    station.source.setSnapshot(noProjectsSnapshot());
    expect(await waitForFrame(station, (frame) => frame.includes("No projects configured yet."))).toContain(
      "No projects configured yet.",
    );

    station.setup.mockInput.pressKey("c", { ctrl: true });
    await waitFor(() => !overlayVisible(station));
    station.setup.mockInput.pressKey("o", { ctrl: true });
    await waitFor(() => overlayVisible(station));
    expect(await waitForFrame(station, (frame) => frame.includes("No projects configured yet."))).toContain(
      "No projects configured yet.",
    );

    station.composition.stationInput.dispatchMouse({ kind: "header" }, LEFT_DOWN);
    await waitFor(() => !overlayVisible(station));
    station.composition.stationInput.dispatchMouse({ kind: "header" }, LEFT_DOWN);
    await waitFor(() => overlayVisible(station));
    expect(await waitForFrame(station, (frame) => frame.includes("No projects configured yet."))).toContain(
      "No projects configured yet.",
    );

    station.composition.stationInput.dispatchMouse({ kind: "header" }, LEFT_DOWN);
    await waitFor(() => !overlayVisible(station));
    await station.setup.mockInput.typeText("allowed");
    await waitFor(() => station.scripted.helpers.writes.join("").includes("allowed"));

    station.composition.dispose();
    // Two source subscribers detach on dispose: the STATION view store and the
    // session-removal reconciler.
    expect(station.source.unsubscribeCount).toBe(2);
    expect(station.source.stopped).toBe(1);
    expect(station.scripted.helpers.isDisposed()).toBe(true);
  });

  it("renders configured widgets in the Station overlay header", async () => {
    const station = await renderComposedStation({
      tuiConfig: {
        widgets: [
          { type: "time", timeFormat: "24h" },
          { type: "weather", city: "New York, NY", label: "NYC" },
        ],
      },
      topRowWidgetDeps: {
        now: () => new Date(2026, 5, 2, 10, 42),
        weatherClient: {
          getCurrentWeather: async () => ({
            temperature: 72,
            weatherCode: 0,
            isDay: true,
          }),
        },
      },
    });

    station.setup.mockInput.pressKey("o", { ctrl: true });
    await waitFor(() => overlayVisible(station));
    const frame = await waitForFrame(station, (candidate) => candidate.includes("NYC · 72°"));

    expect(frame).toContain("10:42");
    expect(frame).toContain("NYC · 72°");
  });

  it("closes STATION on click-away without writing mouse bytes to the pane underneath", async () => {
    const station = await renderComposedStation();
    const screen = station.composition.registry.get(MAIN_PANE_ID)?.screen;
    expect(screen == null).toBe(false);
    station.scripted.helpers.emitData("\x1b[?1000h\x1b[?1006h");
    await screen!.whenIdle();

    station.setup.mockInput.pressKey("o", { ctrl: true });
    await waitFor(() => overlayVisible(station));
    await station.setup.renderOnce();
    const before = station.scripted.helpers.writes.length;
    const outside = outsidePopupCell();

    await station.setup.mockMouse.click(outside.col, outside.row, MouseButtons.LEFT);

    await waitFor(() => !overlayVisible(station));
    expect(station.scripted.helpers.writes.slice(before)).toEqual([]);
  });

  it("swallows right-click and wheel outside STATION without reaching the pane", async () => {
    const station = await renderComposedStation();
    const screen = station.composition.registry.get(MAIN_PANE_ID)?.screen;
    station.scripted.helpers.emitData("\x1b[?1000h\x1b[?1006h");
    await screen!.whenIdle();

    station.setup.mockInput.pressKey("o", { ctrl: true });
    await waitFor(() => overlayVisible(station));
    await station.setup.renderOnce();
    const before = station.scripted.helpers.writes.length;
    const outside = outsidePopupCell();

    await station.setup.mockMouse.click(outside.col, outside.row, MouseButtons.RIGHT);
    await station.setup.mockMouse.scroll(outside.col, outside.row, "down");
    await station.setup.renderOnce();

    expect(overlayVisible(station)).toBe(true);
    expect(station.store.getState().input.contextMenu).toBeNull();
    expect(station.scripted.helpers.writes.slice(before)).toEqual([]);
  });

  it("lets the context menu backdrop close a STATION context menu before STATION click-away", async () => {
    const station = await renderComposedStation();
    station.setup.mockInput.pressKey("o", { ctrl: true });
    await waitFor(() => overlayVisible(station));
    await station.setup.renderOnce();

    station.composition.stationInput.dispatchMouse(
      { kind: "station", target: { kind: "projectHeader", projectId: "station" } },
      RIGHT_DOWN,
    );
    expect(station.store.getState().input.contextMenu?.target.kind).toBe("station");
    await station.setup.renderOnce();
    const outside = outsidePopupCell();

    await station.setup.mockMouse.click(outside.col, outside.row, MouseButtons.LEFT);

    await waitFor(() => station.store.getState().input.contextMenu === null);
    expect(station.store.getState().input.activeOverlay).toBe(STATION_OVERLAY_ID);
  });

  it("starts empty on the welcome screen and opens panes only through project view", async () => {
    const station = await renderComposedStation({ boot: "empty" });
    expect(station.store.getState().workspace.panes).toEqual([]);
    expect(station.spawnCount()).toBe(0);
    expect(station.composition.registry.entries()).toEqual([]);

    const initialFrame = await waitForFrame(
      station,
      (frame) =>
        frame.includes("Welcome to") &&
        frame.includes("Open project view"),
    );
    expect(hasStandaloneStationLine(initialFrame)).toBe(false);
    expect(initialFrame).not.toContain("terminal pid");
    expect(initialFrame).not.toContain("pty-buffer - shell");
    expect(initialFrame).not.toContain("starting shell");
    expect(initialFrame).not.toContain("terminal starting shell");
    const ctaRows = buttonRows(initialFrame);
    expect(ctaRows).toHaveLength(3);
    expect(ctaRows[0]?.trim()).toMatch(/^\+-+\+$/);
    expect(ctaRows[1]).toContain("Open project view");
    expect(ctaRows[2]?.trim()).toMatch(/^\+-+\+$/);

    station.composition.stationInput.dispatchMouse({ kind: "welcomeOpenProjectView" }, LEFT_DOWN);
    await waitFor(() => overlayVisible(station));
    expect(await waitForFrame(station, (frame) => frame.includes("station  5 sessions"))).toContain(
      "station  5 sessions",
    );
    expect(station.spawnCount()).toBe(0);

    station.composition.stationInput.dispatchMouse(
      { kind: "station", target: { kind: "openShellForRow", rowId: "wt_station_idle" } },
      LEFT_DOWN,
    );
    await waitFor(() => station.store.getState().workspace.panes.length === 1);
    station.store.actions.closeOverlay();
    await waitFor(() => !overlayVisible(station));
    await waitForFrame(station, (frame) => frame.includes("pty-buffer - shell"));
    await station.setup.mockInput.typeText("allowed");
    await waitFor(() => station.scripted.helpers.writes.join("").includes("allowed"));
    expect(station.spawnCount()).toBe(1);
  });

  it("returns to welcome when STATION closes before a pane is created", async () => {
    const station = await renderComposedStation({ boot: "empty" });
    station.composition.stationInput.dispatchMouse({ kind: "welcomeOpenProjectView" }, LEFT_DOWN);
    await waitFor(() => overlayVisible(station));

    station.store.actions.closeOverlay();

    expect(station.store.getState().input.focus).toEqual({ kind: "welcome" });
    expect(await waitForFrame(station, (frame) => frame.includes("Open project view"))).toContain(
      "Welcome to",
    );
  });

  it("reconciles the registry to created and closed pane records", async () => {
    const station = await renderComposedStation();
    expect(station.composition.registry.has(MAIN_PANE_ID)).toBe(true);

    station.store.actions.createPane("pane-second", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    const paneRecord = station.store
      .getState()
      .workspace.panes.find((pane) => pane.id === "pane-second");
    expect(paneRecord).toEqual({
      id: "pane-second",
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
      role: "shell",
    });
    expect(station.composition.registry.has("pane-second")).toBe(true);

    station.store.actions.closePane("pane-second");
    expect(station.composition.registry.has("pane-second")).toBe(false);
    // The original pane is never torn down by switching to and from it.
    expect(station.composition.registry.has(MAIN_PANE_ID)).toBe(true);
  });

  it("reports a primary-agent pane's PTY exit to the observer by its terminal target", () => {
    const { composition, store, service, scripted } = composeStationForExit();
    const paneId = agentWorktreePaneId("wt_station_idle");
    store.actions.createPane(paneId, { role: "primary-agent" });
    store.actions.setPrimaryAgent(paneId, {
      sessionId: "ses_managed",
      terminalTargetId: "native:wt_station_idle",
    });

    // Lazy spawn on first resize, then the harness process exits.
    composition.registry.ensure(paneId, { cwd: "/tmp/station/station/idle" });
    composition.registry.resize(paneId, { cols: 80, rows: 24 });
    scripted.helpers.emitExit({ exitCode: 0 });

    // The composition glue resolved paneId → terminalTargetId and reported it.
    expect(service.reportedExits).toEqual(["native:wt_station_idle"]);
  });

  it("can preserve live PTYs across HMR-style composition disposal", () => {
    const store = createStationStore();
    const firstSource = new FakeStationSource(manyProjectsSnapshot());
    const firstService = new FakeTuiObserverService(manyProjectsSnapshot());
    const scripted = createScriptedTerminal();
    const first = createStation({
      store,
      clipboardEffects: NO_OP_CLIPBOARD_EFFECTS,
      stationClient: {
        state: firstSource,
        service: firstService,
        start: () => firstSource.start(),
        stop: () => firstSource.stop(),
      },
      shutdown: () => {},
      createTerminal: () => scripted.terminal,
    });
    teardowns.push(() => first.dispose());

    const paneId = agentWorktreePaneId("wt_station_idle");
    store.actions.createPane(paneId, { role: "primary-agent" });
    store.actions.setPrimaryAgent(paneId, {
      sessionId: "ses_managed",
      terminalTargetId: "native:wt_station_idle",
    });
    first.registry.ensure(paneId, { cwd: "/tmp/station/station/idle" });
    first.registry.resize(paneId, { cols: 80, rows: 24 });

    first.disposeForHotReload();
    expect(scripted.helpers.isDisposed()).toBe(false);
    expect(first.registry.has(paneId)).toBe(true);
    expect(store.getState().workspace.activePaneId).toBe(paneId);

    const secondSource = new FakeStationSource(manyProjectsSnapshot());
    const secondService = new FakeTuiObserverService(manyProjectsSnapshot());
    const second = createStation({
      store,
      clipboardEffects: NO_OP_CLIPBOARD_EFFECTS,
      registry: first.registry,
      stationClient: {
        state: secondSource,
        service: secondService,
        start: () => secondSource.start(),
        stop: () => secondSource.stop(),
      },
      shutdown: () => {},
    });
    teardowns.push(() => second.dispose());

    scripted.helpers.emitExit({ exitCode: 0 });

    expect(firstService.reportedExits).toEqual([]);
    expect(secondService.reportedExits).toEqual(["native:wt_station_idle"]);
  });

  it("does not report a [+sh] shell pane's exit (no managed identity)", () => {
    const { composition, store, service, scripted } = composeStationForExit();
    store.actions.createPane("pane-shell", { role: "shell" });

    composition.registry.ensure("pane-shell", { cwd: "/tmp" });
    composition.registry.resize("pane-shell", { cols: 80, rows: 24 });
    scripted.helpers.emitExit({ exitCode: 0 });

    expect(service.reportedExits).toEqual([]);
  });

  it("tears down a session's panes and switches when the observer drops the session", () => {
    const store = createStationStore();
    const base = manyProjectsSnapshot();
    const removed = base.sessions[0]!;
    const survivor = base.sessions.find((session) => session.id !== removed.id)!;
    const source = new FakeStationSource(base);
    const scripted = createScriptedTerminal();
    const composition = createStation({
      store,
      clipboardEffects: NO_OP_CLIPBOARD_EFFECTS,
      stationClient: {
        state: source,
        service: new FakeTuiObserverService(base),
        start: () => source.start(),
        stop: () => source.stop(),
      },
      shutdown: () => {},
      createTerminal: () => scripted.terminal,
    });
    teardowns.push(() => composition.dispose());
    composition.start();

    // Two managed sessions on screen; the removed one carries an extra split shell.
    const removedAgent = agentWorktreePaneId(removed.worktreeId);
    const removedShell = `${removedAgent}-sh`;
    const survivorAgent = agentWorktreePaneId(survivor.worktreeId);
    store.actions.createPane(removedAgent, { role: "primary-agent" });
    store.actions.setPrimaryAgent(removedAgent, {
      sessionId: removed.id,
      terminalTargetId: "t-removed",
    });
    store.actions.createPane(removedShell, {
      split: { anchorPaneId: removedAgent, direction: "right" },
    });
    store.actions.createPane(survivorAgent, { role: "primary-agent" });
    store.actions.setPrimaryAgent(survivorAgent, {
      sessionId: survivor.id,
      terminalTargetId: "t-survivor",
    });

    // A snapshot tick still listing both sessions records them as live (seen),
    // so a later disappearance reads as a removal rather than a mid-launch gap.
    source.setSnapshot({ ...base, sessions: [...base.sessions] });
    store.actions.focusPane(removedAgent);

    // The observer drops the first session: its agent pane and split close, and
    // the view switches to the surviving agent session (not the boot shell).
    source.setSnapshot({ ...base, sessions: base.sessions.filter((s) => s.id !== removed.id) });

    const panes = store.getState().workspace.panes.map((pane) => pane.id);
    expect(panes).not.toContain(removedAgent);
    expect(panes).not.toContain(removedShell);
    expect(panes).toContain(survivorAgent);
    expect(store.getState().workspace.activePaneId).toBe(survivorAgent);
    expect(composition.registry.has(removedAgent)).toBe(false);
    expect(composition.registry.has(removedShell)).toBe(false);
  });

  it("persists the layout (with per-pane cwd) on structural change when configured", async () => {
    const store = createStationStore();
    const source = new FakeStationSource(manyProjectsSnapshot());
    const scripted = createScriptedTerminal();
    const writes: StationLayoutSnapshot[] = [];
    const composition = createStation({
      store,
      clipboardEffects: NO_OP_CLIPBOARD_EFFECTS,
      stationClient: {
        state: source,
        service: new FakeTuiObserverService(manyProjectsSnapshot()),
        start: () => source.start(),
        stop: () => source.stop(),
      },
      shutdown: () => {},
      createTerminal: () => scripted.terminal,
      layout: { path: "/unused-in-test", write: (snapshot) => writes.push(snapshot), debounceMs: 5 },
    });
    teardowns.push(() => composition.dispose());

    composition.start();
    // start() seeds an initial write so a restored session re-persists at once.
    await waitFor(() => writes.length >= 1);

    const before = writes.length;
    // Mirror splitPane/openPane: seed the cwd via ensure BEFORE createPane so the
    // snapshot captures it (the documented ensure-before-createPane invariant).
    composition.registry.ensure("pane-split-9", { cwd: "/work/root/sub" });
    store.actions.createPane("pane-split-9", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    await waitFor(() => writes.length > before);

    const latest = writes.at(-1)!;
    expect(latest.panes.map((pane) => pane.id)).toEqual([MAIN_PANE_ID, "pane-split-9"]);
    expect(latest.panes[1]?.split).toEqual({ anchorPaneId: MAIN_PANE_ID, direction: "right" });
    expect(latest.activePaneId).toBe("pane-split-9");
    expect(latest.cwdByPane["pane-split-9"]).toBe("/work/root/sub");
  });

  it("writes widget settings changes to config.toml", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "station-widget-config-"));
    teardowns.push(() => rmSync(tempDir, { recursive: true, force: true }));
    const projectRoot = join(tempDir, "project");
    mkdirSync(projectRoot);
    const configPath = join(tempDir, "config.toml");
    writeFileSync(
      configPath,
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[[tui.widgets]]
type = "time"

[[projects]]
id = "web"
label = "web"
root = "${projectRoot}"
`,
      "utf8",
    );

    const store = createStationStore();
    const source = new FakeStationSource(manyProjectsSnapshot());
    const scripted = createScriptedTerminal();
    const composition = createStation({
      store,
      clipboardEffects: NO_OP_CLIPBOARD_EFFECTS,
      stationClient: {
        state: source,
        service: new FakeTuiObserverService(manyProjectsSnapshot()),
        start: () => source.start(),
        stop: () => source.stop(),
      },
      shutdown: () => {},
      createTerminal: () => scripted.terminal,
      tuiConfig: { widgets: [{ type: "time" }] },
      tuiConfigPath: configPath,
    });
    teardowns.push(() => composition.dispose());

    composition.start();
    composition.stationViewStore.setState({ widgets: [{ type: "moon" }] });

    await waitFor(() => readFileSync(configPath, "utf8").includes('type = "moon"'));
    const sourceText = readFileSync(configPath, "utf8");
    expect(sourceText).toContain("[[tui.widgets]]\ntype = \"moon\"");
    expect(sourceText).not.toContain('type = "time"');
  });
});

/** A composition wired to a recording observer service, for exit-report glue tests. */
function composeStationForExit() {
  const store = createStationStore();
  const source = new FakeStationSource(manyProjectsSnapshot());
  const service = new FakeTuiObserverService(manyProjectsSnapshot());
  const scripted = createScriptedTerminal();
  const composition = createStation({
    store,
    clipboardEffects: NO_OP_CLIPBOARD_EFFECTS,
    stationClient: {
      state: source,
      service,
      start: () => source.start(),
      stop: () => source.stop(),
    },
    shutdown: () => {},
    createTerminal: () => scripted.terminal,
  });
  teardowns.push(() => composition.dispose());
  return { composition, store, service, scripted };
}

async function waitForFrame(
  station: Awaited<ReturnType<typeof renderComposedStation>>,
  predicate: (frame: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + 2_000;
  let frame = "";
  for (;;) {
    await station.setup.renderOnce();
    frame = station.setup.captureCharFrame();
    if (predicate(frame)) {
      return frame;
    }
    if (Date.now() > deadline) {
      throw new Error(`frame predicate timed out; last frame:\n${frame}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function renderComposedStation(options: {
  tuiConfig?: TuiConfig;
  topRowWidgetDeps?: TopRowWidgetRuntimeDeps;
  boot?: "empty";
} = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  const store =
    options?.boot === "empty" ? createStationStore({ boot: "empty" }) : createStationStore();
  const source = new TrackingStationSource(manyProjectsSnapshot());
  const scripted = createScriptedTerminal();
  const shutdowns: number[] = [];
  let spawnCount = 0;
  const composition = createStation({
    store,
    clipboardEffects: NO_OP_CLIPBOARD_EFFECTS,
    stationClient: {
      state: source,
      service: createStationStubObserverService(source, { dispatchDelayMs: 1 }),
      start: () => {
        source.start();
      },
      stop: () => source.stop(),
    },
    shutdown: () => {
      shutdowns.push(1);
    },
    createTerminal: () => {
      spawnCount += 1;
      return scripted.terminal;
    },
    ...(options.tuiConfig === undefined ? {} : { tuiConfig: options.tuiConfig }),
    ...(options.topRowWidgetDeps === undefined
      ? {}
      : { topRowWidgetDeps: options.topRowWidgetDeps }),
  });

  const setup = await testRender(<StationApp {...composition.viewProps} />, {
    ...SURFACE,
    prependInputHandlers: [composition.stationInput.handleSequence],
    kittyKeyboard: false,
  });
  setup.renderer.keyInput.on("paste", (event) => {
    composition.stationInput.handlePaste(event);
  });
  teardowns.push(() => {
    composition.dispose();
    setup.renderer.destroy();
  });

  composition.start();
  await setup.flush();
  await waitFor(() => scripted.helpers.writes !== undefined);

  return { composition, scripted, setup, shutdowns, source, store, spawnCount: () => spawnCount };
}

function overlayVisible(station: Awaited<ReturnType<typeof renderComposedStation>>): boolean {
  return selectStationOverlayVisible(station.store.getState());
}

function outsidePopupCell(): { col: number; row: number } {
  const layout = stationPopupLayout(SURFACE.width, SURFACE.height);
  return {
    col: Math.max(0, layout.left - 1),
    row: Math.max(0, layout.top - 1),
  };
}

class TrackingStationSource extends FakeStationSource {
  unsubscribeCount = 0;

  override subscribe(listener: () => void): () => void {
    const unsubscribe = super.subscribe(listener);
    return () => {
      this.unsubscribeCount += 1;
      unsubscribe();
    };
  }
}

function buttonRows(frame: string): string[] {
  const rows = frame.split("\n");
  const labelIndex = rows.findIndex((row) => row.includes("Open project view"));
  if (labelIndex < 1) {
    return [];
  }
  return rows.slice(labelIndex - 1, labelIndex + 2);
}

function hasStandaloneStationLine(frame: string): boolean {
  return frame.split("\n").some((row) => row.trim() === "station");
}
