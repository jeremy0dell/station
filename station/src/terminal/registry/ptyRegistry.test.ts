import { describe, expect, it } from "bun:test";
import { nativeStationTheme, type StationTerminalTheme } from "../../theme/index.js";
import { createScriptedTerminal, type ScriptedTerminal } from "../testing/scriptedTerminal.js";
import { waitFor } from "../testing/waitFor.js";
import type {
  StationTerminalDisposable,
  StationTerminalExit,
  StationTerminalProcess,
  StationTerminalReplay,
  StationTerminalSize,
  StationTerminalSpawnOptions,
} from "../types.js";
import type { StationVtScreen } from "../vt/screen.js";
import { createPtyRegistry } from "./ptyRegistry.js";

const PANE_A = "pane-a";
const PANE_B = "pane-b";
const PANE_C = "pane-c";
const SIZE: StationTerminalSize = { cols: 36, rows: 8 };

function oscRgb(color: StationTerminalTheme["defaultForeground"]): string {
  const value = color.value.slice(1);
  const red = value.slice(0, 2);
  const green = value.slice(2, 4);
  const blue = value.slice(4, 6);
  return `rgb:${red}${red}/${green}${green}/${blue}${blue}`;
}

function terminalTheme(
  defaultForeground: StationTerminalTheme["defaultForeground"],
  defaultBackground: StationTerminalTheme["defaultBackground"],
  ansiRed: StationTerminalTheme["ansi16"][1],
): StationTerminalTheme {
  const [ansiBlack, , ...ansiTail] = nativeStationTheme.terminal.ansi16;
  return {
    defaultForeground,
    defaultBackground,
    ansi16: [ansiBlack, ansiRed, ...ansiTail],
  };
}

function firstForeground(screen: StationVtScreen): string | undefined {
  return screen.buildRows({ cursorVisible: false })[0]?.spans[0]?.fg;
}

