import { afterEach, describe, expect, it } from "bun:test";
import { getLinkId, rgbToHex, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { MAIN_PANE_ID } from "../state/types.js";
import {
  nativeStationTheme,
  rgbColor,
  stationColorSnapshotValue,
  StationThemeProvider,
  toOpenTuiOpaqueColor,
  useStationThemeSource,
  type StationTheme,
  type StationThemeSource,
} from "../theme/index.js";
import { PaneRegistryProvider } from "./registry/paneTerminalContext.js";
import { createPtyRegistry, type PtyRegistry } from "./registry/ptyRegistry.js";
import { TerminalPane } from "./TerminalPane.js";
import { frameChar, spanAtFrameCell } from "./testing/frameProbe.js";
import { createScriptedTerminal, type ScriptedTerminal } from "./testing/scriptedTerminal.js";
import { waitFor } from "./testing/waitFor.js";
import type { StationTerminalSize, StationTerminalSpawnOptions } from "./types.js";

// Pane chrome: 1 border + 1 padding on each side. The origin-anchor test
// below derives this empirically; everything else trusts the constant.
const ORIGIN = { x: 2, y: 2 };
const SURFACE = { width: 40, height: 12 };
const GRID = { cols: SURFACE.width - 4, rows: SURFACE.height - 4 };

type PaneSetup = {
  setup: Awaited<ReturnType<typeof testRender>>;
  scripted: ScriptedTerminal;
  spawnSizes: StationTerminalSize[];
  registry: PtyRegistry;
  themeSource: MutableThemeSource;
};

class MutableThemeSource implements StationThemeSource {
  private snapshot: StationTheme;
  private readonly listeners = new Set<() => void>();

  constructor(snapshot: StationTheme) {
    this.snapshot = snapshot;
  }

  readonly getSnapshot = (): StationTheme => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(theme: StationTheme): void {
    this.snapshot = theme;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function ThemedTerminalPane({
  source,
  registry,
}: {
  source: StationThemeSource;
  registry: PtyRegistry;
}) {
  const theme = useStationThemeSource(source);
  return (
    <StationThemeProvider theme={theme}>
      <box
        width="100%"
        height="100%"
        backgroundColor={toOpenTuiOpaqueColor(theme.surfaces.canvas)}
      >
        <PaneRegistryProvider registry={registry}>
          <TerminalPane paneId={MAIN_PANE_ID} />
        </PaneRegistryProvider>
      </box>
    </StationThemeProvider>
  );
}

function appearanceTheme(
  defaultForeground: `#${string}`,
  defaultBackground: `#${string}`,
  ansiRed: `#${string}`,
  selection: `#${string}`,
  canvas: `#${string}`,
): StationTheme {
  const [ansiBlack, , ...ansiTail] = nativeStationTheme.terminal.ansi16;
  return {
    ...nativeStationTheme,
    surfaces: { ...nativeStationTheme.surfaces, canvas: rgbColor(canvas) },
    pane: { ...nativeStationTheme.pane, selection: rgbColor(selection) },
    terminal: {
      defaultForeground: rgbColor(defaultForeground),
      defaultBackground: rgbColor(defaultBackground),
      ansi16: [ansiBlack, rgbColor(ansiRed), ...ansiTail],
    },
  };
}

describe("TerminalPane frame rendering", () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const teardown of teardowns.splice(0)) {
      teardown();
    }
  });

  async function renderPane(
    spawnOptions?: StationTerminalSpawnOptions,
    theme: StationTheme = nativeStationTheme,
  ): Promise<PaneSetup> {
    // The pane spawns its PTY on first layout and updates through the registry
    // (an external store), so updates land outside React's act() from the very
    // first render; tests poll rendered frames rather than relying on act.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    const scripted = createScriptedTerminal({ cols: GRID.cols, rows: GRID.rows });
    const spawnSizes: StationTerminalSize[] = [];
    const registry = createPtyRegistry({
      createTerminal: (options) => {
        spawnSizes.push({
          cols: options.size?.cols ?? 0,
          rows: options.size?.rows ?? 0,
        });
        return scripted.terminal;
      },
    });
    registry.updateTerminalTheme(theme.terminal);
    // Pre-seed the entry so cwd is captured (the pane reports size but never
    // ensures); mirrors how an aux split is ensured with its inherited cwd.
    if (spawnOptions !== undefined) {
      registry.ensure(MAIN_PANE_ID, spawnOptions);
    }
    const themeSource = new MutableThemeSource(theme);
    const setup = await testRender(
      <ThemedTerminalPane source={themeSource} registry={registry} />,
      SURFACE,
    );
    teardowns.push(() => {
      registry.disposeAll();
      setup.renderer.destroy();
    });
    await setup.flush();
    await waitFor(() => spawnSizes.length > 0);
    return { setup, scripted, spawnSizes, registry, themeSource };
  }

  // The store flushes on a real timer, so frame-waiting must interleave
  // render passes with wall-clock sleeps; OpenTUI's waitForFrame only spins
  // render passes and would exhaust before the flush timer fires.
  async function waitForPaneFrame(
    pane: PaneSetup,
    predicate: (frame: string) => boolean,
    timeoutMs = 2_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let frame = "";
    while (true) {
      await pane.setup.renderOnce();
      frame = pane.setup.captureCharFrame();
      if (predicate(frame)) {
        return frame;
      }
      if (Date.now() > deadline) {
        throw new Error(`frame predicate timed out; last frame:\n${frame}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function feedAndFlush(pane: PaneSetup, data: string): Promise<void> {
    pane.scripted.helpers.emitData(data);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await pane.setup.renderOnce();
  }

  it("spawns the pty at the laid-out pane interior size", async () => {
    const pane = await renderPane();
    expect(pane.spawnSizes[0]).toEqual({ cols: GRID.cols, rows: GRID.rows });
  });

  it("anchors the grid origin inside border and padding", async () => {
    const pane = await renderPane();
    await feedAndFlush(pane, "ORIGIN");
    const frame = await waitForPaneFrame(pane, (f) => f.includes("ORIGIN"));
    expect(frameChar(frame, ORIGIN.y, ORIGIN.x)).toBe("O");
  });

  it("renders plain output with the pane default foreground", async () => {
    const pane = await renderPane();
    await feedAndFlush(pane, "hello station\r\nline two");
    await waitForPaneFrame(pane, (f) => f.includes("line two"));
    const frame = pane.setup.captureSpans();
    const span = spanAtFrameCell(frame, ORIGIN.y, ORIGIN.x);
    expect(span?.text).toContain("hello station");
    expect(rgbToHex(span?.fg as Parameters<typeof rgbToHex>[0])).toBe(
      stationColorSnapshotValue(nativeStationTheme.terminal.defaultForeground),
    );
  });

  it("renders sgr colors and attributes as styled cells", async () => {
    const pane = await renderPane();
    await feedAndFlush(pane, "\x1b[1;31mERR\x1b[0m \x1b[38;2;1;2;3mok");
    await waitForPaneFrame(pane, (f) => f.includes("ERR"));
    const frame = pane.setup.captureSpans();
    const errSpan = spanAtFrameCell(frame, ORIGIN.y, ORIGIN.x);
    expect(errSpan?.text).toContain("ERR");
    expect(rgbToHex(errSpan?.fg as Parameters<typeof rgbToHex>[0])).toBe(
      stationColorSnapshotValue(nativeStationTheme.terminal.ansi16[1]),
    );
    expect((errSpan?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    const okSpan = spanAtFrameCell(frame, ORIGIN.y, ORIGIN.x + 4);
    expect(rgbToHex(okSpan?.fg as Parameters<typeof rgbToHex>[0])).toBe("#010203");
  });

  it("updates UI paint and indexed VT projection without replacing the pane runtime", async () => {
    const initialTheme = appearanceTheme(
      "#111213",
      "#141516",
      "#171819",
      "#1a1b1c",
      "#1d1e1f",
    );
    const nextTheme = appearanceTheme(
      "#a1a2a3",
      "#a4a5a6",
      "#a7a8a9",
      "#aaabac",
      "#adaeaf",
    );
    const pane = await renderPane(undefined, initialTheme);
    await feedAndFlush(
      pane,
      "D\x1b[31mI\x1b[38;5;196mF\x1b[38;2;1;2;3mT\x1b[0m",
    );
    await waitForPaneFrame(pane, (frame) => frame.includes("DIFT"));
    const screen = pane.registry.get(MAIN_PANE_ID)?.screen;
    const terminal = pane.registry.get(MAIN_PANE_ID)?.terminal;
    const engine = screen?.unsafeEngine;
    const version = screen?.getVersion();
    const initialFrame = pane.setup.captureSpans();
    const initialDefault = spanAtFrameCell(initialFrame, ORIGIN.y, ORIGIN.x);
    const initialIndexed = spanAtFrameCell(initialFrame, ORIGIN.y, ORIGIN.x + 1);
    expect(initialDefault?.fg === undefined ? undefined : rgbToHex(initialDefault.fg)).toBe(
      "#111213",
    );
    expect(initialIndexed?.fg === undefined ? undefined : rgbToHex(initialIndexed.fg)).toBe(
      "#171819",
    );

    await act(async () => {
      pane.registry.updateTerminalTheme(nextTheme.terminal);
      pane.themeSource.set(nextTheme);
      await Promise.resolve();
    });
    await pane.setup.flush();

    expect(pane.registry.get(MAIN_PANE_ID)?.screen).toBe(screen);
    expect(pane.registry.get(MAIN_PANE_ID)?.terminal).toBe(terminal);
    expect(screen?.unsafeEngine).toBe(engine);
    expect(screen?.getVersion()).toBe((version ?? 0) + 1);
    const frame = pane.setup.captureSpans();
    const defaultCell = spanAtFrameCell(frame, ORIGIN.y, ORIGIN.x);
    const indexedCell = spanAtFrameCell(frame, ORIGIN.y, ORIGIN.x + 1);
    const fixedTailCell = spanAtFrameCell(frame, ORIGIN.y, ORIGIN.x + 2);
    const truecolorCell = spanAtFrameCell(frame, ORIGIN.y, ORIGIN.x + 3);
    const cursorCell = spanAtFrameCell(frame, ORIGIN.y, ORIGIN.x + 4);
    expect(defaultCell?.fg === undefined ? undefined : rgbToHex(defaultCell.fg)).toBe("#a1a2a3");
    expect(indexedCell?.fg === undefined ? undefined : rgbToHex(indexedCell.fg)).toBe("#a7a8a9");
    expect(fixedTailCell?.fg === undefined ? undefined : rgbToHex(fixedTailCell.fg)).toBe(
      "#ff0000",
    );
    expect(truecolorCell?.fg === undefined ? undefined : rgbToHex(truecolorCell.fg)).toBe(
      "#010203",
    );
    expect((cursorCell?.attributes ?? 0) & TextAttributes.INVERSE).toBe(TextAttributes.INVERSE);
    expect(defaultCell?.bg === undefined ? undefined : rgbToHex(defaultCell.bg)).toBe("#adaeaf");

    await pane.setup.mockMouse.drag(ORIGIN.x, ORIGIN.y, ORIGIN.x + 1, ORIGIN.y);
    await pane.setup.renderOnce();
    const selected = spanAtFrameCell(pane.setup.captureSpans(), ORIGIN.y, ORIGIN.x);
    expect(selected?.bg === undefined ? undefined : rgbToHex(selected.bg)).toBe("#aaabac");
  });

  it("projects an OSC 8 URI through the production registry, screen, and pane", async () => {
    const pane = await renderPane();
    const uri = "https://example.com/registry-projection";
    await feedAndFlush(pane, `\x1b]8;;${uri}\x1b\\label\x1b]8;;\x1b\\`);
    await waitForPaneFrame(pane, (frame) => frame.includes("label"));

    const screen = pane.registry.get(MAIN_PANE_ID)?.screen;
    expect(screen?.buildRows({ cursorVisible: false })[0]?.spans[0]?.link).toBe(uri);
    const frameIndex = ORIGIN.y * SURFACE.width + ORIGIN.x;
    expect(
      getLinkId(pane.setup.renderer.currentRenderBuffer.buffers.attributes[frameIndex] ?? 0),
    ).toBeGreaterThan(0);
  });

  it("shows the cursor as an inverse cell and hides it on dectcem", async () => {
    const pane = await renderPane();
    await feedAndFlush(pane, "abc");
    await waitForPaneFrame(pane, (f) => f.includes("abc"));
    let frame = pane.setup.captureSpans();
    let cursorSpan = spanAtFrameCell(frame, ORIGIN.y, ORIGIN.x + 3);
    expect((cursorSpan?.attributes ?? 0) & TextAttributes.INVERSE).toBe(TextAttributes.INVERSE);

    await feedAndFlush(pane, "\x1b[?25l");
    frame = pane.setup.captureSpans();
    cursorSpan = spanAtFrameCell(frame, ORIGIN.y, ORIGIN.x + 3);
    expect((cursorSpan?.attributes ?? 0) & TextAttributes.INVERSE).toBe(0);
  });

  it("resize reaches the pty at the new interior size and reflows", async () => {
    const pane = await renderPane();
    await feedAndFlush(pane, "before");
    pane.setup.resize(60, 20);
    await waitFor(() =>
      pane.scripted.helpers.resizes.some((size) => size.cols === 56 && size.rows === 16),
    );
    await feedAndFlush(pane, `\r\n${"=".repeat(56)}`);
    const frame = await waitForPaneFrame(pane, (f) => f.includes("=".repeat(56)));
    expect(frameChar(frame, ORIGIN.y + 1, ORIGIN.x + 55)).toBe("=");
  });

  it("shrinking leaves no stale cells outside the new pane bounds", async () => {
    const pane = await renderPane();
    const fullRow = "#".repeat(GRID.cols);
    await feedAndFlush(pane, Array.from({ length: GRID.rows }, () => fullRow).join("\r\n"));
    await waitForPaneFrame(pane, (f) => f.includes("#"));
    pane.setup.resize(30, 10);
    await waitFor(() =>
      pane.scripted.helpers.resizes.some((size) => size.cols === 26 && size.rows === 6),
    );
    await feedAndFlush(pane, "\x1b[2J\x1b[Hcompact");
    const frame = await waitForPaneFrame(pane, (f) => f.includes("compact"));
    const lines = frame.split("\n");
    for (const line of lines) {
      expect([...line].length).toBeLessThanOrEqual(30);
    }
    expect(frame).not.toContain("#");
  });

  it("alt-screen app takes over and exit restores the primary screen", async () => {
    const pane = await renderPane();
    await feedAndFlush(pane, "primary prompt\r\n");
    await waitForPaneFrame(pane, (f) => f.includes("primary prompt"));

    await feedAndFlush(pane, "\x1b[?1049h\x1b[2J\x1b[H\x1b[7m FAKE-VIM \x1b[0m");
    const altFrame = await waitForPaneFrame(pane, (f) => f.includes("FAKE-VIM"));
    expect(altFrame).not.toContain("primary prompt");
    const frame = pane.setup.captureSpans();
    const headerSpan = spanAtFrameCell(frame, ORIGIN.y, ORIGIN.x + 1);
    expect((headerSpan?.attributes ?? 0) & TextAttributes.INVERSE).toBe(TextAttributes.INVERSE);

    await feedAndFlush(pane, "\x1b[?1049l");
    await waitForPaneFrame(pane, (f) => f.includes("primary prompt"));
  });

  it("device queries round-trip through the pane to the pty", async () => {
    const pane = await renderPane();
    pane.scripted.helpers.emitData("\x1b[c");
    await waitFor(() => pane.scripted.helpers.writes.join("").includes("\x1b[?1;2c"));
  });

  it("stops forwarding query replies after the process exits", async () => {
    const pane = await renderPane();
    pane.scripted.helpers.emitExit({ exitCode: 0 });
    await pane.setup.flush();
    const writesBefore = pane.scripted.helpers.writes.length;
    pane.scripted.helpers.emitData("\x1b[c");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pane.scripted.helpers.writes.length).toBe(writesBefore);
  });

  it("surfaces the exit status in the pane title", async () => {
    const pane = await renderPane();
    pane.scripted.helpers.emitExit({ exitCode: 0 });
    await waitForPaneFrame(pane, (f) => f.includes("exited 0"));
  });

  it("falls back to the spawn-cwd folder name instead of the pid", async () => {
    const pane = await renderPane({ cwd: "/work/my-project" });
    const frame = await waitForPaneFrame(pane, (f) => f.includes("my-project"));
    expect(frame).not.toContain("terminal pid");
  });

  it("shows an app-set OSC title in the pane border instead of the pid", async () => {
    const pane = await renderPane();
    // OSC 2 (set window title) is how emulators learn what a pane is running.
    await feedAndFlush(pane, "\x1b]2;my-app\x07");
    const frame = await waitForPaneFrame(pane, (f) => f.includes("my-app"));
    expect(frame).not.toContain("terminal pid");
  });

  it("wraps paste only while the child has bracketed paste enabled", async () => {
    const pane = await renderPane();
    expect(pane.registry.paste(MAIN_PANE_ID, "plain")).toBe(true);
    expect(pane.scripted.helpers.writes[pane.scripted.helpers.writes.length - 1]).toBe("plain");

    await feedAndFlush(pane, "\x1b[?2004h");
    expect(pane.registry.paste(MAIN_PANE_ID, "wrapped")).toBe(true);
    expect(pane.scripted.helpers.writes[pane.scripted.helpers.writes.length - 1]).toBe(
      "\x1b[200~wrapped\x1b[201~",
    );

    await feedAndFlush(pane, "\x1b[?2004l");
    expect(pane.registry.paste(MAIN_PANE_ID, "plain again")).toBe(true);
    expect(pane.scripted.helpers.writes[pane.scripted.helpers.writes.length - 1]).toBe(
      "plain again",
    );
  });

  it("rejects paste after the process exits", async () => {
    const pane = await renderPane();
    pane.scripted.helpers.emitExit({ exitCode: 0 });
    await pane.setup.flush();
    const writesBefore = pane.scripted.helpers.writes.length;
    expect(pane.registry.paste(MAIN_PANE_ID, "late paste")).toBe(false);
    expect(pane.scripted.helpers.writes.length).toBe(writesBefore);
  });

  it("a resize storm settles on the final size, not an intermediate one", async () => {
    const pane = await renderPane();
    pane.setup.resize(60, 20);
    pane.setup.resize(50, 14);
    await waitFor(() =>
      pane.scripted.helpers.resizes.some((size) => size.cols === 46 && size.rows === 10),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const last = pane.scripted.helpers.resizes[pane.scripted.helpers.resizes.length - 1];
    expect(last).toEqual({ cols: 46, rows: 10 });
  });

  it("renders a consistent final frame after a burst", async () => {
    const pane = await renderPane();
    const burst = Array.from({ length: 200 }, (_, index) => `line-${index}`).join("\r\n");
    await feedAndFlush(pane, burst);
    const frame = await waitForPaneFrame(pane, (f) => f.includes("line-199"));
    // The bottom visible grid row holds the last line; earlier rows are the
    // contiguous tail of the scroll, not torn interleavings.
    expect(frameChar(frame, ORIGIN.y + GRID.rows - 1, ORIGIN.x)).toBe("l");
    expect(frame).toContain(`line-${199 - (GRID.rows - 1)}`);
  });
});
