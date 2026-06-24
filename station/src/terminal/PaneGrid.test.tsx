import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import { createStationStore } from "../state/store.js";
import { agentWorktreePaneId, MAIN_PANE_ID, STATION_OVERLAY_ID } from "../state/types.js";
import { PaneGrid } from "./PaneGrid.js";
import { PANE_BORDER_ACTIVE, PANE_BORDER_INACTIVE } from "./TerminalPane.js";
import { PaneRegistryProvider } from "./registry/paneTerminalContext.js";
import { createPtyRegistry } from "./registry/ptyRegistry.js";
import { spanAtFrameCell } from "./testing/frameProbe.js";
import { createScriptedTerminal, type ScriptedTerminal } from "./testing/scriptedTerminal.js";
import { waitFor } from "./testing/waitFor.js";
import type { StationTerminalSize } from "./types.js";
import { manyProjectsSnapshot } from "../station/fixtures/scenarios.js";
import { makeStationTestStore } from "../station/test/support/makeStationTestStore.js";

const SURFACE = { width: 40, height: 12 };
// One pane filling the surface: TerminalPane border + padding eat 2 cells each side.
const FULL_INTERIOR = { cols: SURFACE.width - 4, rows: SURFACE.height - 4 };

describe("PaneGrid", () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const teardown of teardowns.splice(0)) {
      teardown();
    }
  });

  async function renderGrid(options?: { withStationSnapshot?: boolean }) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    const spawnSizes: StationTerminalSize[] = [];
    const terminals: ScriptedTerminal[] = [];
    const registry = createPtyRegistry({
      createTerminal: (options) => {
        const size = { cols: options.size?.cols ?? 0, rows: options.size?.rows ?? 0 };
        spawnSizes.push(size);
        const scripted = createScriptedTerminal(size);
        terminals.push(scripted);
        return scripted.terminal;
      },
    });
    const store = createStationStore();
    const stationViewStore =
      options?.withStationSnapshot === true
        ? makeStationTestStore({ snapshot: manyProjectsSnapshot() }).store
        : undefined;
    const dispatchMouse = (_target: MouseTargetRef, _event: StationMouseEvent): boolean => true;
    const setup = await testRender(
      <PaneRegistryProvider registry={registry}>
        <PaneGrid
          store={store}
          {...(stationViewStore === undefined ? {} : { stationViewStore })}
          dispatchMouse={dispatchMouse}
        />
      </PaneRegistryProvider>,
      SURFACE,
    );
    teardowns.push(() => {
      registry.disposeAll();
      setup.renderer.destroy();
    });
    await setup.flush();
    await waitFor(() => spawnSizes.length > 0);
    return { setup, registry, store, spawnSizes, terminals, stationViewStore };
  }

  // A store change re-renders PaneGrid; the new layout pass (which fires the
  // viewport resize that lazily spawns a pane) needs render passes, so pump
  // renderOnce between sleeps until the condition holds.
  async function pumpUntil(
    setup: Awaited<ReturnType<typeof renderGrid>>["setup"],
    predicate: () => boolean,
    timeoutMs = 2_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      await setup.renderOnce();
      if (Date.now() > deadline) {
        throw new Error("pumpUntil timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function allForegroundHexes(setup: Awaited<ReturnType<typeof renderGrid>>["setup"]): Set<string> {
    const frame = setup.captureSpans();
    const hexes = new Set<string>();
    for (let row = 0; row < SURFACE.height; row++) {
      for (let col = 0; col < SURFACE.width; col++) {
        const span = spanAtFrameCell(frame, row, col);
        if (span?.fg !== undefined) {
          hexes.add(rgbToHex(span.fg as Parameters<typeof rgbToHex>[0]));
        }
      }
    }
    return hexes;
  }

  it("renders a single pane filling the surface", async () => {
    const { spawnSizes } = await renderGrid();
    expect(spawnSizes.length).toBe(1);
    expect(spawnSizes[0]).toEqual(FULL_INTERIOR);
  });

  it("splits right into two panes, the new one narrower than the original full width", async () => {
    const { setup, store, spawnSizes } = await renderGrid();
    store.actions.createPane("pane-split-0", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    await pumpUntil(setup, () => spawnSizes.length >= 2);
    expect(spawnSizes.length).toBe(2);
    // The new pane took half the width, so its interior is narrower than the
    // original full-width spawn.
    expect(spawnSizes[1]!.cols).toBeGreaterThan(0);
    expect(spawnSizes[1]!.cols).toBeLessThan(spawnSizes[0]!.cols);
  });

  it("keeps a pane's PTY alive across a split-and-close reshape", async () => {
    const { setup, store, registry, terminals } = await renderGrid();
    const mainTerminal = registry.get(MAIN_PANE_ID)?.terminal;
    expect(mainTerminal != null).toBe(true);

    store.actions.createPane("pane-split-0", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    await pumpUntil(setup, () => registry.get("pane-split-0")?.terminal != null);
    store.actions.closePane("pane-split-0");
    await pumpUntil(setup, () => !store.getState().workspace.panes.some((p) => p.id === "pane-split-0"));

    // The reshape remounted main's TerminalPane, but the registry — not the
    // component — owns the PTY, so it is never disposed.
    expect(registry.has(MAIN_PANE_ID)).toBe(true);
    expect(registry.get(MAIN_PANE_ID)?.terminal).toBe(mainTerminal ?? null);
    expect(terminals[0]!.helpers.isDisposed()).toBe(false);
  });

  it("keeps the right side tiled after closing one pane in a stacked split", async () => {
    const { setup, store, registry } = await renderGrid();
    store.actions.createPane("pane-right-top", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    await pumpUntil(setup, () => registry.get("pane-right-top")?.terminal != null);

    store.actions.createPane("pane-right-bottom", {
      split: { anchorPaneId: "pane-right-top", direction: "below" },
    });
    await pumpUntil(setup, () => registry.get("pane-right-bottom")?.terminal != null);

    store.actions.closePane("pane-right-top");
    await pumpUntil(
      setup,
      () => registry.get("pane-right-bottom")?.terminal?.size.rows === FULL_INTERIOR.rows,
    );

    expect(registry.get("pane-right-bottom")?.terminal?.size.cols).toBeLessThan(FULL_INTERIOR.cols);
  });

  it("does not re-spawn an existing pane's PTY when the layout reshapes", async () => {
    const { setup, store, spawnSizes } = await renderGrid();
    expect(spawnSizes.length).toBe(1);
    store.actions.createPane("pane-split-0", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    await pumpUntil(setup, () => spawnSizes.length >= 2);
    // Exactly one new spawn (the split pane); main remounted but reused its entry.
    expect(spawnSizes.length).toBe(2);
  });

  it("highlights the active pane border and dims inactive panes", async () => {
    const { setup, store } = await renderGrid();
    // Single pane: main is active, so its border uses the active accent.
    expect(allForegroundHexes(setup).has(PANE_BORDER_ACTIVE)).toBe(true);

    store.actions.createPane("pane-split-0", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    await pumpUntil(setup, () => store.getState().workspace.activePaneId === "pane-split-0");
    // Let the reshaped layout settle into a frame.
    await pumpUntil(setup, () => allForegroundHexes(setup).has(PANE_BORDER_INACTIVE));

    const hexes = allForegroundHexes(setup);
    expect(hexes.has(PANE_BORDER_ACTIVE)).toBe(false); // the active split shell is not blue
    expect(hexes.has(PANE_BORDER_INACTIVE)).toBe(true); // the dimmed original
    expect([...hexes].some((hex) => hex !== PANE_BORDER_INACTIVE)).toBe(true);
  });

  it("titles a primary-agent pane from the STATION session and harness", async () => {
    const { setup, store, spawnSizes } = await renderGrid({ withStationSnapshot: true });
    const paneId = agentWorktreePaneId("wt_station_idle");
    store.actions.createPane(paneId, { role: "primary-agent" });
    store.actions.setPrimaryAgent(paneId, {
      sessionId: "ses_wt_station_idle",
      terminalTargetId: "native:wt_station_idle",
    });

    await pumpUntil(
      setup,
      () => spawnSizes.length >= 2 && setup.captureCharFrame().includes("pty-buffer - codex agent"),
    );

    const frame = setup.captureCharFrame();
    expect(frame).toContain("pty-buffer - codex agent");
    expect(frame).not.toContain("terminal pid");
  });

  it("opens a second session full-screen instead of tiling it (no split)", async () => {
    const { setup, store, registry, spawnSizes } = await renderGrid();
    expect(spawnSizes.length).toBe(1);
    expect(spawnSizes[0]).toEqual(FULL_INTERIOR);

    // No split metadata → this roots a NEW session, shown full-screen.
    store.actions.createPane("pane-session-2");
    await pumpUntil(setup, () => spawnSizes.length >= 2);

    expect(spawnSizes.length).toBe(2);
    // The second session fills the surface exactly like the first — it is NOT
    // tiled beside it (a tiled split makes the new pane narrower; cf. split-right).
    expect(spawnSizes[1]).toEqual(FULL_INTERIOR);
    expect(store.getState().workspace.activePaneId).toBe("pane-session-2");
    // The first session's pane is hidden but still alive in the registry.
    expect(registry.has(MAIN_PANE_ID)).toBe(true);
  });

  it("forwards a click to a mouse-reporting pane at the border/padding-offset cell", async () => {
    const { setup, registry, terminals } = await renderGrid();
    const screen = registry.get(MAIN_PANE_ID)?.screen;
    expect(screen == null).toBe(false);
    // The child app turns on mouse reporting (SGR), as it streams to the screen.
    terminals[0]!.helpers.emitData("\x1b[?1000h\x1b[?1006h");
    await screen!.whenIdle();
    expect(screen!.mouseProtocol()).not.toBeNull();

    const before = terminals[0]!.helpers.writes.length;
    // TerminalPane's border+padding put the screen interior origin at (2,2), so
    // an absolute click at (5,5) lands on local cell (3,3) -> 1-based col 4, row 4.
    await setup.mockMouse.click(5, 5);
    expect(terminals[0]!.helpers.writes.slice(before)).toEqual(["\x1b[<0;4;4M", "\x1b[<0;4;4m"]);
  });

  it("suppresses click forwarding while the STATION overlay owns input", async () => {
    const { setup, store, registry, terminals } = await renderGrid();
    const screen = registry.get(MAIN_PANE_ID)?.screen;
    terminals[0]!.helpers.emitData("\x1b[?1000h\x1b[?1006h");
    await screen!.whenIdle();

    store.actions.openOverlay(STATION_OVERLAY_ID);
    await setup.renderOnce();
    const before = terminals[0]!.helpers.writes.length;
    // A click in the pane margin behind the centered overlay must not leak in.
    await setup.mockMouse.click(5, 5);
    expect(terminals[0]!.helpers.writes.slice(before)).toEqual([]);
  });

  it("switches back to a hidden session full-screen, reusing its live PTY", async () => {
    const { setup, store, registry, terminals, spawnSizes } = await renderGrid();
    const mainTerminal = registry.get(MAIN_PANE_ID)?.terminal;

    store.actions.createPane("pane-session-2");
    await pumpUntil(setup, () => spawnSizes.length >= 2);

    store.actions.focusPane(MAIN_PANE_ID);
    // Main re-mounts full-screen: its active border returns and the now-hidden
    // session contributes no (dimmed) border to the frame.
    await pumpUntil(setup, () => {
      const hexes = allForegroundHexes(setup);
      return hexes.has(PANE_BORDER_ACTIVE) && !hexes.has(PANE_BORDER_INACTIVE);
    });

    expect(spawnSizes.length).toBe(2); // no third spawn — the PTY was reused
    expect(registry.get(MAIN_PANE_ID)?.terminal).toBe(mainTerminal ?? null);
    expect(terminals[0]!.helpers.isDisposed()).toBe(false);
  });
});
