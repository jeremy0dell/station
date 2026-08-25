import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStationHostClient } from "@station/host";
import { describe, expect, it } from "bun:test";

const HOST_ENTRY = fileURLToPath(new URL("../hostMain.ts", import.meta.url));
const SMOKE = process.env.STATION_PTY_SMOKE === "1";
const BINARY_PATH = process.env.STATION_BINARY_PATH;
const SOURCE_BUILD_IDENTITY = "a".repeat(64);
const SUCCESSOR_BUILD_IDENTITY = "b".repeat(64);

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForAsync(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5_000,
): Promise<void> {
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

function spawnSourceHost(input: {
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
      "--build-identity",
      SOURCE_BUILD_IDENTITY,
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

/** argv shape differs from direct `bun hostMain` (source → packaged trampoline). */
async function writePackagingTrampoline(stateDir: string): Promise<string> {
  const trampolinePath = join(stateDir, "host-trampoline.mjs");
  await writeFile(
    trampolinePath,
    [
      "import { spawn } from \"node:child_process\";",
      `const hostEntry = ${JSON.stringify(HOST_ENTRY)};`,
      "const child = spawn(\"bun\", [hostEntry, ...process.argv.slice(2)], {",
      "  stdio: \"inherit\",",
      "  env: { ...process.env, STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE: \"1\" },",
      "});",
      "child.on(\"exit\", (code, signal) => {",
      "  if (code !== null) process.exit(code);",
      "  process.exit(signal === \"SIGINT\" ? 130 : 1);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return trampolinePath;
}

async function handoffAcrossPackaging(input: {
  resolveSuccessor: (stateDir: string) => Promise<{ command: string; argsPrefix: string[] }>;
  successorBuild: string;
}): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "sp-"));
  const socketPath = join(stateDir, "station-host.sock");
  await mkdir(dirname(socketPath), { recursive: true });
  const successor = await input.resolveSuccessor(stateDir);

  const hostA = spawnSourceHost({
    socketPath,
    stateDir,
    buildVersion: "0.0.0-packaging-source",
  });
  const clientA = createStationHostClient({
    socketPath,
    expectedBuildVersion: "0.0.0-packaging-source",
    timeoutMs: 10_000,
  });
  expect(await waitForHealth(clientA, "0.0.0-packaging-source")).toEqual(true);

  let childPid = 0;
  let manifest: Awaited<ReturnType<typeof clientA.beginHandoff>>["manifest"] = {};
  try {
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
      childPid = entry?.pid ?? 0;
      return entry?.alive === true && childPid > 0 && childPid !== spawned.pid;
    }, 5_000);

    const begun = await clientA.beginHandoff(input.successorBuild, "processes");
    manifest = begun.manifest;
    expect(await clientA.completeHandoff()).toEqual({ stopping: true });
    await waitForAsync(() => !processAlive(hostA.pid as number), 5_000);
  } finally {
    clientA.dispose();
  }

  const hostB = spawn(successor.command, [
    ...successor.argsPrefix,
    "--socket",
    socketPath,
    "--state-dir",
    stateDir,
    "--build-version",
    input.successorBuild,
    "--build-identity",
    SUCCESSOR_BUILD_IDENTITY,
  ], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE: "1" },
  });
  hostB.unref();

  const clientB = createStationHostClient({
    socketPath,
    expectedBuildVersion: input.successorBuild,
    timeoutMs: 10_000,
  });
  try {
    expect(await waitForHealth(clientB, input.successorBuild)).toEqual(true);
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
}

if (SMOKE) {
  describe("host handoff across successor packaging shapes", () => {
    it("transfers a live child from bun hostMain to a trampoline successor argv", async () => {
      await handoffAcrossPackaging({
        successorBuild: "0.0.0-packaging-tramp",
        resolveSuccessor: async (stateDir) => {
          const trampoline = await writePackagingTrampoline(stateDir);
          return { command: process.execPath, argsPrefix: [trampoline] };
        },
      });
    }, 60_000);

    it("transfers a live child from bun hostMain to a compiled __station-host when STATION_BINARY_PATH is set", async () => {
      if (BINARY_PATH === undefined || BINARY_PATH.length === 0 || !existsSync(BINARY_PATH)) {
        return;
      }
      await handoffAcrossPackaging({
        successorBuild: "0.0.0-packaging-binary",
        resolveSuccessor: async () => ({
          command: BINARY_PATH,
          argsPrefix: ["__station-host"],
        }),
      });
    }, 90_000);
  });
}
