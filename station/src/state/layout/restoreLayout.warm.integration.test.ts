import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStationHostClient, type HostListEntry } from "@station/host";
import { ensureStationHostRunning } from "@station/terminal";
import { buildLayoutSnapshot } from "./layoutSnapshot.js";
import { applyRestoreSeeds, planLayoutRestoreWarm } from "./restoreLayout.js";
import { createStationStore } from "../store.js";
import type { WorkspaceSlice } from "../types.js";
import { createHostAttachedTerminal } from "../../terminal/pty/hostAttachedTerminal.js";
import { createPtyRegistry } from "../../terminal/registry/ptyRegistry.js";
import { createScriptedTerminal, type ScriptedTerminal } from "../../terminal/testing/scriptedTerminal.js";
import { type StationHostInstance, startStationHost } from "../../host/startHost.js";
import type { StationVtScreen } from "../../terminal/vt/screen.js";

// Warm reattach end-to-end against a REAL host daemon: an aux PTY spawned into the
// host survives a "UI restart" and warm-reattaches with its scrollback via the
// restore planner + createHostAttachedTerminal; once the host PTY is gone the same
// planner cold-respawns instead.

const noopLogger = { log: async () => undefined } as never;
const HOST_ENTRY = fileURLToPath(new URL("../../host/hostMain.ts", import.meta.url));
const SMOKE = process.env.STATION_PTY_SMOKE === "1";
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnSourceHost(input: {
  socketPath: string;
  stateDir: string;
  buildVersion: string;
}) {
  const child = spawn(
    process.env.STATION_BUN ?? "bun",
    [
      HOST_ENTRY,
      "--build-version",
      input.buildVersion,
      "--socket",
      input.socketPath,
      "--state-dir",
      input.stateDir,
    ],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE: "1",
        STATION_PTY_IMPL: "bridge",
      },
    },
  );
  child.unref();
  return child;
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

function warmDeps(socketPath: string, live: HostListEntry[], expectedBuildVersion?: string) {
  return {
    liveByTarget: new Map(live.map((entry) => [entry.terminalTargetId, entry])),
    makeHostTerminal: (entry: HostListEntry) => (options: { size?: { cols?: number; rows?: number } }) =>
      createHostAttachedTerminal({
        hostSocketPath: socketPath,
        ptyRef: entry,
        size: { cols: options.size?.cols ?? 80, rows: options.size?.rows ?? 24 },
        ...(expectedBuildVersion === undefined
          ? {}
          : {
              clientFactory: (path: string) =>
                createStationHostClient({ socketPath: path, expectedBuildVersion }),
            }),
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
  }, 15_000);
});

