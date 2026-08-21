import { chmod, lstat } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "@station/cli";
import { runObserverCommand } from "@station/cli/internal";
import { listenUnixSocket } from "@station/protocol";
import { describe, expect, it, vi } from "vitest";
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
              schemaVersion: "0.11.0",
              status: "healthy",
              pid: 1234,
              startedAt: now,
              version: zeroBuildVersion,
              socketPath: fixture.socketPath,
            };
          },
          stop: async () => {
            running = false;
            return { schemaVersion: "0.11.0", stopped: true, at: now };
          },
        }) as never,
      sleep: async () => undefined,
    };

    await expect(
      runObserverCommand(["start"], { config: fixture.config }, deps),
    ).resolves.toMatchObject({ status: "running" });
    await expect(
      runObserverCommand(["ensure-exact-build"], { config: fixture.config }, deps),
    ).resolves.toMatchObject({ status: "running", lifecycle: "reused" });
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
              schemaVersion: "0.11.0",
              status: "healthy",
              pid: 1234,
              startedAt: now,
              version: zeroBuildVersion,
              socketPath: fixture.socketPath,
            };
          },
          stop: async () => {
            running = false;
            return { schemaVersion: "0.11.0", stopped: true, at: now };
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
      runCli(["--config", configPath, "observer", "ensure-exact-build"], {
        observerDeps: deps,
      }),
    ).resolves.toMatchObject({
      code: 0,
      output: {
        status: "running",
        socketPath: fixture.socketPath,
        lifecycle: "reused",
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
            schemaVersion: "0.11.0",
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

  it("projects distinct outer, causal, and startup evidence fields in JSON", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const result = await runCli(
      ["--config", configPath, "observer", "start", "--timeout-ms", "1500"],
      {
        observerDeps: {
          buildVersion: requestedBuildVersion,
          spawnObserver: async () => ({
            pid: 4321,
            unref: () => undefined,
            exited: Promise.resolve({
              type: "exit" as const,
              code: 1,
              signal: null,
              report: {
                kind: "observer-startup-failure" as const,
                version: 1 as const,
                error: {
                  tag: "ObserverHandoffError",
                  code: "OBSERVER_HANDOFF_REFUSED",
                  message: "The incumbent Observer could not be replaced safely.",
                },
                cause: {
                  tag: "ObserverProcessEvidenceError",
                  code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
                  message: "Observer process evidence did not match the exact executable and argv.",
                },
              },
            }),
            readBootLogTail: async () => "boot line API_TOKEN=super-secret-value",
          }),
          clientFactory: () =>
            ({
              health: async () => {
                throw new Error("not running");
              },
            }) as never,
        },
      },
    );

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "unhealthy",
        error: { code: "OBSERVER_EXITED_ON_START" },
        cause: { code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH" },
        startupEvidence: {
          bootLogPath: join(fixture.stateDir, "logs", "observer-boot.log"),
          bootLogTail: "boot line API_TOKEN=[REDACTED]",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    expect(JSON.stringify(result)).not.toContain("[object Object]");
  });

  it.each([
    { label: "snapshot", args: ["snapshot", "--json"] },
    { label: "doctor", args: ["doctor"] },
    { label: "reconcile", args: ["reconcile"] },
    { label: "command", args: ["command", "dispatch", "--stdin"] },
    { label: "observe", args: ["observe", "--json", "--duration", "1ms"] },
    { label: "debug bundle", args: ["debug", "bundle"] },
  ])("retains lifecycle fields across the $label auto-start boundary", async ({ args }) => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    let healthCalls = 0;
    const lifecycleAttempt = runCli(["--config", configPath, ...args], {
      stdin: JSON.stringify({
        type: "observer.reconcile",
        payload: { reason: "lifecycle-boundary" },
      }),
      observerDeps: {
        buildVersion: requestedBuildVersion,
        spawnObserver: async () => ({
          pid: 4321,
          unref: () => undefined,
          exited: Promise.resolve({
            type: "exit" as const,
            code: 1,
            signal: null,
            report: {
              kind: "observer-startup-failure" as const,
              version: 1 as const,
              error: {
                tag: "ObserverHandoffError",
                code: "OBSERVER_HANDOFF_REFUSED",
                message: "The incumbent Observer could not be replaced safely.",
              },
              cause: {
                tag: "ObserverProcessEvidenceError",
                code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
                message: "Observer process evidence did not match the exact executable and argv.",
              },
            },
          }),
          readBootLogTail: async () => "replacement refused",
        }),
        clientFactory: () =>
          ({
            health: async () => {
              healthCalls += 1;
              return healthCalls <= 2
                ? {
                    schemaVersion: "0.11.0",
                    status: "healthy",
                    pid: 1234,
                    startedAt: now,
                    version: zeroBuildVersion,
                    socketPath: fixture.socketPath,
                  }
                : {
                    schemaVersion: "0.11.0",
                    status: "healthy",
                    pid: 9876,
                    startedAt: now,
                    version: `1.2.3+station.${"f".repeat(64)}`,
                    socketPath: fixture.socketPath,
                  };
            },
          }) as never,
      },
    });

    await expect(lifecycleAttempt).rejects.toMatchObject({
      error: { code: "OBSERVER_HANDOFF_REFUSED" },
      cause: { code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH" },
      startupEvidence: {
        bootLogPath: join(fixture.stateDir, "logs", "observer-boot.log"),
        bootLogTail: "replacement refused",
      },
    });
  });

  it("reports inaccessible ownership and fails start, restart, and doctor without mutation", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const server = await listenUnixSocket({
      socketPath: fixture.socketPath,
      onConnection: () => undefined,
    });
    const before = await lstat(fixture.socketPath, { bigint: true });
    const spawnObserver = vi.fn(async () => ({ pid: 1234, unref: () => undefined }));
    const observerDeps = { buildVersion: zeroBuildVersion, spawnObserver };
    try {
      await chmod(fixture.socketPath, 0o000);
      await expect(
        runCli(["--config", configPath, "observer", "status"], { observerDeps }),
      ).resolves.toMatchObject({
        code: 0,
        output: {
          status: "unhealthy",
          error: { code: "OBSERVER_SOCKET_INACCESSIBLE" },
        },
      });
      for (const action of ["start", "ensure-exact-build", "restart"]) {
        const result = await runCli(["--config", configPath, "observer", action], {
          observerDeps,
        });
        expect(result).toMatchObject({
          code: 1,
          output: {
            status: "unhealthy",
            error: {
              code:
                action === "ensure-exact-build"
                  ? "OBSERVER_EXACT_BUILD_ACTIVATION_FAILED"
                  : "OBSERVER_SOCKET_INACCESSIBLE",
            },
          },
        });
        if (action === "ensure-exact-build") {
          expect(result).toMatchObject({
            output: {
              phase: "inspection",
              incumbentDisposition: "preserved",
              cause: { code: "OBSERVER_SOCKET_INACCESSIBLE" },
            },
          });
        }
      }
      await expect(
        runCli(["--config", configPath, "doctor"], { observerDeps }),
      ).rejects.toMatchObject({ error: { code: "OBSERVER_SOCKET_INACCESSIBLE" } });
      const after = await lstat(fixture.socketPath, { bigint: true });
      expect({ ino: after.ino, birthtimeNs: after.birthtimeNs }).toEqual({
        ino: before.ino,
        birthtimeNs: before.birthtimeNs,
      });
      expect(spawnObserver).not.toHaveBeenCalled();
    } finally {
      await chmod(fixture.socketPath, 0o600);
      await server.close();
    }
  });
});