/** A registry whose PTYs are scripted terminals handed out in spawn order. */
function harness(options?: { count?: number; resizeDebounceMs?: number }) {
  const scripted: ScriptedTerminal[] = Array.from({ length: options?.count ?? 1 }, () =>
    createScriptedTerminal(),
  );
  const spawnSizes: StationTerminalSize[] = [];
  let spawnIndex = 0;
  const registry = createPtyRegistry({
    resizeDebounceMs: options?.resizeDebounceMs ?? 20,
    createTerminal: (spawn: StationTerminalSpawnOptions): StationTerminalProcess => {
      spawnSizes.push({ cols: spawn.size?.cols ?? 0, rows: spawn.size?.rows ?? 0 });
      const terminal = scripted[spawnIndex]?.terminal;
      if (terminal === undefined) {
        throw new Error("scripted terminal pool exhausted");
      }
      spawnIndex += 1;
      return terminal;
    },
  });
  return { registry, scripted, spawnSizes };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function orderedGeometryHarness() {
  const scripted = createScriptedTerminal({ cols: 10, rows: 4 });
  let replayListener:
    | ((replay: StationTerminalReplay) => void | Promise<void>)
    | undefined;
  let geometryListener:
    | ((size: StationTerminalSize) => void | Promise<void>)
    | undefined;
  const terminal = scripted.terminal as StationTerminalProcess & {
    onGeometry(
      listener: (size: StationTerminalSize) => void | Promise<void>,
    ): StationTerminalDisposable;
  };
  terminal.onReplay = (listener) => {
    replayListener = listener;
    return { dispose: () => {} };
  };
  terminal.onGeometry = (listener) => {
    geometryListener = listener;
    return { dispose: () => {} };
  };
  const registry = createPtyRegistry({ createTerminal: () => terminal });
  registry.resize(PANE_A, { cols: 5, rows: 4 });

  return {
    registry,
    scripted,
    replay: async (replay: StationTerminalReplay) => {
      if (replayListener === undefined) {
        throw new Error("Registry did not subscribe to replay events.");
      }
      await replayListener(replay);
    },
    geometry: async (size: StationTerminalSize) => {
      await geometryListener?.(size);
    },
  };
}

describe("createPtyRegistry", () => {
  it("does not spawn a PTY until the pane is first resized", () => {
    const { registry, spawnSizes } = harness();
    const entry = registry.ensure(PANE_A);
    expect(entry.screen).toBeNull();
    expect(entry.terminal).toBeNull();
    expect(spawnSizes.length).toBe(0);

    registry.resize(PANE_A, SIZE);
    expect(registry.get(PANE_A)?.terminal).not.toBe(null);
    expect(registry.get(PANE_A)?.screen).not.toBe(null);
    expect(spawnSizes[0]).toEqual(SIZE);
  });

  it("exposes the cwd captured on first ensure and preserves it on a no-option re-ensure", () => {
    const { registry } = harness();
    expect(registry.ensure(PANE_A, { cwd: "/work/dir" }).cwd).toBe("/work/dir");
    // Captured once: the reconciler's later no-option ensure must not clobber it.
    expect(registry.ensure(PANE_A).cwd).toBe("/work/dir");
    // A pane reserved without spawn options (or with options lacking cwd) has none.
    expect(registry.ensure(PANE_B).cwd).toBeUndefined();
  });

  it("routes writes to the addressed pane only", () => {
    const { registry, scripted } = harness({ count: 2 });
    registry.resize(PANE_A, SIZE);
    registry.resize(PANE_B, SIZE);

    expect(registry.write(PANE_A, "a-bytes")).toBe(true);
    expect(registry.write(PANE_B, "b-bytes")).toBe(true);

    expect(scripted[0].helpers.writes).toContain("a-bytes");
    expect(scripted[0].helpers.writes).not.toContain("b-bytes");
    expect(scripted[1].helpers.writes).toContain("b-bytes");
    expect(scripted[1].helpers.writes).not.toContain("a-bytes");
  });

  it("returns false writing to a pane with no live terminal", () => {
    const { registry } = harness();
    registry.ensure(PANE_A); // entry exists but never resized -> no PTY
    expect(registry.write(PANE_A, "x")).toBe(false);
    expect(registry.write("pane-missing", "x")).toBe(false);
  });

  it("stops accepting input after the process exits", () => {
    const { registry, scripted } = harness();
    registry.resize(PANE_A, SIZE);
    scripted[0].helpers.emitExit({ exitCode: 0 });
    expect(registry.get(PANE_A)?.exited).toBe(true);
    expect(registry.write(PANE_A, "late")).toBe(false);
    expect(scripted[0].helpers.writes).not.toContain("late");
  });

  it("surfaces the exit status and notifies subscribers", () => {
    const { registry, scripted } = harness();
    let notifications = 0;
    registry.subscribe(() => {
      notifications += 1;
    });
    registry.resize(PANE_A, SIZE); // spawn notify
    const afterSpawn = notifications;
    scripted[0].helpers.emitExit({ exitCode: 0 });
    expect(registry.get(PANE_A)?.status).toBe("exited 0");
    expect(notifications).toBeGreaterThan(afterSpawn);
  });

  it("notifies onPaneExit with the pane id when a spawned process exits", () => {
    const scripted = createScriptedTerminal();
    const exited: string[] = [];
    const registry = createPtyRegistry({
      createTerminal: () => scripted.terminal,
      onPaneExit: (paneId) => exited.push(paneId),
    });
    registry.ensure(PANE_A, { cwd: "/tmp" });
    registry.resize(PANE_A, SIZE); // lazy spawn on first resize
    scripted.helpers.emitExit({ exitCode: 0 });
    expect(exited).toEqual([PANE_A]);
  });

  it("marks attachment unavailable without reporting a pane exit or forwarding I/O", () => {
    const scripted = createScriptedTerminal();
    const exited: string[] = [];
    const registry = createPtyRegistry({
      createTerminal: () => scripted.terminal,
      onPaneExit: (paneId) => exited.push(paneId),
    });
    registry.resize(PANE_A, SIZE);

    scripted.helpers.emitUnavailable({
      code: "HOST_SNAPSHOT_FAILED",
      message: "snapshot failed",
    });

    expect(registry.get(PANE_A)).toMatchObject({
      exited: false,
      status: "attachment unavailable",
    });
    expect(registry.write(PANE_A, "late")).toBe(false);
    registry.resize(PANE_A, { cols: 40, rows: 10 });
    expect(scripted.helpers.resizes).toEqual([]);
    expect(exited).toEqual([]);
  });

  it("uses the latest pane-exit handler after replacement", () => {
    const scripted = createScriptedTerminal();
    const firstHandler: string[] = [];
    const secondHandler: string[] = [];
    const registry = createPtyRegistry({
      createTerminal: () => scripted.terminal,
      onPaneExit: (paneId) => firstHandler.push(paneId),
    });
    registry.ensure(PANE_A, { cwd: "/tmp" });
    registry.resize(PANE_A, SIZE);

    registry.setPaneExitHandler((paneId) => secondHandler.push(paneId));
    scripted.helpers.emitExit({ exitCode: 0 });

    expect(firstHandler).toEqual([]);
    expect(secondHandler).toEqual([PANE_A]);
  });

  it("uses refreshed runtime defaults for future lazy spawns only", async () => {
    const first = createScriptedTerminal();
    const second = createScriptedTerminal();
    const registry = createPtyRegistry({
      createTerminal: () => first.terminal,
      scrollOnOutput: "freeze",
      scrollbackLines: 1,
    });

    registry.resize(PANE_A, SIZE);
    registry.setRuntimeOptions({
      createTerminal: () => second.terminal,
      scrollOnOutput: "follow",
      scrollbackLines: 3,
    });
    registry.resize(PANE_B, SIZE);

    expect(registry.get(PANE_A)?.terminal).toBe(first.terminal);
    expect(registry.get(PANE_B)?.terminal).toBe(second.terminal);

    const output = Array.from({ length: 40 }, (_, index) => `line-${index}\r\n`).join("");
    first.helpers.emitData(output);
    second.helpers.emitData(output);
    await Promise.all([
      registry.get(PANE_A)?.screen?.whenIdle(),
      registry.get(PANE_B)?.screen?.whenIdle(),
    ]);

    expect(registry.get(PANE_A)?.screen?.bufferStats().baseY).toBe(1);
    expect(registry.get(PANE_B)?.screen?.bufferStats().baseY).toBe(3);
  });

  it("fans the latest terminal projection to existing and future screens only", async () => {
    const firstTheme = terminalTheme(
      nativeStationTheme.text.primary,
      nativeStationTheme.surfaces.canvas,
      nativeStationTheme.status.warning,
    );
    const nextTheme = terminalTheme(
      nativeStationTheme.action.primary,
      nativeStationTheme.contextMenu.surface,
      nativeStationTheme.status.accent,
    );
    const first = createScriptedTerminal();
    const second = createScriptedTerminal();
    let replay:
      | ((value: StationTerminalReplay) => void | Promise<void>)
      | undefined;
    first.terminal.onReplay = (listener) => {
      replay = listener;
      return { dispose: () => {} };
    };
    const spawned: StationTerminalProcess[] = [];
    let spawnIndex = 0;
    const registry = createPtyRegistry({
      createTerminal: () => {
        const terminal = [first.terminal, second.terminal][spawnIndex];
        if (terminal === undefined) {
          throw new Error("scripted terminal pool exhausted");
        }
        spawnIndex += 1;
        spawned.push(terminal);
        return terminal;
      },
    });
    registry.updateTerminalTheme(firstTheme);
    registry.ensure(PANE_A);
    registry.ensure(PANE_B);
    let structuralNotifications = 0;
    registry.subscribe(() => {
      structuralNotifications += 1;
    });

    registry.resize(PANE_A, SIZE);
    const firstEntry = registry.get(PANE_A);
    const firstScreen = firstEntry?.screen;
    const firstTerminal = firstEntry?.terminal;
    expect(firstScreen).not.toBeNull();
    expect(firstTerminal).toBe(first.terminal);

    await replay?.({
      kind: "raw-complete",
      initialSize: SIZE,
      events: [{ type: "data", data: "\x1b]10;?\x07" }],
    });
    expect(first.helpers.writes).toEqual([]);
    first.helpers.emitData("D\x1b[31mI\x1b[38;5;196mF\x1b[38;2;1;2;3mT");
    await firstScreen?.whenIdle();
    const initialForegrounds = firstScreen
      ?.buildRows({ cursorVisible: false })[0]
      ?.spans.map((span) => span.fg);
    expect(initialForegrounds?.[0]).toBeUndefined();
    expect(initialForegrounds?.[1]).toBe(firstTheme.ansi16[1].value);

    const notificationCount = structuralNotifications;
    const writesBefore = [...first.helpers.writes];
    const resizesBefore = [...first.helpers.resizes];
    const statsBefore = firstScreen?.bufferStats();
    registry.updateTerminalTheme(nextTheme);

    expect(registry.get(PANE_A)?.screen).toBe(firstScreen);
    expect(registry.get(PANE_A)?.terminal).toBe(firstTerminal);
    expect(firstScreen?.bufferStats()).toEqual(statsBefore);
    const updatedForegrounds = firstScreen
      ?.buildRows({ cursorVisible: false })[0]
      ?.spans.map((span) => span.fg);
    expect(updatedForegrounds?.[0]).toBeUndefined();
    expect(updatedForegrounds?.[1]).toBe(nextTheme.ansi16[1].value);
    expect(updatedForegrounds?.slice(2)).toEqual(initialForegrounds?.slice(2));
    expect(structuralNotifications).toBe(notificationCount);
    expect(first.helpers.writes).toEqual(writesBefore);
    expect(first.helpers.resizes).toEqual(resizesBefore);
    expect(first.helpers.isDisposed()).toBe(false);
    expect(spawned).toEqual([first.terminal]);

    registry.resize(PANE_B, SIZE);
    const secondScreen = registry.get(PANE_B)?.screen;
    second.helpers.emitData("D\x1b[31mI\x1b[38;5;196mF\x1b[38;2;1;2;3mT");
    await secondScreen?.whenIdle();
    expect(
      secondScreen?.buildRows({ cursorVisible: false })[0]?.spans.map((span) => span.fg),
    ).toEqual(updatedForegrounds);

    first.helpers.emitData("\x1b]10;?\x07\x1b]11;?\x07");
    second.helpers.emitData("\x1b]10;?\x07\x1b]11;?\x07");
    await Promise.all([firstScreen?.whenIdle(), secondScreen?.whenIdle()]);
    for (const scripted of [first, second]) {
      expect(scripted.helpers.writes).toContain(
        `\x1b]10;${oscRgb(nextTheme.defaultForeground)}\x07`,
      );
      expect(scripted.helpers.writes).toContain(
        `\x1b]11;${oscRgb(nextTheme.defaultBackground)}\x07`,
      );
      expect(scripted.helpers.isDisposed()).toBe(false);
    }
    expect(spawned).toEqual([first.terminal, second.terminal]);
  });

  it("publishes terminal projection atomically before repainting screens", async () => {
    const initialTheme = terminalTheme(
      nativeStationTheme.text.primary,
      nativeStationTheme.surfaces.canvas,
      nativeStationTheme.status.warning,
    );
    const nextTheme = terminalTheme(
      nativeStationTheme.action.primary,
      nativeStationTheme.contextMenu.surface,
      nativeStationTheme.status.accent,
    );
    const { registry, scripted } = harness({ count: 3 });
    registry.updateTerminalTheme(initialTheme);
    registry.resize(PANE_A, SIZE);
    registry.resize(PANE_B, SIZE);
    const firstScreen = registry.get(PANE_A)?.screen;
    const secondScreen = registry.get(PANE_B)?.screen;
    if (
      firstScreen === null ||
      firstScreen === undefined ||
      secondScreen === null ||
      secondScreen === undefined
    ) {
      throw new Error("Expected both existing screens to be initialized.");
    }
    scripted[0].helpers.emitData("\x1b[31mA");
    scripted[1].helpers.emitData("\x1b[31mB");
    await Promise.all([firstScreen.whenIdle(), secondScreen.whenIdle()]);
    await waitFor(() => firstScreen.getVersion() > 0 && secondScreen.getVersion() > 0);

    let firstRepaints = 0;
    let secondRepaints = 0;
    let observedDuringFirstRepaint: readonly (string | undefined)[] = [];
    firstScreen.subscribe((invalidation) => {
      if (invalidation !== "repaint") {
        return;
      }
      firstRepaints += 1;
      registry.resize(PANE_C, SIZE);
      observedDuringFirstRepaint = [
        firstForeground(firstScreen),
        firstForeground(secondScreen),
      ];
    });
    secondScreen.subscribe((invalidation) => {
      if (invalidation === "repaint") {
        secondRepaints += 1;
      }
    });

    registry.updateTerminalTheme(nextTheme);

    expect(observedDuringFirstRepaint).toEqual([
      nextTheme.ansi16[1].value,
      nextTheme.ansi16[1].value,
    ]);
    expect(firstRepaints).toBe(1);
    expect(secondRepaints).toBe(1);
    const lazyScreen = registry.get(PANE_C)?.screen;
    expect(lazyScreen).not.toBeNull();
    scripted[2].helpers.emitData("\x1b[31mC");
    await lazyScreen?.whenIdle();
    expect(
      lazyScreen === null || lazyScreen === undefined ? undefined : firstForeground(lazyScreen),
    ).toBe(nextTheme.ansi16[1].value);
  });

  it("disables scrollback when the configured depth is zero", async () => {
    const { registry, scripted } = harness();
    registry.setRuntimeOptions({ scrollOnOutput: "freeze", scrollbackLines: 0 });
    registry.resize(PANE_A, SIZE);

    scripted[0].helpers.emitData(
      Array.from({ length: 20 }, (_, index) => `line-${index}\r\n`).join(""),
    );
    const screen = registry.get(PANE_A)?.screen;
    await screen?.whenIdle();

    expect(screen?.bufferStats().baseY).toBe(0);
  });

  it("applies selected output compatibility to a locally owned PTY", async () => {
    const { registry, scripted } = harness();
    registry.ensure(PANE_A, { outputCompatibility: "top-region-scrollback" });
    registry.resize(PANE_A, { cols: 40, rows: 51 });

    const rows = Array.from({ length: 51 }, (_, index) => `captured-row-${index + 1}`);
    scripted[0].helpers.emitData(
      `\x1b[H${rows.join("\r\n")}\x1b[1;50r\x1b[3S\x1b[r\x1b[48;1H\x1b[J`,
    );
    const screen = registry.get(PANE_A)?.screen;
    await screen?.whenIdle();

    expect(screen?.bufferStats().baseY).toBe(3);
  });

  it("finishes local old-width output before applying a resize", async () => {
    const { registry, scripted } = harness({ resizeDebounceMs: 1 });
    registry.ensure(PANE_A, { outputCompatibility: "top-region-scrollback" });
    registry.resize(PANE_A, { cols: 10, rows: 4 });
    scripted[0].helpers.emitData("1234567890\rX\x1b[1;3r\x1b[");

    registry.resize(PANE_A, { cols: 5, rows: 4 });
    await sleep(20);
    const screen = registry.get(PANE_A)?.screen;
    await screen?.whenIdle();

    expect(screen?.viewRowText(0)).toBe("X2345");
    expect(screen?.viewRowText(1).trimEnd()).toBe("");
  });

  it("round-trips device queries from the screen back to the pty", async () => {
    const { registry, scripted } = harness();
    registry.resize(PANE_A, SIZE);
    const screen = registry.get(PANE_A)?.screen;
    scripted[0].helpers.emitData("\x1b[c");
    await screen?.whenIdle();
    expect(scripted[0].helpers.writes.join("")).toContain("\x1b[?1;2c");
  });

  it("stops forwarding query replies after the process exits", async () => {
    const { registry, scripted } = harness();
    registry.resize(PANE_A, SIZE);
    scripted[0].helpers.emitExit({ exitCode: 0 });
    const writesBefore = scripted[0].helpers.writes.length;
    scripted[0].helpers.emitData("\x1b[c");
    await registry.get(PANE_A)?.screen?.whenIdle();
    expect(scripted[0].helpers.writes.length).toBe(writesBefore);
  });

  it("wraps paste only while the child has bracketed paste enabled", async () => {
    const { registry, scripted } = harness();
    registry.resize(PANE_A, SIZE);
    const screen = registry.get(PANE_A)?.screen;

    expect(registry.paste(PANE_A, "plain")).toBe(true);
    expect(scripted[0].helpers.writes.at(-1)).toBe("plain");

    scripted[0].helpers.emitData("\x1b[?2004h");
    await screen?.whenIdle();
    expect(registry.paste(PANE_A, "wrapped")).toBe(true);
    expect(scripted[0].helpers.writes.at(-1)).toBe("\x1b[200~wrapped\x1b[201~");

    scripted[0].helpers.emitData("\x1b[?2004l");
    await screen?.whenIdle();
    expect(registry.paste(PANE_A, "plain again")).toBe(true);
    expect(scripted[0].helpers.writes.at(-1)).toBe("plain again");
  });

  it("rejects paste after the process exits", () => {
    const { registry, scripted } = harness();
    registry.resize(PANE_A, SIZE);
    scripted[0].helpers.emitExit({ exitCode: 0 });
    expect(registry.paste(PANE_A, "late paste")).toBe(false);
  });

  it("a resize storm settles on the final size, not an intermediate one", async () => {
    const { registry, scripted } = harness();
    registry.resize(PANE_A, SIZE); // first resize spawns; no terminal.resize yet
    registry.resize(PANE_A, { cols: 60, rows: 20 });
    registry.resize(PANE_A, { cols: 50, rows: 14 });
    await sleep(60);
    const resizes = scripted[0].helpers.resizes;
    expect(resizes.at(-1)).toEqual({ cols: 50, rows: 14 });
    expect(resizes.some((size) => size.cols === 60 && size.rows === 20)).toBe(false);
  });

  it("keeps an ordered Host screen at replay geometry until the resize barrier", async () => {
    const { registry, replay, geometry } = orderedGeometryHarness();
    const screen = registry.get(PANE_A)?.screen;

    await replay({ kind: "raw-complete", initialSize: { cols: 10, rows: 4 }, events: [] });
    expect(screen?.bufferStats()).toMatchObject({ cols: 10, rows: 4 });

    await geometry({ cols: 5, rows: 4 });
    expect(screen?.bufferStats()).toMatchObject({ cols: 5, rows: 4 });
  });

  it("replays retained bytes at each recorded Host geometry", async () => {
    const { registry, replay } = orderedGeometryHarness();
    const screen = registry.get(PANE_A)?.screen;

    await replay({
      kind: "raw-complete",
      initialSize: { cols: 10, rows: 4 },
      events: [
        { type: "data", data: "1234567890\rX" },
        { type: "resize", cols: 5, rows: 4 },
      ],
    });

    expect(screen?.viewRowText(0)).toBe("X2345");
    expect(screen?.viewRowText(1).trimEnd()).toBe("");
    expect(screen?.cursor()).toEqual({ x: 1, y: 0 });
  });

  it("parses pre-barrier output at 10 columns before reflowing it to 5", async () => {
    const { registry, scripted, replay, geometry } = orderedGeometryHarness();
    const screen = registry.get(PANE_A)?.screen;

    await replay({ kind: "raw-complete", initialSize: { cols: 10, rows: 4 }, events: [] });
    scripted.helpers.emitData("1234567890\rX");
    await screen?.whenIdle();
    await geometry({ cols: 5, rows: 4 });
    await screen?.whenIdle();

    expect(screen?.viewRowText(0)).toBe("X2345");
    expect(screen?.viewRowText(1).trimEnd()).toBe("");
    expect(screen?.cursor()).toEqual({ x: 1, y: 0 });
  });

  it("records a spawn failure once and never retries on later resizes", () => {
    let attempts = 0;
    const registry = createPtyRegistry({
      createTerminal: () => {
        attempts += 1;
        throw new Error("boom");
      },
    });
    registry.resize(PANE_A, SIZE);
    expect(attempts).toBe(1);
    expect(registry.get(PANE_A)?.status).toBe("failed to start shell");
    expect(registry.get(PANE_A)?.terminal).toBeNull();

    registry.resize(PANE_A, { cols: 40, rows: 12 });
    expect(attempts).toBe(1); // no retry
    expect(registry.write(PANE_A, "x")).toBe(false);
  });

  it("resets only the exact exited entry and respawns at its latest requested viewport", () => {
    const { registry, scripted, spawnSizes } = harness({ count: 2 });
    registry.ensure(PANE_A, { cwd: "/work/old" });
    registry.resize(PANE_A, SIZE);
    const exitedEntry = registry.get(PANE_A);
    if (exitedEntry === undefined) throw new Error("expected registry entry");
    scripted[0].helpers.emitExit({ exitCode: 0 });
    const latest = { cols: 52, rows: 14 };
    registry.resize(PANE_A, latest);
    let notifications = 0;
    registry.subscribe(() => {
      notifications += 1;
    });

    const reset = registry.resetExited(exitedEntry, { cwd: "/work/new" });

    expect(reset).toEqual({ kind: "reset", viewport: latest });
    expect(notifications).toBe(0);
    expect(scripted[0].helpers.isDisposed()).toBe(true);
    expect(registry.get(PANE_A)).toMatchObject({
      cwd: "/work/new",
      exited: false,
      screen: null,
      terminal: null,
    });
    if (reset.kind !== "reset") throw new Error("expected reset");
    registry.resize(PANE_A, reset.viewport);
    expect(spawnSizes).toEqual([SIZE, latest]);
    expect(registry.get(PANE_A)?.terminal).toBe(scripted[1].terminal);
  });

  it("ignores an old terminal's retained exit callback after replacement", () => {
    const old = createScriptedTerminal();
    const replacement = createScriptedTerminal();
    let oldExit: ((event: StationTerminalExit) => void) | undefined;
    const stickyOld: StationTerminalProcess = {
      ...old.terminal,
      onExit: (listener) => {
        oldExit = listener;
        // Model a callback already queued outside the subscription's cancellation boundary.
        return { dispose: () => {} };
      },
    };
    let spawn = 0;
    let exitNotifications = 0;
    const registry = createPtyRegistry({
      createTerminal: () => (spawn++ === 0 ? stickyOld : replacement.terminal),
      onPaneExit: () => {
        exitNotifications += 1;
      },
    });
    registry.resize(PANE_A, SIZE);
    const exitedEntry = registry.get(PANE_A);
    if (exitedEntry === undefined || oldExit === undefined) {
      throw new Error("expected the old terminal exit subscription");
    }
    oldExit({ exitCode: 0 });
    const reset = registry.resetExited(exitedEntry, { cwd: "/work/new" });
    if (reset.kind !== "reset") throw new Error("expected reset");
    registry.resize(PANE_A, reset.viewport);

    oldExit({ exitCode: 1 });

    expect(registry.get(PANE_A)?.terminal).toBe(replacement.terminal);
    expect(registry.get(PANE_A)?.exited).toBe(false);
    expect(exitNotifications).toBe(1);
  });

  it("refuses to reset live, unavailable, spawn-failed, missing, and superseded entries", () => {
    const live = harness();
    live.registry.resize(PANE_A, SIZE);
    const liveEntry = live.registry.get(PANE_A);
    if (liveEntry === undefined) throw new Error("expected live entry");
    expect(live.registry.resetExited(liveEntry, { cwd: "/new" })).toEqual({
      kind: "refused",
      reason: "not-exited",
    });

    live.scripted[0].helpers.emitUnavailable({ code: "HOST_SNAPSHOT_FAILED", message: "gone" });
    expect(live.registry.resetExited(liveEntry, { cwd: "/new" })).toEqual({
      kind: "refused",
      reason: "not-exited",
    });

    const failed = createPtyRegistry({
      createTerminal: () => {
        throw new Error("boom");
      },
    });
    failed.resize(PANE_A, SIZE);
    const failedEntry = failed.get(PANE_A);
    if (failedEntry === undefined) throw new Error("expected failed entry");
    expect(failed.resetExited(failedEntry, { cwd: "/new" })).toEqual({
      kind: "refused",
      reason: "not-exited",
    });

    const exited = harness({ count: 2 });
    exited.registry.resize(PANE_A, SIZE);
    const oldEntry = exited.registry.get(PANE_A);
    if (oldEntry === undefined) throw new Error("expected old entry");
    exited.scripted[0].helpers.emitExit({ exitCode: 0 });
    exited.registry.dispose(PANE_A);
    expect(exited.registry.resetExited(oldEntry, { cwd: "/new" })).toEqual({
      kind: "refused",
      reason: "missing",
    });
    exited.registry.ensure(PANE_A, { cwd: "/replacement" });
    expect(exited.registry.resetExited(oldEntry, { cwd: "/new" })).toEqual({
      kind: "refused",
      reason: "superseded",
    });
  });

  it("never falls back to the local terminal when a managed attach fails lazily", () => {
    let localAttempts = 0;
    let attachAttempts = 0;
    const registry = createPtyRegistry({
      createTerminal: () => {
        localAttempts += 1;
        return createScriptedTerminal().terminal;
      },
    });
    registry.ensure(PANE_A, undefined, () => {
      attachAttempts += 1;
      throw new Error("host attach failed");
    });

    registry.resize(PANE_A, SIZE);

    expect(attachAttempts).toBe(1);
    expect(localAttempts).toBe(0);
    expect(registry.get(PANE_A)?.status).toBe("failed to start shell");
    expect(registry.get(PANE_A)?.terminal).toBeNull();
  });

  it("dispose tears down the pane and removes its entry", () => {
    const { registry, scripted } = harness();
    registry.resize(PANE_A, SIZE);
    registry.dispose(PANE_A);
    expect(scripted[0].helpers.isDisposed()).toBe(true);
    expect(registry.get(PANE_A)).toBeUndefined();
    expect(registry.has(PANE_A)).toBe(false);
    expect(registry.write(PANE_A, "x")).toBe(false);
  });

  it("disposeAll tears down every pane", () => {
    const { registry, scripted } = harness({ count: 2 });
    registry.resize(PANE_A, SIZE);
    registry.resize(PANE_B, SIZE);
    expect(registry.entries().length).toBe(2);
    registry.disposeAll();
    expect(scripted[0].helpers.isDisposed()).toBe(true);
    expect(scripted[1].helpers.isDisposed()).toBe(true);
    expect(registry.entries().length).toBe(0);
  });
});