if (SMOKE) {
  describe("warm reattach after negotiated Host handoff", () => {
    it("preserves the child and PTY instance while replaying old and live output", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "station-warm-handoff-"));
      const socketPath = join(stateDir, "station-host.sock");
      const buildA = "0.0.0-warm-host-a";
      const buildB = "0.0.0-warm-host-b";
      const hosts = [spawnSourceHost({ socketPath, stateDir, buildVersion: buildA })];
      const clientA = createStationHostClient({
        socketPath,
        expectedBuildVersion: buildA,
        timeoutMs: 2_000,
      });
      let successorClient: ReturnType<typeof createStationHostClient> | undefined;
      let registry: ReturnType<typeof createPtyRegistry> | undefined;
      let childPid = 0;
      try {
        await waitFor(async () => {
          try {
            return (await clientA.health()).buildVersion === buildA;
          } catch {
            return false;
          }
        });
        const spawned = await clientA.spawn({
          kind: "aux",
          terminalTargetId: "aux:pane-split-0",
          worktreeId: "aux",
          projectId: "aux",
          sessionId: "aux",
          worktreePath: stateDir,
          harnessProvider: "aux",
          command: "/bin/sh",
          args: [
            "-c",
            'IFS= read -r first; printf "before-handoff:%s\\n" "$first"; IFS= read -r line; printf "live-after-handoff:%s\\n" "$line"; sleep 60',
          ],
          cwd: stateDir,
          cols: 80,
          rows: 24,
        });
        await waitFor(async () => {
          const entry = (await clientA.list()).find((item) => item.ptyId === spawned.ptyId);
          childPid = entry?.pid ?? 0;
          return entry?.alive === true && childPid > 0 && childPid !== spawned.pid;
        });
        const incumbentEntry = (await clientA.list()).find(
          (entry) => entry.ptyId === spawned.ptyId,
        );
        expect(incumbentEntry).toBeDefined();
        const incumbentAttachment = await clientA.attach(incumbentEntry!, "controller");
        const incumbentFrames = incumbentAttachment.frames[Symbol.asyncIterator]();
        await incumbentAttachment.write("from-incumbent\n");
        let incumbentOutput = "";
        for (let frameIndex = 0; frameIndex < 4; frameIndex += 1) {
          const frame = await incumbentFrames.next();
          if (frame.done !== true && frame.value.type === "data") {
            incumbentOutput += frame.value.data;
            if (incumbentOutput.includes("before-handoff:from-incumbent")) break;
          }
        }
        expect(incumbentOutput).toContain("before-handoff:from-incumbent");
        await incumbentAttachment.detach();
        expect(processAlive(childPid)).toBe(true);

        const ensured = await ensureStationHostRunning(
          {
            socketPath,
            stateDir,
            hostCommand: [
              process.env.STATION_BUN ?? "bun",
              HOST_ENTRY,
              "--build-version",
              buildB,
            ],
            expectedBuildVersion: buildB,
            timeoutMs: 10_000,
            handoff: { fidelity: "processes" },
          },
          {
            spawnHost: ({ argv, spawnOptions }) => {
              const [command, ...args] = argv;
              const child = spawn(command, args, {
                ...spawnOptions,
                env: {
                  ...process.env,
                  STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE: "1",
                  STATION_PTY_IMPL: "bridge",
                },
              });
              hosts.push(child);
              return child;
            },
          },
        );
        if (ensured.status !== "running") {
          throw new Error(
            `${ensured.error.code}: ${ensured.error.message}${
              ensured.error.hint === undefined ? "" : ` ${ensured.error.hint}`
            }`,
          );
        }
        expect(ensured.status).toBe("running");
        expect(ensured.ensuredBy).toBe("handoff");
        successorClient = ensured.client;

        const successorInventory = await successorClient.list();
        const adopted = successorInventory.find((entry) => entry.ptyId === spawned.ptyId);
        expect(adopted).toMatchObject({
          pid: childPid,
          ptyInstanceId: spawned.ptyInstanceId,
          alive: true,
        });
        const replayProbe = await successorClient.attach(adopted!, "viewer");
        expect(JSON.stringify(replayProbe.ack.replay)).toContain("before-handoff:from-incumbent");
        await replayProbe.detach();

        const warmPlan = planLayoutRestoreWarm(
          auxSnapshot(),
          warmDeps(socketPath, successorInventory, buildB),
        );
        expect(warmPlan.seeds[0]?.createTerminalOverride).toBeDefined();
        registry = createPtyRegistry();
        applyRestoreSeeds(registry, warmPlan.seeds);
        registry.resize("pane-split-0", { cols: 80, rows: 24 });

        const screen = registry.get("pane-split-0")?.screen;
        expect(screen).not.toBeNull();
        await waitFor(() => screenText(screen!).includes("before-handoff"));
        expect(registry.write("pane-split-0", "from-successor\n")).toBe(true);
        await waitFor(() =>
          screenText(screen!).includes("live-after-handoff:from-successor"),
        );
        expect(processAlive(childPid)).toBe(true);
      } finally {
        registry?.disposeAll();
        if (successorClient !== undefined) {
          try {
            const live = await successorClient.list();
            for (const entry of live) {
              await successorClient.close(entry.ptyId);
            }
            await successorClient.stopIfIdle(buildB);
          } catch {
            // Exact process handles below remain the cleanup backstop.
          }
          successorClient.dispose();
        }
        clientA.dispose();
        for (const child of hosts) {
          if (child.pid !== undefined && processAlive(child.pid)) {
            process.kill(child.pid, "SIGTERM");
          }
        }
        if (childPid > 0 && processAlive(childPid)) {
          process.kill(childPid, "SIGTERM");
        }
        await rm(stateDir, { recursive: true, force: true });
      }
    }, 45_000);
  });
}
