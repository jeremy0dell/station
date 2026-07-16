import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { startObserver } from "@station/cli";
import { emptyConfig } from "@station/config";
import { ObserverProcessIdentitySchema } from "@station/contracts";
import { acquireObserverBootClaim, observerBootClaimPath } from "@station/observer/internal";
import { createObserverClient } from "@station/protocol";
import { stationBuildInfo, stationObserverBuildVersion } from "@station/runtime";
import { describe, expect, it } from "vitest";
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
      expect(Object.keys(identity).sort()).toEqual(["osStartTime", "pid", "socketPath", "version"]);
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
        schemaVersion: "0.8.0",
        observer: { version: build.version },
        counts: { projects: 0 },
      });
      await expect(access(join(fixture.root, "config.toml"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const bootLog = await readFile(bootLogPath, "utf8");
      expect(bootLog).not.toContain("stale observer boot output");
      const header = bootLog.split(/\r?\n/, 1)[0];
      expect(JSON.parse(header ?? "")).toEqual({
        command: [
          process.execPath,
          expect.stringMatching(/observerMain\.js$/),
          "--socket",
          fixture.socketPath,
          "--state-dir",
          fixture.stateDir,
          "--startup-timeout-ms",
          "30000",
        ],
      });
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

  it("replaces a lower build only after its process and socket have closed", async () => {
    const fixture = await createTempState();
    const incumbent = await startIncumbentFixture({
      stateDir: fixture.stateDir,
      socketPath: fixture.socketPath,
      version: "0.6.0",
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
      expect(status).toMatchObject({
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

  it("refuses a losing same-version build until the incumbent is explicitly stopped", async () => {
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

      await incumbent.client.stop();
      await waitForSocketClosed(fixture.socketPath);
      await expectProcessExit(incumbent.child.pid);
      const restarted = await startObserver({
        config: observerConfig(fixture.stateDir, fixture.socketPath),
        timeoutMs: 10_000,
      });
      expect(restarted).toMatchObject({
        status: "running",
        health: { version: candidateVersion },
      });
      successorStarted = restarted.status === "running";
    } finally {
      if (successorStarted) {
        await successorClient.stop().catch(() => undefined);
        await waitForSocketClosed(fixture.socketPath).catch(() => undefined);
      }
      await terminateFixture(incumbent.child);
    }
  });

  it("refuses a wedged lower build without automatic SIGKILL", async () => {
    const fixture = await createTempState();
    const incumbent = await startIncumbentFixture({
      stateDir: fixture.stateDir,
      socketPath: fixture.socketPath,
      version: "0.6.0",
      mode: "wedged",
    });

    try {
      const status = await startObserver(
        { config: observerConfig(fixture.stateDir, fixture.socketPath), timeoutMs: 10_000 },
        { buildVersion: stationObserverBuildVersion() },
      );
      expect(status).toMatchObject({
        status: "unhealthy",
        error: { code: "OBSERVER_HANDOFF_REFUSED" },
      });
      expect(processIsAlive(incumbent.child.pid)).toBe(true);
      await expect(incumbent.client.health()).resolves.toMatchObject({
        pid: incumbent.child.pid,
        version: "0.6.0",
      });
      expect(
        ObserverProcessIdentitySchema.parse(
          JSON.parse(await readFile(`${fixture.socketPath}.pid`, "utf8")),
        ),
      ).toMatchObject({ pid: incumbent.child.pid, version: "0.6.0" });
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
      version: "0.6.0",
      pidfileVersion: "0.5.0",
    });

    try {
      const status = await startObserver(
        { config: observerConfig(fixture.stateDir, fixture.socketPath), timeoutMs: 4000 },
        { buildVersion: stationObserverBuildVersion() },
      );
      expect(status).toMatchObject({
        status: "unhealthy",
        error: { code: "OBSERVER_HANDOFF_REFUSED" },
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
        hint: expect.stringContaining(`Latest observer boot log: ${bootLogPath}`),
      },
    });
    expect(status.error?.hint).toContain("Station config file is not valid TOML.");
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
    });
    expect(malformedStatus.error?.hint).toContain("Station config file is not valid TOML.");
    expect(malformedStatus.error?.hint).not.toContain("Station config file was not found.");
    expect(missingStatus).toMatchObject({
      status: "unhealthy",
      error: { code: "OBSERVER_EXITED_ON_START" },
    });
    expect(missingStatus.error?.hint).toContain("Station config file was not found.");
    expect(missingStatus.error?.hint).not.toContain("Station config file is not valid TOML.");

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
        schemaVersion: "0.8.0",
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

async function startIncumbentFixture(input: {
  stateDir: string;
  socketPath: string;
  version: string;
  pidfileVersion?: string;
  mode?: "graceful" | "wedged";
  stopDelayMs?: number;
}): Promise<{
  child: ChildProcess;
  client: ReturnType<typeof createObserverClient>;
}> {
  const args = [
    join(process.cwd(), "tests", "support", "observerMain.js"),
    "--socket",
    input.socketPath,
    "--state-dir",
    input.stateDir,
    "--version",
    input.version,
    "--mode",
    input.mode ?? "graceful",
    "--stop-delay-ms",
    String(input.stopDelayMs ?? 100),
  ];
  if (input.pidfileVersion !== undefined) {
    args.push("--pidfile-version", input.pidfileVersion);
  }
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
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
  expect(statuses.every((status) => status.status === "running")).toBe(true);
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
