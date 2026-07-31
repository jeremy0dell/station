import { describe, expect, it } from "bun:test";
import {
  resetTerminalDiagnosticsForTest,
  terminalCorruptionCounters,
} from "../diagnostics.js";
import { createScriptedTerminal, type ScriptedTerminal } from "../testing/scriptedTerminal.js";
import type {
  StationTerminalDisposable,
  StationTerminalProcess,
  StationTerminalReplay,
  StationTerminalSize,
  StationTerminalSpawnOptions,
} from "../types.js";
import { createPtyRegistry } from "./ptyRegistry.js";

const PANE_A = "pane-a";
const PANE_B = "pane-b";
const SIZE: StationTerminalSize = { cols: 36, rows: 8 };

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

  it("restores semantic-copy metadata after exact VT replay and before live output", async () => {
    const { registry, replay } = orderedGeometryHarness();
    const screen = registry.get(PANE_A)?.screen;

    await replay({
      kind: "semantic-truncation-recovery",
      initialSize: { cols: 10, rows: 4 },
      events: [
        { type: "data", data: "first\r\n│ second" },
        {
          type: "semantic-copy",
          normal: [{ row: 1, leadingColumns: 2, separatorSpaces: 1 }],
          alternate: [],
        },
      ],
    });

    expect(screen?.viewRowCopyContinuation(1)).toEqual({
      kind: "application-soft",
      leadingColumns: 2,
      separatorSpaces: 1,
    });
  });

  it("an explicit empty semantic-copy sidecar clears stale metadata", async () => {
    const { registry, replay } = orderedGeometryHarness();
    const screen = registry.get(PANE_A)?.screen;
    screen?.feed("first\r\n\x1b]6973;station-copy;1;0\x1b\\stale");
    await screen?.whenIdle();
    expect(screen?.viewRowCopyContinuation(1)?.kind).toBe("application-soft");

    await replay({
      kind: "semantic-truncation-recovery",
      initialSize: { cols: 10, rows: 4 },
      events: [
        { type: "data", data: "\x1bcfirst\r\nhard" },
        { type: "semantic-copy", normal: [], alternate: [] },
      ],
    });

    expect(screen?.viewRowCopyContinuation(1)).toBeUndefined();
  });

  it("reports semantic-copy rows that do not map to the restored buffer", async () => {
    resetTerminalDiagnosticsForTest();
    const { registry, replay } = orderedGeometryHarness();
    try {
      await replay({
        kind: "semantic-truncation-recovery",
        initialSize: { cols: 10, rows: 4 },
        events: [
          { type: "data", data: "restored" },
          {
            type: "semantic-copy",
            normal: [{ row: 99, leadingColumns: 0, separatorSpaces: 0 }],
            alternate: [],
          },
        ],
      });

      expect(terminalCorruptionCounters()).toMatchObject({
        "terminal_diagnostic:semantic_copy_restore_dropped": 1,
      });
    } finally {
      registry.disposeAll();
      resetTerminalDiagnosticsForTest();
    }
  });

  it("clears stale state and reports an invalid local semantic-copy sidecar", async () => {
    resetTerminalDiagnosticsForTest();
    const { registry, replay } = orderedGeometryHarness();
    const screen = registry.get(PANE_A)?.screen;
    try {
      screen?.feed("first\r\n\x1b]6973;station-copy;1;0\x1b\\stale");
      await screen?.whenIdle();

      await replay({
        kind: "semantic-truncation-recovery",
        initialSize: { cols: 10, rows: 4 },
        events: [
          { type: "data", data: "hard" },
          {
            type: "semantic-copy",
            normal: [{ row: 1, leadingColumns: 0, separatorSpaces: 1025 }],
            alternate: [],
          },
        ],
      } as unknown as StationTerminalReplay);

      expect(screen?.viewRowCopyContinuation(1)).toBeUndefined();
      expect(terminalCorruptionCounters()).toMatchObject({
        "terminal_diagnostic:semantic_copy_restore_invalid": 1,
      });
    } finally {
      registry.disposeAll();
      resetTerminalDiagnosticsForTest();
    }
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
