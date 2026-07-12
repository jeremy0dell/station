import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startObserver } from "@station/cli";
import { emptyConfig } from "@station/config";
import { ObserverProcessIdentitySchema } from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import { describe, expect, it } from "vitest";
import { waitForSocketClosed } from "../support/sockets";
import { createTempState, writeConfigToml } from "../support/temp-projects";

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
        schemaVersion: "0.7.0",
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

  it("publishes identity beside an XDG runtime socket", async () => {
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
      const status = await startObserver({ config, timeoutMs: 30_000 });
      expect(status).toMatchObject({
        status: "running",
        paths: { socketPath },
        health: { socketPath },
      });
      if (status.status !== "running") {
        throw new Error(`Observer failed to start: ${status.status}`);
      }
      started = true;

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
        schemaVersion: "0.7.0",
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
