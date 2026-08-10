import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type PtyHandoffEntry,
  PtyBridgeProtocolVersion,
} from "@station/contracts";
import { createStationHostClient } from "@station/host";
import { describe, expect, it } from "bun:test";
import { waitFor } from "../terminal/testing/waitFor.js";
import {
  bridgeControlSocketPath,
  bridgeParkStatePath,
  ptyBridgesDirectory,
  readBridgeParkState,
} from "./orphanBridges.js";
import { createPtyTable } from "./ptyTable.js";

const HOST_ENTRY = fileURLToPath(new URL("./hostMain.ts", import.meta.url));

// Real node-pty + a real detached host process. Gated like the other PTY smokes
// so a plain `bun test` stays hermetic; run with STATION_PTY_SMOKE=1.
const SMOKE = process.env.STATION_PTY_SMOKE === "1";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error("waitForAsync timed out");
    }
    await delay(20);
  }
}

async function waitForHealth(
  client: ReturnType<typeof createStationHostClient>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const health = await client.health();
      if (health.ok) {
        return true;
      }
    } catch {
      // Not listening yet.
    }
    await delay(100);
  }
  return false;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (SMOKE) {
  describe("host kill -9 → orphan adoption (no PTY dies)", () => {
    it("keeps a live agent across host SIGKILL and restores it via adoptRegistry", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "station-kill9-"));
      const socketPath = join(stateDir, "station-host.sock");
      await mkdir(dirname(socketPath), { recursive: true });

      const host = spawn("bun", [HOST_ENTRY, "--socket", socketPath, "--state-dir", stateDir], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      host.unref();

      const control = createStationHostClient({ socketPath, timeoutMs: 1000 });
      const healthy = await waitForHealth(control);
      expect(healthy).toEqual(true);

      let originalPid = 0;
      let ptyInstanceId = "";
      const ptyId = "pty-1";
      try {
        const spawned = await control.spawn({
          terminalTargetId: "native:kill9",
          worktreeId: "kill9",
          projectId: "kill9",
          sessionId: "ses_kill9",
          worktreePath: stateDir,
          harnessProvider: "scripted",
          command: "/bin/sh",
          args: ["-c", 'read line; echo "adopted-$line"; sleep 60'],
          cwd: stateDir,
          cols: 80,
          rows: 24,
        });
        expect(spawned.ptyId).toEqual(ptyId);
        ptyInstanceId = spawned.ptyInstanceId;
        // host.list reports the PTY's child pid once the bridge is ready;
        // until then it carries the bridge pid the spawn result returned.
        await waitForAsync(async () => {
          const entry = (await control.list())[0];
          originalPid = entry?.pid ?? 0;
          return entry?.alive === true && originalPid > 0 && originalPid !== spawned.pid;
        }, 5_000);

        // The host dies the hard way; the bridge must park instead of dying.
        process.kill(host.pid as number, "SIGKILL");
        const bridgesDir = ptyBridgesDirectory(stateDir);
        await waitFor(() => existsSync(bridgeControlSocketPath(bridgesDir, ptyId)), 5_000);
        await waitFor(() => existsSync(bridgeParkStatePath(bridgesDir, ptyId)), 5_000);
        expect(processAlive(originalPid)).toEqual(true);
      } finally {
        control.dispose();
      }

      // A fresh host generation adopts the parked bridge from durable evidence.
      const bridgesDir = ptyBridgesDirectory(stateDir);
      const park = await readBridgeParkState(bridgeParkStatePath(bridgesDir, ptyId));
      expect(park).toBeDefined();
      expect(park?.pid).toEqual(originalPid);
      expect(park?.exited).toEqual(false);
      expect(park?.ptyInstanceId).toEqual(ptyInstanceId);

      const entry: PtyHandoffEntry = {
        bridgeProtocolVersion: PtyBridgeProtocolVersion,
        bridgePid: park?.bridgePid ?? 0,
        controlSocket: park?.controlSocket ?? "",
        command: park?.command ?? "/bin/sh",
        cols: park?.cols ?? 80,
        rows: park?.rows ?? 24,
        ptyInstanceId: park?.ptyInstanceId ?? "missing-instance",
        identity: park?.identity ?? {
          kind: "agent",
          terminalTargetId: "native:kill9",
          worktreeId: "kill9",
          projectId: "kill9",
          sessionId: "ses_kill9",
          worktreePath: stateDir,
          harnessProvider: "scripted",
        },
      };

      const table = createPtyTable({ orphanBridges: { directory: bridgesDir } });
      try {
        const report = await table.adoptRegistry({ [ptyId]: entry });
        expect(report.adopted).toEqual([ptyId]);
        expect(report.failed).toEqual([]);
        expect(table.has(ptyId)).toEqual(true);

        // The adopted entry is the SAME process that survived the kill.
        const listed = table.list()[0];
        expect(listed?.pid).toEqual(originalPid);
        expect(listed?.ptyInstanceId).toEqual(ptyInstanceId);
        expect(listed?.alive).toEqual(true);
        expect(listed?.terminalTargetId).toEqual("native:kill9");

        // I/O flows again through the adopted bridge.
        const controller = await table.attach(listed!, "att-orphan", "controller");
        controller.write(controller.controlState.controlEpoch, "back-alive\n");
        await waitFor(
          () => table.snapshot(ptyId).rawChunks.join("").includes("adopted-back-alive"),
          5_000,
        );
        controller.resize(controller.controlState.controlEpoch, 100, 30);
        expect(table.snapshot(ptyId).cols).toEqual(100);
        expect(processAlive(originalPid)).toEqual(true);
      } finally {
        table.disposeAll();
      }

      // Disposal tears the bridge down and clears the durable traces.
      await waitFor(() => !existsSync(bridgeControlSocketPath(bridgesDir, ptyId)), 5_000);
      await waitFor(() => !processAlive(originalPid), 5_000);
    }, 30_000);
  });
}
