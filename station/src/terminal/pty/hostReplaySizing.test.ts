/**
 * Reattach replay sizing, end to end through the real host socket and the real
 * registry wiring. Previous bugs, each pinned here:
 * - the scrollback snapshot (painted for the host PTY's recorded size, often
 *   the 80x24 spawn default) was parsed at the pane's size, so erase/cursor
 *   sequences landed on the wrong rows and mangled the replayed history;
 * - a same-size attach issued only a no-op TIOCSWINSZ (no SIGWINCH), so the
 *   child never repainted whatever the replay had left on screen;
 * - startup probes recorded in the ring (CPR/DA1/OSC) were re-answered by the
 *   fresh VT and written into the child's stdin as unsolicited input.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStationHostClient } from "@station/host";
import { afterEach, describe, expect, it } from "bun:test";
import { type StationHostInstance, startStationHost } from "../../host/startHost.js";
import { createPtyRegistry } from "../registry/ptyRegistry.js";
import { createScriptedTerminal, type ScriptedTerminal } from "../testing/scriptedTerminal.js";
import { waitFor } from "../testing/waitFor.js";
import type { StationVtScreen } from "../vt/screen.js";
import { createHostAttachedTerminal } from "./hostAttachedTerminal.js";

const noopLogger = { log: async () => undefined } as never;

// Mirrors DEFAULT_COLS / DEFAULT_ROWS hardcoded in the station terminal provider.
const HOST_SPAWN = { cols: 80, rows: 24 };
const PANE = "pane-replay";
const REAL_PTY_REPAINT = "REPAINT-AT-ANCHOR";
const REAL_PTY_REPAINT_CHILD = String.raw`
const CSI = "\x1b[";
const alternate = process.env.STATION_REAL_REPAINT_BUFFER === "alternate";
let repaintTimer;
let repainted = false;
const repaintWhenRestored = () => {
  if (process.stdout.rows !== 24) {
    repaintTimer = setTimeout(repaintWhenRestored, 10);
    return;
  }
  if (repainted) return;
  repainted = true;
  process.stdout.write(CSI + "4A\r" + CSI + "2K" + "REPAINT-AT-ANCHOR");
};
process.on("SIGWINCH", () => {
  clearTimeout(repaintTimer);
  repaintTimer = setTimeout(repaintWhenRestored, 0);
});
process.stdout.write(
  Array.from({ length: 32 }, (_, index) => "history-" + String(index).padStart(2, "0"))
    .join("\r\n") + "\r\n",
);
setTimeout(() => {
  process.stdout.write(
    (alternate ? CSI + "?1049h" : "") +
      CSI + "1;1H" + CSI + "1\"qP" + CSI + "0\"q" + CSI + "24;1HSTATEFUL-FRAME",
  );
}, 80);
setInterval(() => {}, 1_000);
`;

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startAgentHost(
  scripted: ScriptedTerminal,
): Promise<{ socketPath: string; ptyId: string }> {
  const dir = await mkdtemp(join(tmpdir(), "station-replay-sizing-"));
  const socketPath = join(dir, "station-host.sock");
  const host: StationHostInstance = await startStationHost({
    socketPath,
    stateDir: dir,
    logger: noopLogger,
    ptyTableOptions: { createTerminal: () => scripted.terminal },
  });
  cleanups.push(() => host.close());
  const control = createStationHostClient({ socketPath });
  cleanups.push(() => control.dispose());
  const { ptyId } = await control.spawn({
    terminalTargetId: "native:wt-replay",
    worktreeId: "wt-replay",
    projectId: "proj-replay",
    sessionId: "ses-replay",
    worktreePath: "/repo/wt-replay",
    harnessProvider: "codex",
    command: "codex",
    args: [],
    cwd: "/repo/wt-replay",
    cols: HOST_SPAWN.cols,
    rows: HOST_SPAWN.rows,
  });
  return { socketPath, ptyId };
}

async function startRealAgentHost(
  buffer: "normal" | "alternate",
): Promise<{ socketPath: string; ptyId: string }> {
  const dir = await mkdtemp(join(tmpdir(), "station-real-repaint-"));
  const socketPath = join(dir, "station-host.sock");
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const host: StationHostInstance = await startStationHost({
    socketPath,
    stateDir: dir,
    logger: noopLogger,
    ptyTableOptions: { maxScrollbackBytes: 64 },
  });
  cleanups.push(() => host.close());
  const control = createStationHostClient({ socketPath });
  cleanups.push(() => control.dispose());
  const { ptyId } = await control.spawn({
    terminalTargetId: "native:wt-real-repaint",
    worktreeId: "wt-real-repaint",
    projectId: "proj-real-repaint",
    sessionId: "ses-real-repaint",
    worktreePath: process.cwd(),
    harnessProvider: "scripted",
    command: process.execPath,
    args: ["-e", REAL_PTY_REPAINT_CHILD],
    env: { STATION_REAL_REPAINT_BUFFER: buffer },
    cwd: process.cwd(),
    cols: HOST_SPAWN.cols,
    rows: HOST_SPAWN.rows,
  });
  return { socketPath, ptyId };
}

/** Attach exactly as production does: registry entry with a host-attached override. */
function attachPane(
  socketPath: string,
  ptyId: string,
  size: { cols: number; rows: number },
): StationVtScreen {
  const registry = createPtyRegistry();
  cleanups.push(() => registry.disposeAll());
  registry.ensure(PANE, { cwd: "/repo/wt-replay" }, (spawn) =>
    createHostAttachedTerminal({
      hostSocketPath: socketPath,
      ptyId,
      size: { cols: spawn.size?.cols ?? 80, rows: spawn.size?.rows ?? 24 },
    }),
  );
  registry.resize(PANE, size);
  const screen = registry.get(PANE)?.screen;
  if (screen == null) {
    throw new Error("registry did not start a session");
  }
  return screen;
}

