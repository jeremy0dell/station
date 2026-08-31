import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStationHostClient } from "@station/host";
import { stationBuildInfo } from "@station/runtime";
import { convergeStationHost, inspectStationHost } from "@station/terminal";
import { describe, expect, it } from "bun:test";

const HOST_ENTRY = fileURLToPath(new URL("../hostMain.ts", import.meta.url));
const SMOKE = process.env.STATION_PTY_SMOKE === "1";
const BINARY_PATH = process.env.STATION_BINARY_PATH;
const PACKAGING_REQUIRED = process.env.STATION_HOST_PACKAGING_REQUIRED === "1";
const SOURCE_BUILD_IDENTITY = "a".repeat(64);
const SUCCESSOR_BUILD_IDENTITY = "b".repeat(64);

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForAsync(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitForAsync timed out");
    await delay(20);
  }
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
  buildIdentity?: string;
}): ReturnType<typeof spawn> {
  const child = spawn(
    process.env.STATION_BUN ?? "bun",
    [
      HOST_ENTRY,
      "--build-version",
      input.buildVersion,
      "--build-identity",
      input.buildIdentity ?? SOURCE_BUILD_IDENTITY,
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

/** Imports hostMain in the direct child so the trampoline preserves its holder PID. */
async function writeExecPreservingTrampoline(stateDir: string): Promise<string> {
  const trampolinePath = join(stateDir, "host-trampoline.mjs");
  await writeFile(
    trampolinePath,
    [
      `process.env.STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE = "1";`,
      `process.env.STATION_PTY_IMPL = "bridge";`,
      `const { runStationHostMain } = await import(${JSON.stringify(HOST_ENTRY)});`,
      `await runStationHostMain(process.argv.slice(2));`,
      "",
    ].join("\n"),
    "utf8",
  );
  return trampolinePath;
}

function binaryVersion(binaryPath: string): string {
  const result = spawnSync(binaryPath, ["--version"], { encoding: "utf8" });
  if (result.status !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error(`Could not read packaged Station version: ${result.stderr}`);
  }
  const version = result.stdout.trim();
  if (version.length === 0) throw new Error("Packaged Station version was empty.");
  return version;
}

async function convergeAcrossPackaging(input: {
  incumbentBuild: { buildVersion: string; buildIdentity: string };
  targetBuild: { buildVersion: string; buildIdentity: string };
  resolveSuccessor: (stateDir: string) => Promise<readonly [string, ...string[]]>;
}): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "sp-"));
  const socketPath = join(stateDir, "station-host.sock");
  await mkdir(dirname(socketPath), { recursive: true });
  const hostA = spawnSourceHost({
    socketPath,
    stateDir,
    buildVersion: input.incumbentBuild.buildVersion,
    buildIdentity: input.incumbentBuild.buildIdentity,
  });
  const clientA = createStationHostClient({
    socketPath,
    expectedBuildVersion: input.incumbentBuild.buildVersion,
    timeoutMs: 10_000,
  });
  let successorClient: ReturnType<typeof createStationHostClient> | undefined;
  let terminalPid = 0;
  try {
    await waitForAsync(async () => {
      try {
        return (await clientA.health()).buildVersion === input.incumbentBuild.buildVersion;
      } catch {
        return false;
      }
    });
    const spawned = await clientA.spawn({
      terminalTargetId: "native:packaging",
      worktreeId: "packaging",
      projectId: "packaging",
      sessionId: "ses_packaging",
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
      terminalPid = entry?.pid ?? 0;
      return entry?.alive === true && terminalPid > 0 && terminalPid !== spawned.pid;
    });

    const inspection = await inspectStationHost({
      socketPath,
      expectedBuildVersion: input.targetBuild.buildVersion,
      deadlineMs: Date.now() + 10_000,
    });
    if (inspection.status !== "exact") {
      throw new Error(`Incumbent inspection was ${inspection.status}.`);
    }
    expect(inspection.evidence).toMatchObject({
      health: { buildVersion: input.incumbentBuild.buildVersion },
      buildIdentity: input.incumbentBuild.buildIdentity,
    });

    const result = await convergeStationHost({
      command: {
        action: "handoff",
        targetBuild: input.targetBuild,
        socketPath,
        expected: inspection.evidence,
        fidelity: "processes",
        deadlineMs: Date.now() + 20_000,
      },
      targetBuild: input.targetBuild,
      socketPath,
      stateDir,
      hostCommand: await input.resolveSuccessor(stateDir),
    });
    if (result.status !== "completed" || result.action !== "handoff") {
      throw new Error(
        result.status === "failed"
          ? `${result.error.code}: ${result.error.message}`
          : "Expected completed handoff convergence.",
      );
    }
    expect(result.handoffReceipt).toEqual({
      fidelity: "processes",
      terminals: [
        {
          terminalTargetId: spawned.terminalTargetId,
          ptyId: spawned.ptyId,
          ptyInstanceId: spawned.ptyInstanceId,
        },
      ],
    });
    expect(result.finalEvidence).toMatchObject({
      endpoint: { socketPath },
      health: { buildVersion: input.targetBuild.buildVersion },
      buildIdentity: input.targetBuild.buildIdentity,
      terminals: [{ ptyId: spawned.ptyId, ptyInstanceId: spawned.ptyInstanceId }],
    });
    expect(result.finalEvidence.endpoint).not.toEqual(inspection.evidence.endpoint);
    await waitForAsync(() => !processAlive(hostA.pid as number));

    successorClient = createStationHostClient({
      socketPath,
      expectedBuildVersion: input.targetBuild.buildVersion,
      timeoutMs: 10_000,
    });
    expect((await successorClient.list())[0]).toMatchObject({
      ptyId: spawned.ptyId,
      ptyInstanceId: spawned.ptyInstanceId,
      pid: terminalPid,
      alive: true,
    });
    expect(processAlive(terminalPid)).toBe(true);
  } finally {
    clientA.dispose();
    if (successorClient !== undefined) {
      try {
        for (const entry of await successorClient.list()) await successorClient.close(entry.ptyId);
        await waitForAsync(async () => (await successorClient!.list()).length === 0);
        await successorClient.stopIfIdle("packaging-smoke-cleanup");
      } catch {
        // Exact child/terminal handles below remain the cleanup backstop for failed assertions.
      }
      successorClient.dispose();
    }
    if (hostA.pid !== undefined && processAlive(hostA.pid)) process.kill(hostA.pid, "SIGTERM");
    if (terminalPid > 0 && processAlive(terminalPid)) process.kill(terminalPid, "SIGTERM");
    await rm(stateDir, { recursive: true, force: true });
  }
}

