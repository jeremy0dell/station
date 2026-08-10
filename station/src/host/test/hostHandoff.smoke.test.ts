import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStationHostClient } from "@station/host";
import { describe, expect, it } from "bun:test";

const HOST_ENTRY = fileURLToPath(new URL("../hostMain.ts", import.meta.url));
const SMOKE = process.env.STATION_PTY_SMOKE === "1";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForAsync(predicate: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
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
  buildVersion?: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const health = await client.health();
      if (health.ok && (buildVersion === undefined || health.buildVersion === buildVersion)) {
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

function spawnHost(input: {
  socketPath: string;
  stateDir: string;
  buildVersion: string;
}): ReturnType<typeof spawn> {
  const child = spawn(
    "bun",
    [
      HOST_ENTRY,
      "--socket",
      input.socketPath,
      "--state-dir",
      input.stateDir,
      "--build-version",
      input.buildVersion,
    ],
    {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE: "1" },
    },
  );
  child.unref();
  return child;
}

if (SMOKE) {
  describe("negotiated host handoff upgrade (A → B)", () => {
    it("transfers a live child across begin/complete/adopt with distinct builds", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "sh-"));
      const socketPath = join(stateDir, "station-host.sock");
      await mkdir(dirname(socketPath), { recursive: true });

      const hostA = spawnHost({ socketPath, stateDir, buildVersion: "0.0.0-host-a" });
      const clientA = createStationHostClient({
        socketPath,
        expectedBuildVersion: "0.0.0-host-a",
        timeoutMs: 2_000,
      });
      expect(await waitForHealth(clientA, "0.0.0-host-a")).toEqual(true);

      let childPid = 0;
      let ptyInstanceId = "";
      let manifest: Awaited<ReturnType<typeof clientA.beginHandoff>>["manifest"] = {};
      try {
        const spawned = await clientA.spawn({
          terminalTargetId: "native:handoff",
          worktreeId: "handoff",
          projectId: "handoff",
          sessionId: "ses_handoff",
          worktreePath: stateDir,
          harnessProvider: "scripted",
          command: "/bin/sh",
          args: ["-c", 'printf "marker-a\\n"; sleep 60'],
          cwd: stateDir,
          cols: 80,
          rows: 24,
        });
        ptyInstanceId = spawned.ptyInstanceId;
        await waitForAsync(async () => {
          const entry = (await clientA.list())[0];
          childPid = entry?.pid ?? 0;
          return entry?.alive === true && childPid > 0 && childPid !== spawned.pid;
        }, 5_000);
        expect(processAlive(childPid)).toEqual(true);

        const begun = await clientA.beginHandoff("0.0.0-host-b", "processes");
        expect(begun.released).toContain(spawned.ptyId);
        expect(begun.manifest[spawned.ptyId]?.ptyInstanceId).toEqual(ptyInstanceId);
        manifest = begun.manifest;
        expect(await clientA.completeHandoff()).toEqual({ stopping: true });
        await waitForAsync(() => !processAlive(hostA.pid as number), 5_000);
      } finally {
        clientA.dispose();
      }

      const hostB = spawnHost({ socketPath, stateDir, buildVersion: "0.0.0-host-b" });
      const clientB = createStationHostClient({
        socketPath,
        expectedBuildVersion: "0.0.0-host-b",
        timeoutMs: 2_000,
      });
      try {
        expect(await waitForHealth(clientB, "0.0.0-host-b")).toEqual(true);
        const adopted = await clientB.adoptRegistry(manifest);
        expect(adopted.adopted.length).toBeGreaterThan(0);
        const listed = await clientB.list();
        expect(listed).toHaveLength(1);
        expect(listed[0]?.pid).toEqual(childPid);
        expect(listed[0]?.ptyInstanceId).toEqual(ptyInstanceId);
        expect(processAlive(childPid)).toEqual(true);
        expect(processAlive(hostB.pid as number)).toEqual(true);
      } finally {
        clientB.dispose();
        if (hostB.pid !== undefined && processAlive(hostB.pid)) {
          process.kill(hostB.pid, "SIGTERM");
        }
      }
    }, 45_000);

    it("busy refuse without handoff keeps the A child alive", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "sr-"));
      const socketPath = join(stateDir, "station-host.sock");
      await mkdir(dirname(socketPath), { recursive: true });
      const hostA = spawnHost({ socketPath, stateDir, buildVersion: "0.0.0-host-a" });
      const clientA = createStationHostClient({
        socketPath,
        expectedBuildVersion: "0.0.0-host-a",
        timeoutMs: 2_000,
      });
      expect(await waitForHealth(clientA, "0.0.0-host-a")).toEqual(true);
      let childPid = 0;
      try {
        const spawned = await clientA.spawn({
          terminalTargetId: "native:refuse",
          worktreeId: "refuse",
          projectId: "refuse",
          sessionId: "ses_refuse",
          worktreePath: stateDir,
          harnessProvider: "scripted",
          command: "/bin/sh",
          args: ["-c", "sleep 60"],
          cwd: stateDir,
          cols: 80,
          rows: 24,
        });
        await waitForAsync(async () => {
          const entry = (await clientA.list())[0];
          childPid = entry?.pid ?? 0;
          return entry?.alive === true && childPid > 0 && childPid !== spawned.pid;
        }, 5_000);

        const clientB = createStationHostClient({
          socketPath,
          expectedBuildVersion: "0.0.0-host-b",
          timeoutMs: 2_000,
        });
        try {
          await expect(clientB.stopIfIdle("0.0.0-host-b")).rejects.toMatchObject({
            code: "HOST_UPGRADE_BLOCKED",
          });
        } finally {
          clientB.dispose();
        }
        expect(processAlive(childPid)).toEqual(true);
        expect(processAlive(hostA.pid as number)).toEqual(true);
        expect(await clientA.list()).toHaveLength(1);
      } finally {
        clientA.dispose();
        if (hostA.pid !== undefined && processAlive(hostA.pid)) {
          process.kill(hostA.pid, "SIGTERM");
        }
      }
    }, 30_000);

    it("transfers multiple live children and supports attach after adopt", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "sm-"));
      const socketPath = join(stateDir, "station-host.sock");
      await mkdir(dirname(socketPath), { recursive: true });
      const hostA = spawnHost({ socketPath, stateDir, buildVersion: "0.0.0-host-a" });
      const clientA = createStationHostClient({
        socketPath,
        expectedBuildVersion: "0.0.0-host-a",
        timeoutMs: 2_000,
      });
      expect(await waitForHealth(clientA, "0.0.0-host-a")).toEqual(true);

      const childPids: number[] = [];
      let manifest: Awaited<ReturnType<typeof clientA.beginHandoff>>["manifest"] = {};
      try {
        for (const [index, label] of ["agent", "aux"].entries()) {
          const spawned = await clientA.spawn({
            terminalTargetId: `native:${label}`,
            worktreeId: label,
            projectId: label,
            sessionId: `ses_${label}`,
            worktreePath: stateDir,
            harnessProvider: "scripted",
            kind: index === 0 ? "agent" : "aux",
            command: "/bin/sh",
            args: ["-c", `printf "marker-${label}\\n"; sleep 60`],
            cwd: stateDir,
            cols: 80,
            rows: 24,
          });
          await waitForAsync(async () => {
            const entry = (await clientA.list()).find((item) => item.ptyId === spawned.ptyId);
            const pid = entry?.pid ?? 0;
            if (entry?.alive === true && pid > 0 && pid !== spawned.pid) {
              childPids[index] = pid;
              return true;
            }
            return false;
          }, 5_000);
        }
        expect(childPids).toHaveLength(2);
        expect(childPids.every((pid) => processAlive(pid))).toEqual(true);

        const begun = await clientA.beginHandoff("0.0.0-host-b", "screen");
        expect(begun.released).toHaveLength(2);
        manifest = begun.manifest;
        expect(await clientA.completeHandoff()).toEqual({ stopping: true });
        await waitForAsync(() => !processAlive(hostA.pid as number), 5_000);
      } finally {
        clientA.dispose();
      }

      const hostB = spawnHost({ socketPath, stateDir, buildVersion: "0.0.0-host-b" });
      const clientB = createStationHostClient({
        socketPath,
        expectedBuildVersion: "0.0.0-host-b",
        timeoutMs: 2_000,
      });
      try {
        expect(await waitForHealth(clientB, "0.0.0-host-b")).toEqual(true);
        const adopted = await clientB.adoptRegistry(manifest);
        expect(adopted.adopted).toHaveLength(2);
        const listed = await clientB.list();
        expect(listed).toHaveLength(2);
        expect(listed.map((entry) => entry.pid).sort()).toEqual([...childPids].sort());
        const attachment = await clientB.attach(listed[0]!, "viewer");
        expect(attachment.ack.ptyId).toEqual(listed[0]!.ptyId);
        await attachment.detach();
        expect(childPids.every((pid) => processAlive(pid))).toEqual(true);
      } finally {
        clientB.dispose();
        if (hostB.pid !== undefined && processAlive(hostB.pid)) {
          process.kill(hostB.pid, "SIGTERM");
        }
      }
    }, 60_000);

    it("abort after begin restores incumbent ownership without killing the child", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "sa-"));
      const socketPath = join(stateDir, "station-host.sock");
      await mkdir(dirname(socketPath), { recursive: true });
      const hostA = spawnHost({ socketPath, stateDir, buildVersion: "0.0.0-host-a" });
      const clientA = createStationHostClient({
        socketPath,
        expectedBuildVersion: "0.0.0-host-a",
        timeoutMs: 10_000,
      });
      expect(await waitForHealth(clientA, "0.0.0-host-a")).toEqual(true);
      let childPid = 0;
      try {
        const spawned = await clientA.spawn({
          terminalTargetId: "native:abort",
          worktreeId: "abort",
          projectId: "abort",
          sessionId: "ses_abort",
          worktreePath: stateDir,
          harnessProvider: "scripted",
          command: "/bin/sh",
          args: ["-c", "sleep 60"],
          cwd: stateDir,
          cols: 80,
          rows: 24,
        });
        await waitForAsync(async () => {
          const entry = (await clientA.list())[0];
          childPid = entry?.pid ?? 0;
          return entry?.alive === true && childPid > 0 && childPid !== spawned.pid;
        }, 5_000);
        const attachExpectation = (await clientA.list())[0]!;

        await clientA.beginHandoff("0.0.0-host-b", "processes");
        await expect(clientA.attach(attachExpectation, "viewer")).rejects.toMatchObject({
          code: "HOST_UPGRADE_BLOCKED",
        });
        const aborted = await clientA.abortHandoff();
        expect(aborted.adopted).toContain(spawned.ptyId);
        expect(aborted.failed).toEqual([]);
        expect(await clientA.list()).toHaveLength(1);
        expect(processAlive(childPid)).toEqual(true);
        expect(processAlive(hostA.pid as number)).toEqual(true);
        const attachment = await clientA.attach(attachExpectation, "viewer");
        await attachment.detach();
      } finally {
        clientA.dispose();
        if (hostA.pid !== undefined && processAlive(hostA.pid)) {
          process.kill(hostA.pid, "SIGTERM");
        }
      }
    }, 45_000);

    it("idle empty host still uses stopIfIdle instead of handoff", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "si-"));
      const socketPath = join(stateDir, "station-host.sock");
      await mkdir(dirname(socketPath), { recursive: true });
      const hostA = spawnHost({ socketPath, stateDir, buildVersion: "0.0.0-host-a" });
      const clientA = createStationHostClient({
        socketPath,
        expectedBuildVersion: "0.0.0-host-a",
        timeoutMs: 2_000,
      });
      expect(await waitForHealth(clientA, "0.0.0-host-a")).toEqual(true);
      try {
        await expect(clientA.beginHandoff("0.0.0-host-b")).rejects.toMatchObject({
          code: "HOST_HANDOFF_INVALID_STATE",
        });
        expect(await clientA.stopIfIdle("0.0.0-host-b")).toEqual({ stopping: true });
        await waitForAsync(() => !processAlive(hostA.pid as number), 5_000);
      } finally {
        clientA.dispose();
      }

      const hostB = spawnHost({ socketPath, stateDir, buildVersion: "0.0.0-host-b" });
      const clientB = createStationHostClient({
        socketPath,
        expectedBuildVersion: "0.0.0-host-b",
        timeoutMs: 2_000,
      });
      try {
        expect(await waitForHealth(clientB, "0.0.0-host-b")).toEqual(true);
        expect(await clientB.list()).toEqual([]);
      } finally {
        clientB.dispose();
        if (hostB.pid !== undefined && processAlive(hostB.pid)) {
          process.kill(hostB.pid, "SIGTERM");
        }
      }
    }, 30_000);

    it("keeps parks adoptable when successor dies before adopt", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "sv-"));
      const socketPath = join(stateDir, "station-host.sock");
      await mkdir(dirname(socketPath), { recursive: true });
      const hostA = spawnHost({ socketPath, stateDir, buildVersion: "0.0.0-host-a" });
      const clientA = createStationHostClient({
        socketPath,
        expectedBuildVersion: "0.0.0-host-a",
        timeoutMs: 2_000,
      });
      expect(await waitForHealth(clientA, "0.0.0-host-a")).toEqual(true);

      let childPid = 0;
      let manifest: Awaited<ReturnType<typeof clientA.beginHandoff>>["manifest"] = {};
      try {
        const spawned = await clientA.spawn({
          terminalTargetId: "native:recovery",
          worktreeId: "recovery",
          projectId: "recovery",
          sessionId: "ses_recovery",
          worktreePath: stateDir,
          harnessProvider: "scripted",
          command: "/bin/sh",
          args: ["-c", "sleep 60"],
          cwd: stateDir,
          cols: 80,
          rows: 24,
        });
        await waitForAsync(async () => {
          const entry = (await clientA.list())[0];
          childPid = entry?.pid ?? 0;
          return entry?.alive === true && childPid > 0 && childPid !== spawned.pid;
        }, 5_000);
        const begun = await clientA.beginHandoff("0.0.0-host-b", "processes");
        manifest = begun.manifest;
        expect(await clientA.completeHandoff()).toEqual({ stopping: true });
        await waitForAsync(() => !processAlive(hostA.pid as number), 5_000);
      } finally {
        clientA.dispose();
      }

      const failedSuccessor = spawnHost({
        socketPath,
        stateDir,
        buildVersion: "0.0.0-host-b",
      });
      await waitForAsync(() => processAlive(failedSuccessor.pid as number), 5_000);
      if (failedSuccessor.pid !== undefined) {
        process.kill(failedSuccessor.pid, "SIGKILL");
      }
      await waitForAsync(() => !processAlive(failedSuccessor.pid as number), 5_000);
      expect(processAlive(childPid)).toEqual(true);

      const hostB = spawnHost({ socketPath, stateDir, buildVersion: "0.0.0-host-b" });
      const clientB = createStationHostClient({
        socketPath,
        expectedBuildVersion: "0.0.0-host-b",
        timeoutMs: 2_000,
      });
      try {
        expect(await waitForHealth(clientB, "0.0.0-host-b")).toEqual(true);
        const adopted = await clientB.adoptRegistry(manifest);
        expect(adopted.adopted.length).toBeGreaterThan(0);
        expect((await clientB.list())[0]?.pid).toEqual(childPid);
        expect(processAlive(childPid)).toEqual(true);
      } finally {
        clientB.dispose();
        if (hostB.pid !== undefined && processAlive(hostB.pid)) {
          process.kill(hostB.pid, "SIGTERM");
        }
      }
    }, 60_000);
  });
}
