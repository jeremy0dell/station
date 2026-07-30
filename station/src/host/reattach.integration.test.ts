import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStationHostClient } from "@station/host";
import { afterEach, describe, expect, it } from "bun:test";
import { createScriptedTerminal, type ScriptedTerminal } from "../terminal/testing/scriptedTerminal.js";
import { createHostAttachedTerminal } from "../terminal/pty/hostAttachedTerminal.js";
import { createStationVtScreen } from "../terminal/vt/screen.js";
import type { StationTerminalNotification } from "../terminal/types.js";
import type { PtyTableOptions } from "./ptyTable.js";
import { type StationHostInstance, startStationHost } from "./startHost.js";

const noopLogger = { log: async () => undefined } as never;
const identity = {
  terminalTargetId: "native:wt-1",
  worktreeId: "wt-1",
  projectId: "proj-1",
  sessionId: "ses-1",
  worktreePath: "/repo/wt-1",
  harnessProvider: "claude",
};

let host: StationHostInstance | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
});

async function startHostWith(
  scripted: ScriptedTerminal,
  options: Pick<PtyTableOptions, "maxScrollbackBytes" | "now"> = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "station-reattach-"));
  const socketPath = join(dir, "station-host.sock");
  host = await startStationHost({
    socketPath,
    stateDir: dir,
    logger: noopLogger,
    ptyTableOptions: { ...options, createTerminal: () => scripted.terminal },
  });
  return socketPath;
}

function screenText(screen: ReturnType<typeof createStationVtScreen>): string {
  const rows = screen.buildRows();
  return rows.map((row) => row.spans.map((span) => span.text).join("")).join("\n");
}

function visibleRows(screen: ReturnType<typeof createStationVtScreen>): string[] {
  return Array.from({ length: screen.unsafeEngine.rows }, (_, index) => screen.rowText(index));
}

