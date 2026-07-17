import { runCli } from "@station/cli";
import { runObserverCommand } from "@station/cli/internal";
import { describe, expect, it } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";

const now = "2026-05-20T12:00:00.000Z";
const zeroBuildVersion = `0.0.0+station.${"0".repeat(64)}`;
const requestedBuildIdentity = "a".repeat(64);
const requestedBuildVersion = `1.2.3+station.${requestedBuildIdentity}`;

describe("CLI observer commands", () => {
  it("starts, reports status, stops, and restarts through injected process/protocol boundaries", async () => {
    const fixture = await createTempState();
    let running = false;
    const deps = {
      buildVersion: zeroBuildVersion,
      spawnObserver: async () => {
        running = true;
        return { pid: 1234, unref: () => undefined };
      },
      clientFactory: () =>
        ({
          health: async () => {
            if (!running) {
              throw new Error("stopped");
            }
            return {
              schemaVersion: "0.8.0",
              status: "healthy",
              pid: 1234,
              startedAt: now,
              version: zeroBuildVersion,
              socketPath: fixture.socketPath,
            };
          },
          stop: async () => {
            running = false;
            return { schemaVersion: "0.8.0", stopped: true, at: now };
          },
        }) as never,
      sleep: async () => undefined,
    };

    await expect(
      runObserverCommand(["start"], { config: fixture.config }, deps),
    ).resolves.toMatchObject({ status: "running" });
    await expect(
      runObserverCommand(["status"], { config: fixture.config }, deps),
    ).resolves.toMatchObject({ status: "running" });
    await expect(
      runObserverCommand(["stop"], { config: fixture.config }, deps),
    ).resolves.toMatchObject({ stopped: true });
    await expect(
      runObserverCommand(["restart"], { config: fixture.config }, deps),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("routes runCli observer commands through global --config parsing and summaries", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    let running = false;
    const deps = {
      buildVersion: zeroBuildVersion,
      spawnObserver: async () => {
        running = true;
        return { pid: 1234, unref: () => undefined };
      },
      clientFactory: () =>
        ({
          health: async () => {
            if (!running) {
              throw new Error("stopped");
            }
            return {
              schemaVersion: "0.8.0",
              status: "healthy",
              pid: 1234,
              startedAt: now,
              version: zeroBuildVersion,
              socketPath: fixture.socketPath,
            };
          },
          stop: async () => {
            running = false;
            return { schemaVersion: "0.8.0", stopped: true, at: now };
          },
        }) as never,
      sleep: async () => undefined,
    };

    await expect(
      runCli(["--config", configPath, "observer", "start"], { observerDeps: deps }),
    ).resolves.toMatchObject({
      code: 0,
      output: {
        status: "running",
        socketPath: fixture.socketPath,
        health: { status: "healthy" },
      },
    });
    await expect(
      runCli(["--config", configPath, "observer", "status"], { observerDeps: deps }),
    ).resolves.toMatchObject({
      code: 0,
      output: {
        status: "running",
        socketPath: fixture.socketPath,
      },
    });
    await expect(
      runCli(["--config", configPath, "observer", "stop"], { observerDeps: deps }),
    ).resolves.toMatchObject({
      code: 0,
      output: {
        stopped: true,
      },
    });
  });

  it("rejects invalid observer timeout values before contacting the observer", async () => {
    const fixture = await createTempState();

    await expect(
      runObserverCommand(
        ["status", "--timeout-ms", "nope"],
        { config: fixture.config },
        {
          clientFactory: () => {
            throw new Error("observer should not be contacted for invalid timeout input");
          },
        },
      ),
    ).rejects.toThrow("--timeout-ms must be a positive integer.");
  });

  it("returns a failing CLI result when a legacy incumbent cannot be handed off safely", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const observerDeps = {
      buildVersion: requestedBuildVersion,
      clientFactory: () =>
        ({
          health: async () => ({
            schemaVersion: "0.8.0",
            status: "healthy",
            pid: 1234,
            startedAt: now,
            version: "1.2.3",
            socketPath: fixture.socketPath,
          }),
        }) as never,
    };

    await expect(
      runCli(["--config", configPath, "observer", "start"], {
        observerDeps,
      }),
    ).resolves.toMatchObject({
      code: 1,
      output: {
        status: "unhealthy",
        error: {
          code: "OBSERVER_HANDOFF_REFUSED",
          hint: expect.stringMatching(
            /Running build: 1\.2\.3 \(legacy identity\).*Requested build: 1\.2\.3 \(build a{12}\).*`stn observer stop`/u,
          ),
        },
      },
    });

    await expect(
      runCli(["--config", configPath, "observer", "--timeout-ms", "100", "start"], {
        observerDeps,
      }),
    ).resolves.toMatchObject({
      code: 1,
      output: {
        status: "unhealthy",
        error: { code: "OBSERVER_HANDOFF_REFUSED" },
      },
    });

    await expect(
      runCli(["--config", configPath, "observer", "status"], { observerDeps }),
    ).resolves.toMatchObject({ code: 0, output: { status: "running" } });
  });
});
