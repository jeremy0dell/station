import { access, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startObserver } from "@station/cli";
import { emptyConfig } from "@station/config";
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
    let started = false;

    try {
      const status = await startObserver({ config, timeoutMs: 30_000 });
      expect(status).toMatchObject({
        status: "running",
        paths: { socketPath: fixture.socketPath },
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
    } finally {
      if (started) {
        await client.stop();
        await waitForSocketClosed(fixture.socketPath);
      }
    }
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