describe("data-plane reattach (host PTY → host-attached terminal → VT screen)", () => {
  it("restores an OSC 8 URI by replaying the complete pre-attach PTY data event", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const socketPath = await startHostWith(scripted);
    const control = createStationHostClient({ socketPath });
    const { ptyId } = await control.spawn({
      ...identity,
      command: "claude",
      args: [],
      cwd: "/repo/wt-1",
      cols: 80,
      rows: 24,
    });
    const uri = "https://example.com/complete-host-replay";
    scripted.helpers.emitData(`\x1b]8;;${uri}\x1b\\reattached\x1b]8;;\x1b\\`);

    const terminal = createHostAttachedTerminal({
      hostSocketPath: socketPath,
      ptyId,
      size: { cols: 80, rows: 24 },
    });
    const screen = createStationVtScreen({ size: { cols: 80, rows: 24 } });
    terminal.onData((data) => screen.feed(data));

    try {
      await waitFor(() =>
        screen
          .buildRows({ cursorVisible: false })
          .some((row) => row.spans.some((span) => span.link === uri)),
      );
      expect(
        screen
          .buildRows({ cursorVisible: false })
          .some((row) => row.spans.some((span) => span.text === "reattached" && span.link === uri)),
      ).toBe(true);
    } finally {
      terminal.dispose();
      screen.dispose();
      control.dispose();
    }
  });

  it("replays scrollback then streams live output into a fresh screen, and detach keeps the PTY", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const socketPath = await startHostWith(scripted);

    // Spawn the agent in the host, then produce output BEFORE any client attaches.
    const control = createStationHostClient({ socketPath });
    const { ptyId } = await control.spawn({
      ...identity,
      command: "claude",
      args: [],
      cwd: "/repo/wt-1",
      cols: 80,
      rows: 24,
    });
    scripted.helpers.emitData("hello-scrollback");

    // A reattaching client: host-attached terminal feeding a brand-new screen.
    const terminal = createHostAttachedTerminal({
      hostSocketPath: socketPath,
      ptyId,
      size: { cols: 80, rows: 24 },
    });
    const screen = createStationVtScreen({ size: { cols: 80, rows: 24 } });
    terminal.onData((data) => screen.feed(data));

    await waitFor(() => screenText(screen).includes("hello-scrollback"));
    expect(screenText(screen)).toContain("hello-scrollback");

    // Live output after attach reaches the same screen.
    scripted.helpers.emitData(" then-live");
    await waitFor(() => screenText(screen).includes("then-live"));
    expect(screenText(screen)).toContain("then-live");

    // Input typed in the reattached pane reaches the host PTY.
    terminal.write("ls\n");
    await waitFor(() => scripted.helpers.writes.includes("ls\n"));
    expect(scripted.helpers.writes).toContain("ls\n");

    // Detaching (UI close) leaves the agent running in the host.
    terminal.dispose();
    await waitFor(async () => (await control.list())[0]?.alive === true);
    expect((await control.list())[0]).toMatchObject({ ptyId, alive: true });

    control.dispose();
  });

  it("reattaches an open content-free notification after replay with a stable id", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const socketPath = await startHostWith(scripted, {
      now: () => new Date("2026-07-29T12:34:56.000Z"),
    });
    const control = createStationHostClient({ socketPath });
    const { ptyId } = await control.spawn({
      ...identity,
      harnessProvider: "codex",
      command: "codex",
      args: [],
      cwd: "/repo/wt-1",
      cols: 80,
      rows: 24,
    });
    scripted.helpers.emitData("before\x1b]9;sensitive approval text\x07after");

    const first = createHostAttachedTerminal({
      hostSocketPath: socketPath,
      ptyId,
      size: { cols: 80, rows: 24 },
    });
    const screen = createStationVtScreen({ size: { cols: 80, rows: 24 } });
    const order: string[] = [];
    const firstNotifications: StationTerminalNotification[] = [];
    first.onReplay?.((replay) => {
      order.push("replay");
      for (const event of replay.events) {
        if (event.type === "data") screen.feed(event.data);
      }
    });
    first.onNotification?.((notification) => {
      order.push("notification");
      firstNotifications.push(notification);
    });

    try {
      await waitFor(() => firstNotifications.length === 1);
      await screen.whenIdle();
      expect(order).toEqual(["replay", "notification"]);
      expect(firstNotifications[0]).toMatchObject({
        kind: "osc9",
        observedAt: "2026-07-29T12:34:56.000Z",
      });
      expect(screenText(screen)).toContain("before");
      expect(screenText(screen)).toContain("after");
      expect(screenText(screen)).not.toContain("sensitive approval text");
    } finally {
      first.dispose();
      screen.dispose();
    }

    const second = createHostAttachedTerminal({
      hostSocketPath: socketPath,
      ptyId,
      size: { cols: 80, rows: 24 },
    });
    const secondNotifications: StationTerminalNotification[] = [];
    second.onNotification?.((notification) => secondNotifications.push(notification));
    try {
      await waitFor(() => secondNotifications.length === 1);
      expect(secondNotifications[0]?.id).toBe(firstNotifications[0]?.id);

      scripted.helpers.emitData("\x1b]9;another sensitive message\x1b\\");
      await waitFor(() => secondNotifications.length === 2);
      expect(secondNotifications[1]?.id).not.toBe(firstNotifications[0]?.id);
    } finally {
      second.dispose();
      control.dispose();
    }
  });

  it("reattaches through the same compatible stream that rescued live xterm history", async () => {
    const scripted = createScriptedTerminal({ cols: 40, rows: 51 });
    const socketPath = await startHostWith(scripted);
    const control = createStationHostClient({ socketPath });
    const { ptyId } = await control.spawn({
      ...identity,
      harnessProvider: "codex",
      command: "codex",
      args: [],
      cwd: "/repo/wt-1",
      cols: 40,
      rows: 51,
      outputCompatibility: "top-region-scrollback",
    });
    const rows = Array.from({ length: 51 }, (_, index) => `captured-row-${index + 1}`);
    const initial = `\x1b[H${rows.join("\r\n")}`;
    const captured = "\x1b[1;50r\x1b[3S\x1b[r\x1b[48;1H\x1b[J";
    scripted.helpers.emitData(initial + captured);

    const terminal = createHostAttachedTerminal({
      hostSocketPath: socketPath,
      ptyId,
      size: { cols: 40, rows: 51 },
    });
    const reattached = createStationVtScreen({ size: { cols: 40, rows: 51 }, scrollback: 100 });
    const unmodified = createStationVtScreen({ size: { cols: 40, rows: 51 }, scrollback: 100 });
    terminal.onData((data) => reattached.feed(data));
    unmodified.feed(initial + captured);
    try {
      await waitFor(() => reattached.unsafeEngine.buffer.normal.baseY === 3);
      await Promise.all([reattached.whenIdle(), unmodified.whenIdle()]);

      expect(visibleRows(reattached)).toEqual(visibleRows(unmodified));
      expect(unmodified.unsafeEngine.buffer.normal.baseY).toBe(0);
      expect(reattached.unsafeEngine.buffer.normal.baseY).toBe(3);
    } finally {
      terminal.dispose();
      reattached.dispose();
      unmodified.dispose();
      control.dispose();
    }
  });

  it("reattaches exactly through an OpenCode-like truncated wrap-pending frame", async () => {
    const scripted = createScriptedTerminal({ cols: 12, rows: 6 });
    const socketPath = await startHostWith(scripted, { maxScrollbackBytes: 5 });
    const control = createStationHostClient({ socketPath });
    const { ptyId } = await control.spawn({
      ...identity,
      harnessProvider: "opencode",
      command: "opencode",
      args: [],
      cwd: "/repo/wt-1",
      cols: 12,
      rows: 6,
    });
    scripted.helpers.emitData("\x1b[?1049h\x1b[2;5r\x1b[3;1H");
    scripted.helpers.emitData("abcdefghijkl");

    const captured = await control.attach(ptyId);
    expect(captured.ack.replay.kind).toBe("semantic-truncation-recovery");
    const replay = captured.ack.replay.events
      .flatMap((event) => (event.type === "data" ? [event.data] : []))
      .join("");
    const capturedScreen = createStationVtScreen({ size: { cols: 12, rows: 6 } });
    capturedScreen.feed(replay);
    await capturedScreen.whenIdle();
    expect(capturedScreen.unsafeEngine.buffer.active.type).toBe("alternate");
    expect(capturedScreen.rowText(2)).toBe("abcdefghijkl");
    expect(capturedScreen.unsafeEngine.buffer.active.cursorX).toBe(12);
    await captured.frames[Symbol.asyncIterator]().return?.();

    const terminal = createHostAttachedTerminal({
      hostSocketPath: socketPath,
      ptyId,
      size: { cols: 12, rows: 6 },
    });
    const reattached = createStationVtScreen({ size: { cols: 12, rows: 6 } });
    terminal.onData((data) => reattached.feed(data));
    try {
      await waitFor(() => reattached.unsafeEngine.buffer.active.cursorX === 12);
      expect(reattached.unsafeEngine.buffer.active.type).toBe("alternate");
      expect(reattached.rowText(2)).toBe("abcdefghijkl");

      scripted.helpers.emitData("Z");
      await waitFor(() => reattached.rowText(3).startsWith("Z"));
      expect(reattached.unsafeEngine.buffer.active.cursorX).toBe(1);
      terminal.write("agent-input");
      await waitFor(() => scripted.helpers.writes.includes("agent-input"));
      terminal.resize({ cols: 13, rows: 6 });
      await waitFor(() =>
        scripted.helpers.resizes.some(({ cols, rows }) => cols === 13 && rows === 6),
      );
      expect((await control.list())[0]).toMatchObject({ ptyId, alive: true });
    } finally {
      terminal.dispose();
      capturedScreen.dispose();
      reattached.dispose();
      control.dispose();
    }
  });
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
  }
}