if (SMOKE) {
  describe("canonical Host convergence across successor packaging shapes", () => {
    it("converges a live source Host through an exec-preserving source trampoline", async () => {
      await convergeAcrossPackaging({
        incumbentBuild: {
          buildVersion: "0.0.0-packaging-source",
          buildIdentity: SOURCE_BUILD_IDENTITY,
        },
        targetBuild: {
          buildVersion: "0.0.0-packaging-trampoline",
          buildIdentity: SUCCESSOR_BUILD_IDENTITY,
        },
        resolveSuccessor: async (stateDir) => [
          process.env.STATION_BUN ?? "bun",
          await writeExecPreservingTrampoline(stateDir),
          "--build-version",
          "0.0.0-packaging-trampoline",
          "--build-identity",
          SUCCESSOR_BUILD_IDENTITY,
        ],
      });
    }, 60_000);

    it("converges a same-display source Host to the compiled embedded identity", async () => {
      if (BINARY_PATH === undefined || BINARY_PATH.length === 0 || !existsSync(BINARY_PATH)) {
        if (PACKAGING_REQUIRED) throw new Error("STATION_BINARY_PATH must name the required binary.");
        return;
      }
      const targetBuild = {
        buildVersion: binaryVersion(BINARY_PATH),
        buildIdentity: stationBuildInfo().buildIdentity,
      };
      expect(targetBuild.buildIdentity).not.toBe(SOURCE_BUILD_IDENTITY);
      await convergeAcrossPackaging({
        incumbentBuild: {
          buildVersion: targetBuild.buildVersion,
          buildIdentity: SOURCE_BUILD_IDENTITY,
        },
        targetBuild,
        resolveSuccessor: async () => [BINARY_PATH, "__station-host"],
      });
    }, 90_000);
  });
}
