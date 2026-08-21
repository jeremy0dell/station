import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  ensureExactObserverBuild,
  getObserverStatus,
  restartObserver,
  runCli,
  startObserver,
} from "@station/cli";
import { emptyConfig } from "@station/config";
import { ObserverProcessIdentitySchema, ObserverProcessTokenSchema } from "@station/contracts";
import { acquireObserverBootClaim, observerBootClaimPath } from "@station/observer/internal";
import { createObserverClient, listenUnixSocket, probeUnixSocket } from "@station/protocol";
import { stationBuildInfo, stationObserverBuildVersion } from "@station/runtime";
import { describe, expect, it, vi } from "vitest";
import { observerStatusErrorMessage } from "../../apps/cli/src/observerProcess.js";
import { createRealStaleSocket, waitForSocketClosed } from "../support/sockets";
import { createTempState, writeConfigToml } from "../support/temp-projects";

const execFileAsync = promisify(execFile);

describe("observer lifecycle e2e", () => {
  it("boots a real observer with in-memory defaults and no config file", async () => {
    const fixture = await createTempState();
    const bootLogPath = join(fixture.stateDir, "logs", "observer-boot.log");
    await mkdir(join(fixture.stateDir, "logs"), { recursive: true });
    await writeFile(bootLogPath, "stale observer boot output\n", "utf8");
    await chmod(bootLogPath, 0o666);
    const config = {
      ...emptyConfig(),
      observer: {
        stateDir: fixture.stateDir,
        socketPath: fixture.socketPath,
      },
    };
    const client = createObserverClient({ socketPath: fixture.socketPath, timeoutMs: 1000 });
    const pidfilePath = `${fixture.socketPath}.pid`;
    let started = false;

    try {
      const status = await startObserver({ config, timeoutMs: 30_000 });
      expect(status).toMatchObject({
        status: "running",
        paths: { socketPath: fixture.socketPath },
      });
      if (status.status !== "running") {
        throw new Error(`Observer failed to start: ${status.status}`);
      }
      started = true;

      expect(status.health).toMatchObject({
        status: "healthy",
        socketPath: fixture.socketPath,
        stateDir: fixture.stateDir,
      });
      const build = stationBuildInfo();
      expect(status.health.version).toBe(stationObserverBuildVersion(build));
      const identity = ObserverProcessIdentitySchema.parse(
        JSON.parse(await readFile(pidfilePath, "utf8")),
      );
      expect(Object.keys(identity).sort()).toEqual([
        "osStartTime",
        "pid",
        "processToken",
        "socketPath",
        "version",
      ]);
      expect(identity).toMatchObject({
        pid: status.health.pid,
        version: status.health.version,
        socketPath: status.health.socketPath,
      });
      expect(identity.osStartTime).toBe(identity.osStartTime.trim());
      expect((await stat(pidfilePath)).mode & 0o777).toBe(0o600);
      await expect(access(join(fixture.stateDir, "observer.sock.pid"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(client.getSnapshot()).resolves.toMatchObject({
        schemaVersion: "0.11.0",
        observer: { version: build.version },
        counts: { projects: 0 },
      });
      await expect(access(join(fixture.root, "config.toml"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const bootLog = await readFile(bootLogPath, "utf8");
      expect(bootLog).not.toContain("stale observer boot output");
      const header = bootLog.split(/\r?\n/, 1)[0];
      const headerCommand = JSON.parse(header ?? "") as { command: string[] };
      expect(headerCommand.command.slice(0, -4)).toEqual([
        process.execPath,
        expect.stringMatching(/observerMain\.js$/),
        "--socket",
        fixture.socketPath,
        "--state-dir",
        fixture.stateDir,
        "--startup-timeout-ms",
        "30000",
      ]);
      expect(headerCommand.command.slice(-4, -2)).toEqual([
        "--build-version",
        status.health.version,
      ]);
      expect(headerCommand.command.at(-2)).toBe("--process-token");
      expect(ObserverProcessTokenSchema.parse(headerCommand.command.at(-1))).toBe(
        identity.processToken,
      );
      expect((await stat(bootLogPath)).mode & 0o777).toBe(0o600);
    } finally {
      if (started) {
        await client.stop();
        await waitForSocketClosed(fixture.socketPath);
      }
    }

    await expect(access(pidfilePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("converges concurrent cold starts on one healthy observer", async () => {
    const fixture = await createTempState();
    const config = {
      ...emptyConfig(),
      observer: {
        stateDir: fixture.stateDir,
        socketPath: fixture.socketPath,
      },
    };
    const client = createObserverClient({ socketPath: fixture.socketPath, timeoutMs: 1000 });
    const pidfilePath = `${fixture.socketPath}.pid`;
    let started = false;

    try {
      const statuses = await Promise.all(
        Array.from({ length: 5 }, () => startObserver({ config, timeoutMs: 30_000 })),
      );
      started = statuses.some((status) => status.status === "running");

      expect(statuses.every((status) => status.status === "running")).toBe(true);
      const pids = statuses.map((status) =>
        status.status === "running" ? status.health.pid : undefined,
      );
      expect(new Set(pids).size).toBe(1);
      expect(pids[0]).toBeTypeOf("number");
      const identity = ObserverProcessIdentitySchema.parse(
        JSON.parse(await readFile(pidfilePath, "utf8")),
      );
      expect(identity).toMatchObject({
        pid: pids[0],
        version: statuses[0]?.status === "running" ? statuses[0].health.version : undefined,
        socketPath: fixture.socketPath,
      });
    } finally {
      if (started) {
        await client.stop();
        await waitForSocketClosed(fixture.socketPath);
      }
    }

    await expect(access(pidfilePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an inaccessible live Observer until access is restored", async () => {
    const fixture = await createTempState();
    const config = observerConfig(fixture.stateDir, fixture.socketPath);
    const configPath = await writeConfigToml(fixture.root, config);
    const client = createObserverClient({ socketPath: fixture.socketPath, timeoutMs: 1000 });
    const pidfilePath = `${fixture.socketPath}.pid`;
    const started = await startObserver({ config, timeoutMs: 30_000 });
    expect(started.status).toBe("running");
    if (
      started.status !== "running" ||
      started.health.pid === undefined ||
      started.health.version === undefined
    ) {
      throw new Error("Observer did not report a process identity.");
    }
    const originalPid = started.health.pid;
    const originalSocket = await stat(fixture.socketPath);
    const originalPidfile = await stat(pidfilePath);
    const originalPidfileBytes = await readFile(pidfilePath);
    // Health can become ready before the listener is visible to the Linux socket scan.
    await waitFor(
      async () => (await socketHolders(fixture.socketPath)).includes(originalPid),
      3000,
    );
    const originalHolders = await socketHolders(fixture.socketPath);
    let restored = false;
    const spawnObserver = vi.fn(async () => {
      throw new Error("inaccessible ownership must not spawn");
    });
    try {
      await chmod(fixture.socketPath, 0o000);
      const deps = { buildVersion: started.health.version, spawnObserver };
      await expect(getObserverStatus({ config, timeoutMs: 100 }, deps)).resolves.toMatchObject({
        status: "unhealthy",
        error: { code: "OBSERVER_SOCKET_INACCESSIBLE" },
      });
      await expect(startObserver({ config, timeoutMs: 100 }, deps)).resolves.toMatchObject({
        status: "unhealthy",
        error: { code: "OBSERVER_SOCKET_INACCESSIBLE" },
      });
      await expect(restartObserver({ config, timeoutMs: 100 }, deps)).resolves.toMatchObject({
        status: "unhealthy",
        error: { code: "OBSERVER_SOCKET_INACCESSIBLE" },
      });
      await expect(
        runCli(["--config", configPath, "doctor"], { observerDeps: deps }),
      ).rejects.toMatchObject({ error: { code: "OBSERVER_SOCKET_INACCESSIBLE" } });
      await sleep(5500);

      expect(processIsAlive(originalPid)).toBe(true);
      const currentSocket = await stat(fixture.socketPath);
      expect({ dev: currentSocket.dev, ino: currentSocket.ino }).toEqual({
        dev: originalSocket.dev,
        ino: originalSocket.ino,
      });
      const currentPidfile = await stat(pidfilePath);
      expect({ dev: currentPidfile.dev, ino: currentPidfile.ino }).toEqual({
        dev: originalPidfile.dev,
        ino: originalPidfile.ino,
      });
      await expect(readFile(pidfilePath)).resolves.toEqual(originalPidfileBytes);
      expect(await socketHolders(fixture.socketPath)).toEqual(originalHolders);
      expect(spawnObserver).not.toHaveBeenCalled();

      await chmod(fixture.socketPath, 0o600);
      restored = true;
      await expect(client.health()).resolves.toMatchObject({ pid: originalPid, status: "healthy" });
      await client.stop();
      await waitForSocketClosed(fixture.socketPath);
      await expect(access(pidfilePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (!restored) await chmod(fixture.socketPath, 0o600).catch(() => undefined);
      if (processIsAlive(originalPid)) {
        await client.stop().catch(() => undefined);
        await waitForSocketClosed(fixture.socketPath).catch(() => undefined);
      }
    }
  });

  it("replaces an internal preview only after its process and socket have closed", async () => {
    const fixture = await createTempState();
    const incumbent = await startIncumbentFixture({
      stateDir: fixture.stateDir,
      socketPath: fixture.socketPath,
      version: "0.7.1-rc.8",
      stopDelayMs: 400,
    });
    const config = observerConfig(fixture.stateDir, fixture.socketPath);
    const successorClient = createObserverClient({
      socketPath: fixture.socketPath,
      timeoutMs: 1000,
    });
    let successorStarted = false;

    try {
      const startedAt = Date.now();
      const buildVersion = stationObserverBuildVersion();
      const status = await startObserver({ config, timeoutMs: 10_000 }, { buildVersion });
      expect(status, JSON.stringify(status)).toMatchObject({
        status: "running",
        health: { version: buildVersion, socketPath: fixture.socketPath },
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
      if (status.status !== "running") throw new Error("Successor Observer did not start.");
      successorStarted = true;
      expect(status.health.pid).not.toBe(incumbent.child.pid);
      await expectProcessExit(incumbent.child.pid);
      expect(
        ObserverProcessIdentitySchema.parse(
          JSON.parse(await readFile(`${fixture.socketPath}.pid`, "utf8")),
        ),
      ).toMatchObject({
        pid: status.health.pid,
        version: buildVersion,
        socketPath: fixture.socketPath,
      });
    } finally {
      if (successorStarted) {
        await successorClient.stop().catch(() => undefined);
        await waitForSocketClosed(fixture.socketPath).catch(() => undefined);
      }
      await terminateFixture(incumbent.child);
    }
  });

  it("hands off between different builds with the same display version", async () => {
    const fixture = await createTempState();
    const build = stationBuildInfo();
    const incumbentVersion = stationObserverBuildVersion({
      ...build,
      buildIdentity: "0".repeat(64),
    });
    const candidateVersion = stationObserverBuildVersion(build);
    const incumbent = await startIncumbentFixture({
      stateDir: fixture.stateDir,
      socketPath: fixture.socketPath,
      version: incumbentVersion,
    });
    const successorClient = createObserverClient({
      socketPath: fixture.socketPath,
      timeoutMs: 1000,
    });
    let successorStarted = false;

    try {
      const status = await startObserver(
        { config: observerConfig(fixture.stateDir, fixture.socketPath), timeoutMs: 10_000 },
        { buildVersion: candidateVersion },
      );
      expect(status).toMatchObject({
        status: "running",
        health: { version: candidateVersion, socketPath: fixture.socketPath },
      });
      if (status.status !== "running") throw new Error("Successor Observer did not start.");
      successorStarted = true;
      expect(status.health.pid).not.toBe(incumbent.child.pid);
      await expectProcessExit(incumbent.child.pid);
    } finally {
      if (successorStarted) {
        await successorClient.stop().catch(() => undefined);
        await waitForSocketClosed(fixture.socketPath).catch(() => undefined);
      }
      await terminateFixture(incumbent.child);
    }
  });

  it("preserves a typed executable mismatch when a live incumbent symlink is retargeted", async () => {
    const fixture = await createTempState();
    const config = observerConfig(fixture.stateDir, fixture.socketPath);
    const configPath = await writeConfigToml(fixture.root, config);
    const nodeImagesRoot = join(fixture.root, "node-images");
    const firstNode = join(nodeImagesRoot, "first", "bin", "node");
    const secondNode = join(nodeImagesRoot, "second", "bin", "node");
    const nodeLink = join(nodeImagesRoot, "node");
    await copyNodeExecutableImage(firstNode);
    await copyNodeExecutableImage(secondNode);
    await symlink(firstNode, nodeLink);

    const build = stationBuildInfo();
    const incumbentVersion = stationObserverBuildVersion({
      ...build,
      buildIdentity: "0".repeat(64),
    });
    const candidateVersion = stationObserverBuildVersion(build);
    const incumbent = await startIncumbentFixture({
      stateDir: fixture.stateDir,
      socketPath: fixture.socketPath,
      version: incumbentVersion,
      executablePath: nodeLink,
    });
    const pidfilePath = `${fixture.socketPath}.pid`;
    const originalSocket = await stat(fixture.socketPath);
    const originalPidfile = await stat(pidfilePath);
    const originalPidfileBytes = await readFile(pidfilePath);

    try {
      await unlink(nodeLink);
      await symlink(secondNode, nodeLink);
      const status = await startObserver(
        {
          config,
          configPath,
          timeoutMs: 10_000,
          observerCommand: [
            nodeLink,
            join(process.cwd(), "apps", "cli", "dist", "observerMain.js"),
          ],
        },
        { buildVersion: candidateVersion },
      );

      expect(status, JSON.stringify(status)).toMatchObject({
        status: "unhealthy",
        error: {
          code: "OBSERVER_HANDOFF_REFUSED",
          traceId: expect.any(String),
        },
        cause: {
          tag: "ObserverProcessEvidenceError",
          code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
          message: "Observer process evidence did not match the exact executable and argv.",
        },
        startupEvidence: {
          bootLogPath: join(fixture.stateDir, "logs", "observer-boot.log"),
        },
      });
      if (status.status === "running" || status.error === undefined) {
        throw new Error("Executable mismatch unexpectedly started an Observer.");
      }

      const serialized = JSON.stringify(status);
      expect(serialized).not.toContain("[object Object]");
      const rendered = observerStatusErrorMessage(status);
      expect(rendered).toContain("Observer build handoff was refused");
      expect(rendered).toContain(
        "Cause: Observer process evidence did not match the exact executable and argv. (OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH)",
      );
      expect(rendered).toContain(`Next: stn debug trace ${status.error.traceId}`);
      expect(rendered).not.toContain("observer-boot.log");

      const trace = await runCli([
        "--config",
        configPath,
        "debug",
        "trace",
        status.error.traceId ?? "",
      ]);
      expect(trace).toMatchObject({
        code: 0,
        output: {
          cause: { code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH" },
          causeAssessment: {
            status: "explicit_root_cause",
            explicitRootCauseCodes: ["OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH"],
          },
        },
      });

      const ingress = spawnSync(
        join(process.cwd(), "bin", "stn-ingress"),
        [
          "--socket",
          fixture.socketPath,
          "--state-dir",
          fixture.stateDir,
          "--startup-timeout-ms",
          "10000",
          "worktrunk",
          "post-create",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          input: JSON.stringify({ branch: "station/executable-mismatch" }),
          timeout: 20_000,
        },
      );
      if (ingress.error !== undefined) throw ingress.error;
      expect(ingress.status).toBe(1);
      expect(ingress.stderr).toContain("OBSERVER_HANDOFF_REFUSED");
      await expect(directoryFileCount(fixture.hookSpoolDir)).resolves.toBe(0);

      expect(processIsAlive(incumbent.child.pid)).toBe(true);
      await expect(incumbent.client.health()).resolves.toMatchObject({
        pid: incumbent.child.pid,
        version: incumbentVersion,
      });
      const currentSocket = await stat(fixture.socketPath);
      const currentPidfile = await stat(pidfilePath);
      expect({ ino: currentSocket.ino, birthtimeMs: currentSocket.birthtimeMs }).toEqual({
        ino: originalSocket.ino,
        birthtimeMs: originalSocket.birthtimeMs,
      });
      expect({ ino: currentPidfile.ino, birthtimeMs: currentPidfile.birthtimeMs }).toEqual({
        ino: originalPidfile.ino,
        birthtimeMs: originalPidfile.birthtimeMs,
      });
      await expect(readFile(pidfilePath)).resolves.toEqual(originalPidfileBytes);
    } finally {
      await terminateFixture(incumbent.child);
      await waitForSocketClosed(fixture.socketPath).catch(() => undefined);
    }
  });

  it("keeps ordinary losing-build refusal but explicitly activates an exact build", async () => {
    const fixture = await createTempState();
    const build = stationBuildInfo();
    const incumbentVersion = stationObserverBuildVersion({
      ...build,
      buildIdentity: "f".repeat(64),
    });
    const candidateVersion = stationObserverBuildVersion(build);
    const incumbent = await startIncumbentFixture({
      stateDir: fixture.stateDir,
      socketPath: fixture.socketPath,
      version: incumbentVersion,
    });
    const successorClient = createObserverClient({
      socketPath: fixture.socketPath,
      timeoutMs: 1000,
    });
    let successorStarted = false;
    let spawned = false;

    try {
      const refused = await startObserver(
        { config: observerConfig(fixture.stateDir, fixture.socketPath), timeoutMs: 10_000 },
        {
          buildVersion: candidateVersion,
          spawnObserver: async () => {
            spawned = true;
            throw new Error("same-version refusal must happen before spawn");
          },
        },
      );
      expect(refused).toMatchObject({
        status: "unhealthy",
        error: { code: "OBSERVER_HANDOFF_REFUSED" },
      });
      expect(spawned).toBe(false);
      expect(processIsAlive(incumbent.child.pid)).toBe(true);
      await expect(incumbent.client.health()).resolves.toMatchObject({
        pid: incumbent.child.pid,
        version: incumbentVersion,
      });

      const activated = await ensureExactObserverBuild(
        {
          config: observerConfig(fixture.stateDir, fixture.socketPath),
          timeoutMs: 10_000,
        },
        { buildVersion: candidateVersion },
      );
      expect(activated).toMatchObject({
        status: "running",
        lifecycle: "replaced",
        health: { version: candidateVersion },
      });
      successorStarted = activated.status === "running";
      await expectProcessExit(incumbent.child.pid);
    } finally {
      if (successorStarted) {
        await successorClient.stop().catch(() => undefined);
        await waitForSocketClosed(fixture.socketPath).catch(() => undefined);
      }
      await terminateFixture(incumbent.child);
    }
  });

  it("refuses a wedged internal preview without automatic SIGKILL", async () => {
    const fixture = await createTempState();
    const incumbent = await startIncumbentFixture({
      stateDir: fixture.stateDir,
      socketPath: fixture.socketPath,
      version: "0.7.1-rc.8",
      mode: "wedged",
    });

    try {
      const status = await startObserver(
        { config: observerConfig(fixture.stateDir, fixture.socketPath), timeoutMs: 10_000 },
        { buildVersion: stationObserverBuildVersion() },
      );
      expect(status.status).toBe("unhealthy");
      if (status.status === "running") throw new Error("Wedged incumbent was replaced.");
      expect(["OBSERVER_START_FAILED", "OBSERVER_HANDOFF_REFUSED"]).toContain(status.error?.code);
      if (status.error?.code === "OBSERVER_HANDOFF_REFUSED") {
        expect(status.cause?.code).toBe("OBSERVER_HANDOFF_REFUSED");
      }
      expect(processIsAlive(incumbent.child.pid)).toBe(true);
      await expect(incumbent.client.health()).resolves.toMatchObject({
        pid: incumbent.child.pid,
        version: "0.7.1-rc.8",
      });
      expect(
        ObserverProcessIdentitySchema.parse(
          JSON.parse(await readFile(`${fixture.socketPath}.pid`, "utf8")),
        ),
      ).toMatchObject({ pid: incumbent.child.pid, version: "0.7.1-rc.8" });
    } finally {
      await terminateFixture(incumbent.child);
      await waitForSocketClosed(fixture.socketPath).catch(() => undefined);
    }
  });

  it("refuses conflicting pidfile evidence before stopping the incumbent", async () => {
    const fixture = await createTempState();
    const incumbent = await startIncumbentFixture({
      stateDir: fixture.stateDir,
      socketPath: fixture.socketPath,
      version: "0.7.1-rc.8",
      pidfileVersion: "0.7.1-rc.7",
    });

    try {
      const status = await startObserver(
        { config: observerConfig(fixture.stateDir, fixture.socketPath), timeoutMs: 4000 },
        { buildVersion: stationObserverBuildVersion() },
      );
      expect(status).toMatchObject({
        status: "unhealthy",
        error: { code: "OBSERVER_HANDOFF_REFUSED" },
        cause: { code: "OBSERVER_HANDOFF_REFUSED" },
      });
      expect(processIsAlive(incumbent.child.pid)).toBe(true);
      await expect(incumbent.client.health()).resolves.toMatchObject({ pid: incumbent.child.pid });
    } finally {
      await terminateFixture(incumbent.child);
      await waitForSocketClosed(fixture.socketPath).catch(() => undefined);
    }
  });

  it("derives the default socket and persistent claim from state when XDG is unset", async () => {
    const fixture = await createTempState();
    const socketPath = join(fixture.stateDir, "run", "observer.sock");
    const claimPath = observerBootClaimPath(socketPath);
    const config = {
      ...emptyConfig(),
      observer: { stateDir: fixture.stateDir },
    };
    const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    const client = createObserverClient({ socketPath, timeoutMs: 1000 });
    let started = false;

    try {
      const status = await startObserver({ config, timeoutMs: 30_000 });
      expect(status).toMatchObject({ status: "running", paths: { socketPath } });
      started = status.status === "running";
      await expectClaimDatabase(claimPath);
    } finally {
      if (started) {
        await client.stop();
        await waitForSocketClosed(socketPath);
      }
      if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    }

    await expectClaimDatabase(claimPath);
  });

  it("keeps the claim inode stable across clean stop and restart", async () => {
    const fixture = await createTempState();
    const config = observerConfig(fixture.stateDir, fixture.socketPath);
    const client = createObserverClient({ socketPath: fixture.socketPath, timeoutMs: 1000 });
    const claimPath = observerBootClaimPath(fixture.socketPath);

    const first = await startObserver({ config, timeoutMs: 30_000 });
    expect(first.status).toBe("running");
    const firstClaim = await stat(claimPath);
    await expectClaimDatabase(claimPath);
    await client.stop();
    await waitForSocketClosed(fixture.socketPath);

    const second = await startObserver({ config, timeoutMs: 30_000 });
    expect(second.status).toBe("running");
    const secondClaim = await stat(claimPath);
    expect(secondClaim.ino).toBe(firstClaim.ino);
    await expectClaimDatabase(claimPath);
    await client.stop();
    await waitForSocketClosed(fixture.socketPath);

    expect((await stat(claimPath)).ino).toBe(firstClaim.ino);
    await expectClaimDatabase(claimPath);
  });

  it("abandons a displaced listener without deleting the successor socket or pidfile", async () => {
    const fixture = await createTempState();
    const config = observerConfig(fixture.stateDir, fixture.socketPath);
    const status = await startObserver({ config, timeoutMs: 30_000 });
    expect(status.status).toBe("running");
    if (status.status !== "running" || status.health.pid === undefined) {
      throw new Error("Observer did not report a process identity.");
    }
    const displacedPid = status.health.pid;
    const pidfilePath = `${fixture.socketPath}.pid`;
    let successor: Awaited<ReturnType<typeof listenUnixSocket>> | undefined;
    try {
      await unlink(fixture.socketPath);
      successor = await listenUnixSocket({
        socketPath: fixture.socketPath,
        onConnection: () => undefined,
      });
      const successorPidfile = "successor pidfile must survive displaced shutdown\n";
      await writeFile(pidfilePath, successorPidfile, { mode: 0o600 });

      await waitFor(async () => !processIsAlive(displacedPid), 10_000);
      await expect(probeUnixSocket(fixture.socketPath)).resolves.toMatchObject({
        status: "listening",
      });
      await expect(readFile(pidfilePath, "utf8")).resolves.toBe(successorPidfile);
    } finally {
      await successor?.close().catch(() => undefined);
      if (
        processIsAlive(displacedPid) &&
        (await observerProcessesForSocket(fixture.socketPath)).includes(displacedPid)
      ) {
        process.kill(displacedPid, "SIGTERM");
        await expectProcessExit(displacedPid).catch(() => undefined);
      }
      await rm(pidfilePath, { force: true });
    }
  });

  it("does not construct Observer state while a production boot claim is held", async () => {
    const fixture = await createTempState();
    const config = observerConfig(fixture.stateDir, fixture.socketPath);
    const claimResult = await acquireObserverBootClaim({
      socketPath: fixture.socketPath,
      timeoutMs: 1000,
    });
    expect(claimResult.status).toBe("acquired");
    if (claimResult.status !== "acquired") {
      throw new Error(`Could not hold Observer boot claim: ${claimResult.error.code}`);
    }

    const client = createObserverClient({ socketPath: fixture.socketPath, timeoutMs: 1000 });
    const startup = startObserver({ config, timeoutMs: 10_000 });
    let released = false;
    let status: Awaited<typeof startup> | undefined;
    try {
      await waitFor(
        async () => (await observerProcessesForSocket(fixture.socketPath)).length === 1,
        3000,
      );
      await sleep(100);
      await expect(access(join(fixture.stateDir, "observer.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(fixture.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(`${fixture.socketPath}.pid`)).rejects.toMatchObject({ code: "ENOENT" });

      expect(claimResult.release()).toEqual({ status: "released" });
      released = true;
      status = await startup;
      expect(status.status).toBe("running");
    } finally {
      if (!released) claimResult.release();
      status ??= await startup;
      if (status.status === "running") {
        await client.stop().catch(() => undefined);
        await waitForSocketClosed(fixture.socketPath).catch(() => undefined);
      }
    }
  });

  it("converges five starts from one real stale socket with spaces in its path", async () => {
    const fixture = await createTempState();
    const socketDir = await mkdtemp("/tmp/stn socket spaces ");
    const socketPath = join(socketDir, "observer socket.sock");
    const config = observerConfig(fixture.stateDir, socketPath);
    const client = createObserverClient({ socketPath, timeoutMs: 1000 });
    let started = false;

    try {
      await createRealStaleSocket(socketPath);
      const statuses = await Promise.all(
        Array.from({ length: 5 }, () => startObserver({ config, timeoutMs: 30_000 })),
      );
      started = statuses.some((status) => status.status === "running");
      await expectSingleObserver(statuses, socketPath);
      await expectClaimDatabase(observerBootClaimPath(socketPath));
    } finally {
      if (started) {
        await client.stop().catch(() => undefined);
        await waitForSocketClosed(socketPath).catch(() => undefined);
      }
      await rm(socketDir, { recursive: true, force: true });
    }
  });

  it("keeps identities distinct for sockets sharing one directory", async () => {
    const first = await createTempState();
    const second = await createTempState();
    const socketDir = join(first.root, "shared-run");
    const firstSocketPath = join(socketDir, "first.sock");
    const secondSocketPath = join(socketDir, "second.sock");
    const firstClient = createObserverClient({ socketPath: firstSocketPath, timeoutMs: 1000 });
    const secondClient = createObserverClient({ socketPath: secondSocketPath, timeoutMs: 1000 });
    let firstStarted = false;
    let secondStarted = false;

    try {
      const [firstStatus, secondStatus] = await Promise.all([
        startObserver({
          config: {
            ...emptyConfig(),
            observer: { stateDir: first.stateDir, socketPath: firstSocketPath },
          },
          timeoutMs: 30_000,
        }),
        startObserver({
          config: {
            ...emptyConfig(),
            observer: { stateDir: second.stateDir, socketPath: secondSocketPath },
          },
          timeoutMs: 30_000,
        }),
      ]);
      firstStarted = firstStatus.status === "running";
      secondStarted = secondStatus.status === "running";
      expect(firstStatus.status).toBe("running");
      expect(secondStatus.status).toBe("running");

      expect(
        ObserverProcessIdentitySchema.parse(
          JSON.parse(await readFile(`${firstSocketPath}.pid`, "utf8")),
        ).socketPath,
      ).toBe(firstSocketPath);
      expect(
        ObserverProcessIdentitySchema.parse(
          JSON.parse(await readFile(`${secondSocketPath}.pid`, "utf8")),
        ).socketPath,
      ).toBe(secondSocketPath);

      await secondClient.stop();
      await waitForSocketClosed(secondSocketPath);
      secondStarted = false;
      await expect(firstClient.health()).resolves.toMatchObject({ socketPath: firstSocketPath });
      await expect(access(`${firstSocketPath}.pid`)).resolves.toBeUndefined();
    } finally {
      if (secondStarted) {
        await secondClient.stop().catch(() => undefined);
        await waitForSocketClosed(secondSocketPath).catch(() => undefined);
      }
      if (firstStarted) {
        await firstClient.stop().catch(() => undefined);
        await waitForSocketClosed(firstSocketPath).catch(() => undefined);
      }
    }

    await expect(access(`${firstSocketPath}.pid`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${secondSocketPath}.pid`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("converges two stale starts on the XDG socket when state and runtime diverge", async () => {
    const fixture = await createTempState();
    const runtimeDir = await mkdtemp("/tmp/stn-xdg-");
    const socketPath = join(runtimeDir, "station", "observer.sock");
    const pidfilePath = `${socketPath}.pid`;
    const config = {
      ...emptyConfig(),
      observer: { stateDir: fixture.stateDir },
    };
    const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    const client = createObserverClient({ socketPath, timeoutMs: 1000 });
    let started = false;

    try {
      await createRealStaleSocket(socketPath);
      const statuses = await Promise.all([
        startObserver({ config, timeoutMs: 30_000 }),
        startObserver({ config, timeoutMs: 30_000 }),
      ]);
      started = statuses.some((status) => status.status === "running");
      await expectSingleObserver(statuses, socketPath);
      const status = statuses[0];
      if (status?.status !== "running") throw new Error("Observer failed to start.");

      expect(
        ObserverProcessIdentitySchema.parse(JSON.parse(await readFile(pidfilePath, "utf8"))),
      ).toMatchObject({
        pid: status.health.pid,
        version: status.health.version,
        socketPath,
      });
      await expect(access(join(fixture.stateDir, "observer.sock.pid"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expectClaimDatabase(observerBootClaimPath(socketPath));
      await expect(
        access(join(fixture.stateDir, "run", "observer.claim.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (started) {
        await client.stop();
        await waitForSocketClosed(socketPath);
        await expect(access(pidfilePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
      await rm(runtimeDir, { recursive: true, force: true });
    }
  });

  it("exits nonzero without serving health when identity publication fails", async () => {
    const fixture = await createTempState();
    const pidfilePath = `${fixture.socketPath}.pid`;
    await mkdir(pidfilePath, { recursive: true });
    const config = {
      ...emptyConfig(),
      observer: {
        stateDir: fixture.stateDir,
        socketPath: fixture.socketPath,
      },
    };
    const client = createObserverClient({ socketPath: fixture.socketPath, timeoutMs: 250 });

    const status = await startObserver({ config, timeoutMs: 30_000 });

    expect(status).toMatchObject({
      status: "unhealthy",
      error: {
        code: "OBSERVER_EXITED_ON_START",
        message: expect.stringContaining("exit code 1"),
      },
    });
    await expect(client.health()).rejects.toBeDefined();
    await expect(access(fixture.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a malformed-config child exit without waiting for the startup timeout", async () => {
    const fixture = await createTempState();
    const configPath = join(fixture.root, "malformed.toml");
    const bootLogPath = join(fixture.stateDir, "logs", "observer-boot.log");
    await writeFile(configPath, "not = [valid toml", "utf8");

    const startedAt = Date.now();
    const status = await startObserver({
      config: fixture.config,
      configPath,
      timeoutMs: 30_000,
    });
    const durationMs = Date.now() - startedAt;

    expect(durationMs).toBeLessThan(10_000);
    expect(status).toMatchObject({
      status: "unhealthy",
      error: {
        code: "OBSERVER_EXITED_ON_START",
        message: expect.stringContaining("exit code 1"),
      },
      cause: { message: "Invalid TOML document: cannot find end of structure" },
      startupEvidence: {
        bootLogPath,
        bootLogTail: expect.stringContaining("Station config file is not valid TOML."),
      },
    });
    expect(status.error?.hint ?? "").not.toContain("Station config file is not valid TOML.");
    await expect(readFile(bootLogPath, "utf8")).resolves.toContain(
      "Station config file is not valid TOML.",
    );
  });

  it("keeps concurrent failed startup diagnostics isolated and publishes one coherent latest log", async () => {
    const fixture = await createTempState();
    const malformedConfigPath = join(fixture.root, "malformed.toml");
    const missingConfigPath = join(fixture.root, "missing.toml");
    const bootLogPath = join(fixture.stateDir, "logs", "observer-boot.log");
    await writeFile(malformedConfigPath, "not = [valid toml", "utf8");

    const [malformedStatus, missingStatus] = await Promise.all([
      startObserver({
        config: fixture.config,
        configPath: malformedConfigPath,
        timeoutMs: 30_000,
      }),
      startObserver({
        config: fixture.config,
        configPath: missingConfigPath,
        timeoutMs: 30_000,
      }),
    ]);

    expect(malformedStatus).toMatchObject({
      status: "unhealthy",
      error: { code: "OBSERVER_EXITED_ON_START" },
      cause: { message: "Invalid TOML document: cannot find end of structure" },
      startupEvidence: {
        bootLogTail: expect.stringContaining("Station config file is not valid TOML."),
      },
    });
    expect(malformedStatus.error?.hint ?? "").not.toContain(
      "Station config file is not valid TOML.",
    );
    expect(missingStatus).toMatchObject({
      status: "unhealthy",
      error: { code: "OBSERVER_EXITED_ON_START" },
      cause: {
        code: "OBSERVER_STARTUP_CAUSE_ERROR",
        message: expect.stringContaining("ENOENT: no such file or directory"),
      },
      startupEvidence: {
        bootLogTail: expect.stringContaining("Station config file was not found."),
      },
    });
    expect(missingStatus.error?.hint ?? "").not.toContain("Station config file was not found.");

    const bootLog = await readFile(bootLogPath, "utf8");
    const [header = "", ...bodyLines] = bootLog.split(/\r?\n/);
    const command = JSON.parse(header).command as string[];
    const configPath = command[command.indexOf("--config") + 1];
    const body = bodyLines.join("\n");
    if (configPath === malformedConfigPath) {
      expect(body).toContain("Station config file is not valid TOML.");
      expect(body).not.toContain("Station config file was not found.");
    } else {
      expect(configPath).toBe(missingConfigPath);
      expect(body).toContain("Station config file was not found.");
      expect(body).not.toContain("Station config file is not valid TOML.");
    }
    expect((await stat(bootLogPath)).mode & 0o777).toBe(0o600);
  });

  it("starts a real observer process, serves protocol requests, and stops cleanly", async () => {
    const fixture = await createTempState();
    const config = {
      ...fixture.config,
      defaults: {
        worktreeProvider: "noop-worktree",
        terminal: "noop-terminal",
        harness: "noop-harness",
        layout: "agent-shell",
      },
    };
    const configPath = await writeConfigToml(fixture.root, config);
    const client = createObserverClient({ socketPath: fixture.socketPath, timeoutMs: 1000 });
    let started = false;

    try {
      const status = await startObserver({
        config,
        configPath,
        timeoutMs: 30_000,
      });
      expect(status).toMatchObject({
        status: "running",
        paths: {
          socketPath: fixture.socketPath,
        },
      });
      started = true;

      await expect(client.health()).resolves.toMatchObject({
        status: "healthy",
        socketPath: fixture.socketPath,
        stateDir: fixture.stateDir,
      });
      await expect(client.getSnapshot()).resolves.toMatchObject({
        schemaVersion: "0.11.0",
        counts: { projects: 0 },
      });
    } finally {
      if (started) {
        await client.stop();
        await waitForSocketClosed(fixture.socketPath);
      }
    }

    await expect(client.health()).rejects.toBeDefined();
  });
});

function observerConfig(stateDir: string, socketPath: string) {
  return {
    ...emptyConfig(),
    observer: { stateDir, socketPath },
  };
}

async function copyNodeExecutableImage(targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(process.execPath, targetPath);
  await chmod(targetPath, 0o755);
  if (process.platform !== "darwin") return;

  const sourceLibDir = join(dirname(process.execPath), "..", "lib");
  const targetLibDir = join(dirname(targetPath), "..", "lib");
  const nodeLibraries = (await readdir(sourceLibDir)).filter((name) =>
    /^libnode\..+\.dylib$/u.test(name),
  );
  if (nodeLibraries.length === 0) {
    throw new Error(`Node runtime libraries were unavailable under ${sourceLibDir}.`);
  }
  await mkdir(targetLibDir, { recursive: true });
  await Promise.all(
    nodeLibraries.map((name) => copyFile(join(sourceLibDir, name), join(targetLibDir, name))),
  );
}

async function startIncumbentFixture(input: {
  stateDir: string;
  socketPath: string;
  version: string;
  executablePath?: string;
  pidfileVersion?: string;
  mode?: "graceful" | "wedged";
  stopDelayMs?: number;
}): Promise<{
  child: ChildProcess;
  client: ReturnType<typeof createObserverClient>;
}> {
  const sourceRoot = join(dirname(input.stateDir), "incumbent-runtime");
  const observerEntry = join(sourceRoot, "apps", "cli", "dist", "observerMain.js");
  await mkdir(dirname(observerEntry), { recursive: true });
  await copyFile(join(process.cwd(), "tests", "support", "observerMain.js"), observerEntry);
  await writeFile(join(sourceRoot, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  const args = [
    observerEntry,
    "--socket",
    input.socketPath,
    "--state-dir",
    input.stateDir,
    "--startup-timeout-ms",
    "10000",
    "--build-version",
    input.version,
    "--process-token",
    randomUUID(),
  ];
  const child = spawn(input.executablePath ?? process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STATION_TEST_REPO_ROOT: process.cwd(),
      STATION_TEST_OBSERVER_MODE: input.mode ?? "graceful",
      STATION_TEST_STOP_DELAY_MS: String(input.stopDelayMs ?? 100),
      ...(input.pidfileVersion === undefined
        ? {}
        : { STATION_TEST_PIDFILE_VERSION: input.pidfileVersion }),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = createObserverClient({ socketPath: input.socketPath, timeoutMs: 500 });
  try {
    await waitFor(async () => {
      try {
        await client.health();
        return true;
      } catch {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Incumbent fixture exited before health.\n${stderr}`);
        }
        return false;
      }
    }, 5000);
    return { child, client };
  } catch (error) {
    await terminateFixture(child);
    throw error;
  }
}

async function terminateFixture(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || !processIsAlive(child.pid)) return;
  child.kill("SIGKILL");
  await expectProcessExit(child.pid).catch(() => undefined);
}

async function expectProcessExit(pid: number | undefined, timeoutMs = 5000): Promise<void> {
  if (pid === undefined) throw new Error("Process did not report a PID.");
  await waitFor(async () => !processIsAlive(pid), timeoutMs);
}

function processIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function expectClaimDatabase(path: string): Promise<void> {
  const info = await stat(path);
  expect(info.isFile()).toBe(true);
  expect(info.mode & 0o777).toBe(0o600);
  expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);

  const database = new DatabaseSync(path);
  try {
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    database.close();
  }
}

async function expectSingleObserver(
  statuses: readonly Awaited<ReturnType<typeof startObserver>>[],
  socketPath: string,
): Promise<void> {
  expect(
    statuses.every((status) => status.status === "running"),
    JSON.stringify(statuses),
  ).toBe(true);
  const pids = statuses.flatMap((status) =>
    status.status === "running" && status.health.pid !== undefined ? [status.health.pid] : [],
  );
  expect(new Set(pids).size).toBe(1);
  const pid = pids[0];
  expect(pid).toBeTypeOf("number");
  if (pid === undefined) throw new Error("Observer start did not report a PID.");

  const identity = ObserverProcessIdentitySchema.parse(
    JSON.parse(await readFile(`${socketPath}.pid`, "utf8")),
  );
  expect(identity).toMatchObject({ pid, socketPath });

  await waitFor(async () => (await observerProcessesForSocket(socketPath)).length === 1, 3000);
  expect(await observerProcessesForSocket(socketPath)).toEqual([pid]);

  expect(await socketHolders(socketPath)).toEqual([pid]);
}

async function socketHolders(socketPath: string): Promise<number[]> {
  if (process.platform === "linux") return linuxSocketHolders(socketPath);

  const { stdout } = await execFileAsync("lsof", ["-t", socketPath]);
  return [
    ...new Set(
      stdout
        .split(/\s+/)
        .filter((value) => value.length > 0)
        .map(Number),
    ),
  ].sort((left, right) => left - right);
}

async function linuxSocketHolders(socketPath: string): Promise<number[]> {
  // Linux lsof cannot reliably match Unix socket paths with whitespace, so correlate /proc inodes.
  const socketLine = (await readFile("/proc/net/unix", "utf8"))
    .split(/\r?\n/)
    .find((line) => line.endsWith(` ${socketPath}`));
  const inode = socketLine?.trim().split(/\s+/, 8)[6];
  if (inode === undefined || !/^\d+$/.test(inode)) return [];

  const expectedLink = `socket:[${inode}]`;
  const holders = new Set<number>();
  for (const processEntry of await readdir("/proc", { withFileTypes: true })) {
    if (!processEntry.isDirectory() || !/^[1-9]\d*$/.test(processEntry.name)) continue;
    const fdDir = join("/proc", processEntry.name, "fd");
    let fileDescriptors: string[];
    try {
      fileDescriptors = await readdir(fdDir);
    } catch {
      continue;
    }
    for (const fileDescriptor of fileDescriptors) {
      try {
        if ((await readlink(join(fdDir, fileDescriptor))) !== expectedLink) continue;
        holders.add(Number(processEntry.name));
        break;
      } catch {
        // Processes and descriptors may disappear while /proc is scanned.
      }
    }
  }
  return [...holders].sort((left, right) => left - right);
}

async function observerProcessesForSocket(socketPath: string): Promise<number[]> {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,command="]);
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.includes("observerMain.js") && line.includes(socketPath))
    .map((line) => Number.parseInt(line.trimStart().split(/\s+/, 1)[0] ?? "", 10))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
}

async function directoryFileCount(path: string): Promise<number> {
  try {
    return (await readdir(path)).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await condition()) return;
    await sleep(25);
  }
  throw new Error(`Condition did not become true within ${timeoutMs}ms.`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
