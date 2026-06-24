import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStationHostClient, type HostListEntry } from "@station/host";
import { buildLayoutSnapshot } from "./layoutSnapshot.js";
import { applyRestoreSeeds, planLayoutRestoreWarm } from "./restoreLayout.js";
import { createStationStore } from "../store.js";
import type { WorkspaceSlice } from "../types.js";
import { createHostBackedTerminal } from "../../terminal/pty/hostBackedTerminal.js";
import { createPtyRegistry } from "../../terminal/registry/ptyRegistry.js";
import { createScriptedTerminal, type ScriptedTerminal } from "../../terminal/testing/scriptedTerminal.js";
import { type StationHostInstance, startStationHost } from "../../host/startHost.js";
import type { StationVtScreen } from "../../terminal/vt/screen.js";

// Warm reattach end-to-end against a REAL host daemon: an aux PTY spawned into the
// host survives a "UI restart" and warm-reattaches with its scrollback via the
// restore planner + createHostBackedTerminal; once the host PTY is gone the same
// planner cold-respawns instead.

const noopLogger = { log: async () => undefined } as never;
let host: StationHostInstance | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
});

async function startHostWith(scripted: ScriptedTerminal): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "station-warm-"));
  const socketPath = join(dir, "station-host.sock");
  host = await startStationHost({
    socketPath,
    stateDir: dir,
    logger: noopLogger,
    ptyTableOptions: { createTerminal: () => scripted.terminal },
  });
  return socketPath;
}

function screenText(screen: StationVtScreen): string {
  return screen.buildRows().map((row) => row.spans.map((span) => span.text).join("")).join("\n");
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timed out");
}

function auxSnapshot() {
  const workspace: WorkspaceSlice = {
    panes: [{ id: "pane-split-0", split: null, role: "shell" }],
    activePaneId: "pane-split-0",
  };
  return buildLayoutSnapshot(workspace, () => "/work", () => "aux:pane-split-0");
}

function warmDeps(socketPath: string, live: HostListEntry[]) {
  return {
    liveByTarget: new Map(live.map((entry) => [entry.terminalTargetId, entry])),
    makeHostTerminal: (entry: HostListEntry) => (options: { size?: { cols?: number; rows?: number } }) =>
      createHostBackedTerminal({
        hostSocketPath: socketPath,
        ptyId: entry.ptyId,
        size: { cols: options.size?.cols ?? 80, rows: options.size?.rows ?? 24 },
      }),
  };
}

describe("warm reattach (real host: aux PTY survives a UI restart)", () => {
  it("warm-reattaches a live aux PTY with its scrollback, then cold-respawns once it is gone", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const socketPath = await startHostWith(scripted);
    const client = createStationHostClient({ socketPath });

    // --- session 1: spawn a Station-owned aux shell into the host, produce output ---
    await client.spawn({
      kind: "aux",
      terminalTargetId: "aux:pane-split-0",
      worktreeId: "aux",
      projectId: "aux",
      sessionId: "aux",
      worktreePath: "/work",
      harnessProvider: "aux",
      command: "bash",
      args: [],
      cwd: "/work",
      cols: 80,
      rows: 24,
    });
    scripted.helpers.emitData("warm-aux-scrollback");

    // --- session 2 (UI restart): host.list gate → warm plan → seed → attach ---
    const live = await client.list();
    expect(live.find((e) => e.terminalTargetId === "aux:pane-split-0")?.kind).toBe("aux");

    const warmPlan = planLayoutRestoreWarm(auxSnapshot(), warmDeps(socketPath, live));
    expect(warmPlan.seeds[0]?.createTerminalOverride).toBeDefined();

    const store = createStationStore({ initialWorkspace: warmPlan.workspace });
    expect(store.getState().workspace.panes.map((p) => p.id)).toEqual(["pane-split-0"]);
    const registry = createPtyRegistry();
    applyRestoreSeeds(registry, warmPlan.seeds);
    registry.resize("pane-split-0", { cols: 80, rows: 24 });

    const screen = registry.get("pane-split-0")?.screen;
    expect(screen).not.toBeNull();
    // The reattached pane replays the pre-restart scrollback (warm continuity).
    await waitFor(() => screenText(screen!).includes("warm-aux-scrollback"));
    expect(screenText(screen!)).toContain("warm-aux-scrollback");

    // Live output after reattach reaches the same screen.
    scripted.helpers.emitData(" then-live");
    await waitFor(() => screenText(screen!).includes("then-live"));

    registry.disposeAll(); // detach (does not kill the host PTY)

    // --- host PTY gone: the same planner now cold-respawns (no override) ---
    const auxPty = (await client.list()).find((e) => e.terminalTargetId === "aux:pane-split-0");
    expect(auxPty).toBeDefined();
    await client.close(auxPty!.ptyId);
    await waitFor(async () =>
      (await client.list()).every((e) => e.terminalTargetId !== "aux:pane-split-0"),
    );

    const afterClose = await client.list();
    const coldPlan = planLayoutRestoreWarm(auxSnapshot(), warmDeps(socketPath, afterClose));
    // No live entry for the aux target ⇒ cold respawn (cwd, no host override).
    expect(coldPlan.seeds[0]?.createTerminalOverride).toBeUndefined();
    expect(coldPlan.seeds[0]?.cwd).toBe("/work");

    client.dispose();
  });
});
