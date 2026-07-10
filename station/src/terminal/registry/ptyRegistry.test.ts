import { describe, expect, it } from "bun:test";
import { createScriptedTerminal, type ScriptedTerminal } from "../testing/scriptedTerminal.js";
import type {
  StationTerminalProcess,
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

  it("uses refreshed runtime defaults for future lazy spawns only", () => {
    const first = createScriptedTerminal();
    const second = createScriptedTerminal();
    const registry = createPtyRegistry({
      createTerminal: () => first.terminal,
      scrollOnOutput: "freeze",
    });

    registry.resize(PANE_A, SIZE);
    registry.setRuntimeOptions({
      createTerminal: () => second.terminal,
      scrollOnOutput: "follow",
    });
    registry.resize(PANE_B, SIZE);

    expect(registry.get(PANE_A)?.terminal).toBe(first.terminal);
    expect(registry.get(PANE_B)?.terminal).toBe(second.terminal);
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