function visibleRows(screen: StationVtScreen, count: number): string[] {
  return Array.from({ length: count }, (_, index) => screen.rowText(index));
}

async function waitForReplayKind(
  control: ReturnType<typeof createStationHostClient>,
  ptyId: string,
  expected: string,
): Promise<string> {
  const deadline = Date.now() + 5_000;
  let replayKind = "";
  while (Date.now() < deadline) {
    const attachment = await control.attach(ptyId);
    replayKind = attachment.ack.replay.kind;
    await attachment.frames[Symbol.asyncIterator]().return?.();
    if (replayKind === expected) return replayKind;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return replayKind;
}

const PROMPT = "PROMPT> run agent";

/**
 * Ink/log-update-style repaint stream from a child that believes the terminal
 * is 80 cols: three 100-char logical lines hard-wrap into SIX physical rows at
 * 80 cols, so the frame update erases with 6x (CSI 1A cursor-up + CSI 2K
 * erase-line) before rewriting. Parsed at any other width, the six-row erase
 * would land on the wrong rows.
 */
function inkRepaintStreamFor80Cols(): string {
  const line = (ch: string): string => `${ch.repeat(100)}\r\n`;
  const frame = (ch: string): string => line(ch) + line(ch) + line(ch);
  const eraseSixPhysicalRows = "\x1b[1A\x1b[2K".repeat(6);
  return `${PROMPT}\r\n${frame("X")}${eraseSixPhysicalRows}${frame("Y")}`;
}

describe("snapshot replay parses at the recorded size, then reflows to the pane", () => {
  it("an 80-col ink repaint replayed into a 120x30 pane keeps the prompt and reflows the frame", async () => {
    const scripted = createScriptedTerminal({ ...HOST_SPAWN });
    const { socketPath, ptyId } = await startAgentHost(scripted);
    // Painted while no pane was attached; recorded verbatim into the ring.
    scripted.helpers.emitData(inkRepaintStreamFor80Cols());

    const screen = attachPane(socketPath, ptyId, { cols: 120, rows: 30 });
    await waitFor(() => visibleRows(screen, 30).some((row) => row.includes("Y")));
    await screen.whenIdle();
    await waitFor(() => screen.bufferStats().cols === 120);

    const rows = visibleRows(screen, 30);
    // The prompt survives (the erase stayed inside the frame it belonged to)
    // and the 100-char soft-wrapped rows rejoin at the wider pane.
    expect(rows.some((row) => row === PROMPT)).toBe(true);
    expect(rows.filter((row) => row === "Y".repeat(100)).length).toBe(3);
    expect(rows.some((row) => row.includes("X"))).toBe(false);
  });

  it("the same replay at the recorded size renders identically (no reflow needed)", async () => {
    const scripted = createScriptedTerminal({ ...HOST_SPAWN });
    const { socketPath, ptyId } = await startAgentHost(scripted);
    scripted.helpers.emitData(inkRepaintStreamFor80Cols());

    const screen = attachPane(socketPath, ptyId, { ...HOST_SPAWN });
    await waitFor(() => screen.rowText(1).startsWith("Y"));
    await screen.whenIdle();

    expect(screen.rowText(0)).toBe(PROMPT);
    expect(screen.rowText(1)).toBe("Y".repeat(80));
    expect(screen.rowText(2)).toBe("Y".repeat(20));
    expect(visibleRows(screen, 24).some((row) => row.includes("X"))).toBe(false);
  });
});

describe("same-size attach forces a child repaint", () => {
  it("flaps the rows so the child gets a real SIGWINCH after replaying history", async () => {
    const scripted = createScriptedTerminal({ ...HOST_SPAWN });
    const { socketPath, ptyId } = await startAgentHost(scripted);
    scripted.helpers.emitData("stale frame painted before reattach\r\n");

    attachPane(socketPath, ptyId, { ...HOST_SPAWN });
    await waitFor(() => scripted.helpers.resizes.length >= 3);

    expect(scripted.helpers.resizes).toEqual([
      { cols: 80, rows: 24 },
      { cols: 80, rows: 25 },
      { cols: 80, rows: 24 },
    ]);
  });

  it("a different-size attach relies on its own real size change (no flap)", async () => {
    const scripted = createScriptedTerminal({ ...HOST_SPAWN });
    const { socketPath, ptyId } = await startAgentHost(scripted);
    scripted.helpers.emitData("stale frame painted before reattach\r\n");

    attachPane(socketPath, ptyId, { cols: 120, rows: 30 });
    await waitFor(() => scripted.helpers.resizes.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(scripted.helpers.resizes).toEqual([{ cols: 120, rows: 30 }]);
  });

  it("an empty ring skips the flap (nothing on screen to repaint)", async () => {
    const scripted = createScriptedTerminal({ ...HOST_SPAWN });
    const { socketPath, ptyId } = await startAgentHost(scripted);

    attachPane(socketPath, ptyId, { ...HOST_SPAWN });
    await waitFor(() => scripted.helpers.resizes.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(scripted.helpers.resizes).toEqual([{ ...HOST_SPAWN }]);
  });
});

const describeRealPty: typeof describe =
  process.env.STATION_PTY_SMOKE === "1" ? describe : () => undefined;

describeRealPty("degraded same-size repaint through a real OS PTY", () => {
  it("keeps relative child repaint at its captured row while diagnosing absent history", async () => {
    for (const buffer of ["normal", "alternate"] as const) {
      const { socketPath, ptyId } = await startRealAgentHost(buffer);
      const control = createStationHostClient({ socketPath });
      cleanups.push(() => control.dispose());
      const replayKind = await waitForReplayKind(control, ptyId, "live-reset-recovery");
      expect(replayKind).toBe("live-reset-recovery");

      const screen = attachPane(socketPath, ptyId, { ...HOST_SPAWN });
      await waitFor(
        () => visibleRows(screen, HOST_SPAWN.rows).some((row) => row.includes(REAL_PTY_REPAINT)),
        5_000,
      );
      await screen.whenIdle();

      const rows = visibleRows(screen, HOST_SPAWN.rows);
      expect(screen.isAltScreen()).toBe(buffer === "alternate");
      expect(rows.findIndex((row) => row.includes(REAL_PTY_REPAINT))).toBe(
        HOST_SPAWN.rows - 5,
      );
      expect(rows[0]).not.toContain(REAL_PTY_REPAINT);
      expect(rows.some((row) => row.includes("history-"))).toBe(false);
      expect(screen.bufferStats().baseY).toBe(0);
      expect(screen.scrollBy(1)).toBe(false);
      expect(screen.getScrollOffset()).toBe(0);
    }
  });
});

describe("recorded startup probes are not re-answered on attach", () => {
  // CPR + DA1 + OSC 11 background query — the burst a codex-style TUI emits once at startup.
  const PROBE_BURST = "\x1b[6n\x1b[c\x1b]11;?\x07";
  // Non-global on purpose: a /g regex is stateful across .test()/.match() calls.
  const CPR_REPLY = /\x1b\[\d+;\d+R/;
  const DA1_REPLY = /\x1b\[\?1;2c/;
  const OSC11_REPLY = /\x1b\]11;rgb:/;
  const countMatches = (haystack: string, pattern: RegExp): number =>
    (haystack.match(new RegExp(pattern.source, "g")) ?? []).length;

  it("replaying a pre-attach probe burst writes nothing to the child; a live probe is answered once", async () => {
    const scripted = createScriptedTerminal({ ...HOST_SPAWN });
    const { socketPath, ptyId } = await startAgentHost(scripted);
    // The child probed at startup with no pane attached; the ring records it.
    scripted.helpers.emitData(PROBE_BURST);

    attachPane(socketPath, ptyId, { ...HOST_SPAWN });
    // The rows flap marks the attach (replay included) as fully settled.
    await waitFor(() => scripted.helpers.resizes.length >= 3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(scripted.helpers.writes.join("")).toBe("");

    scripted.helpers.emitData(PROBE_BURST);
    await waitFor(() => countMatches(scripted.helpers.writes.join(""), OSC11_REPLY) >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const written = scripted.helpers.writes.join("");
    expect(countMatches(written, CPR_REPLY)).toBe(1);
    expect(countMatches(written, DA1_REPLY)).toBe(1);
    expect(countMatches(written, OSC11_REPLY)).toBe(1);
  });
});
