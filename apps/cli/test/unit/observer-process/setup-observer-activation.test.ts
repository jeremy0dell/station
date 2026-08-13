import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempState } from "../../../../../tests/support/temp-projects";
import { createObserverActivationAdapter } from "../../../src/commands/setup/adapters/observerActivation.js";

const restartObserverSpy = vi.hoisted(() => vi.fn());

vi.mock("../../../src/observerProcess.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/observerProcess.js")>();
  return {
    ...actual,
    restartObserver: (...args: unknown[]) => restartObserverSpy(...args),
  };
});

const now = "2026-05-20T12:00:00.000Z";
const compiledBuildVersion = `0.0.0-pre-alpha.5.5+station.${"d".repeat(64)}`;

restartObserverSpy.mockImplementation(async () => ({
  status: "running",
  paths: {
    socketPath: "unused",
    stateDir: "unused",
  },
  health: {
    schemaVersion: "0.11.0",
    status: "healthy",
    pid: 1234,
    startedAt: now,
    version: compiledBuildVersion,
  },
}));

type RestartObserverInput = {
  onStartupProgress?: (message: string) => void;
};

beforeEach(() => {
  restartObserverSpy.mockClear();
});

describe("setup activation wires observer startup progress", () => {
  it("forwards a functional onStartupProgress callback to restartObserver", async () => {
    const fixture = await createTempState();
    const configPath = join(fixture.root, "config.toml");
    await writeFile(
      configPath,
      [
        "schema_version = 1",
        "projects = []",
        "",
        "[observer]",
        `socket_path = ${JSON.stringify(fixture.socketPath)}`,
        `state_dir = ${JSON.stringify(fixture.stateDir)}`,
        "",
        "[defaults]",
        'worktree_provider = "worktrunk"',
        'terminal = "tmux"',
        'harness = "codex"',
        'layout = "agent-build-shell"',
        "",
      ].join("\n"),
      "utf8",
    );

    const progress: string[] = [];
    const adapter = createObserverActivationAdapter({
      configPath: () => configPath,
      homeDir: fixture.root,
      onStartupProgress: (message) => progress.push(message),
    });
    const outcome = await adapter({
      id: "activate-observer-config",
      kind: "activate-observer-config",
      tier: "required",
      selected: true,
    });

    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "completed",
      operationId: "activate-observer-config",
    });
    expect(restartObserverSpy).toHaveBeenCalledTimes(1);
    const [input] = (restartObserverSpy.mock.calls[0] ?? []) as [RestartObserverInput?];
    expect(input?.onStartupProgress).toEqual(expect.any(Function));
    input?.onStartupProgress?.("Starting STATION observer…");
    expect(progress).toEqual(["Starting STATION observer…"]);
  });

  it("passes the startup progress callback through to an injected activateObserverConfig", async () => {
    const progress: string[] = [];
    const received: { onStartupProgress?: (message: string) => void }[] = [];
    const adapter = createObserverActivationAdapter({
      configPath: () => join("unused", "config.toml"),
      homeDir: "unused",
      onStartupProgress: (message) => progress.push(message),
      activateObserverConfig: async (input) => {
        received.push(input);
      },
    });
    const outcome = await adapter({
      id: "activate-observer-config",
      kind: "activate-observer-config",
      tier: "required",
      selected: true,
    });

    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "completed",
      operationId: "activate-observer-config",
    });
    expect(restartObserverSpy).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0]?.onStartupProgress).toEqual(expect.any(Function));
    received[0]?.onStartupProgress?.("Still waiting for STATION observer");
    expect(progress).toEqual(["Still waiting for STATION observer"]);
  });

  it("omits progress wiring when no callback is supplied", async () => {
    const received: { onStartupProgress?: (message: string) => void }[] = [];
    const adapter = createObserverActivationAdapter({
      configPath: () => join("unused", "config.toml"),
      homeDir: "unused",
      activateObserverConfig: async (input) => {
        received.push(input);
      },
    });
    const outcome = await adapter({
      id: "activate-observer-config",
      kind: "activate-observer-config",
      tier: "required",
      selected: true,
    });

    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "completed",
      operationId: "activate-observer-config",
    });
    expect(received).toHaveLength(1);
    expect(Object.hasOwn(received[0] ?? {}, "onStartupProgress")).toBe(false);
  });
});
