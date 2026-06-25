import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStationHostClient } from "@station/host";
import { afterEach, describe, expect, it } from "bun:test";
import { createScriptedTerminal, type ScriptedTerminal } from "../terminal/testing/scriptedTerminal.js";
import { createHostAttachedTerminal } from "../terminal/pty/hostAttachedTerminal.js";
import { createStationVtScreen } from "../terminal/vt/screen.js";
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

async function startHostWith(scripted: ScriptedTerminal): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "station-reattach-"));
  const socketPath = join(dir, "station-host.sock");
  host = await startStationHost({
    socketPath,
    stateDir: dir,
    logger: noopLogger,
    ptyTableOptions: { createTerminal: () => scripted.terminal },
  });
  return socketPath;
}

function screenText(screen: ReturnType<typeof createStationVtScreen>): string {
  const rows = screen.buildRows();
  return rows.map((row) => row.spans.map((span) => span.text).join("")).join("\n");
}

describe("data-plane reattach (host PTY → host-attached terminal → VT screen)", () => {
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
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
  }
}
