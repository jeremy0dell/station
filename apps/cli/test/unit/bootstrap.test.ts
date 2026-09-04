import { describe, expect, it, vi } from "vitest";
import { isCommandDispatchInvocation, runCliBootstrap } from "../../src/bootstrap.js";
import { cliCommandRegistry } from "../../src/commandRegistry.js";
import { allTopLevelCliCommandNames } from "../../src/topLevelCliCommands.js";

describe("CLI bootstrap", () => {
  it("enables the compile cache before loading and running the CLI graph", async () => {
    const order: string[] = [];
    const runCliMain = vi.fn(async () => {
      order.push("run");
    });

    const buildInfo = {
      version: "1.0.0",
      compiled: false,
      buildIdentity: "a".repeat(64),
    } as const;

    await runCliBootstrap(["--version"], {
      enableCompileCache: () => {
        order.push("cache");
      },
      loadBuildInfo: async () => {
        order.push("build-module");
        return {
          stationBuildInfoAsync: async () => {
            order.push("admit");
            return buildInfo;
          },
        };
      },
      loadCliProcess: async () => {
        order.push("cli-module");
        return { runCliMain };
      },
    });

    expect(order).toEqual(["cache", "build-module", "admit", "cli-module", "run"]);
    expect(runCliMain).toHaveBeenCalledWith(["--version"], {
      updateDeps: { currentBuildInfo: buildInfo },
    });
  });

  it("continues when compile-cache admission fails", async () => {
    const runCliMain = vi.fn(async () => undefined);

    await runCliBootstrap([], {
      enableCompileCache: () => {
        throw new Error("cache unavailable");
      },
      loadBuildInfo: async () => ({
        stationBuildInfoAsync: async () => ({
          version: "1.0.0",
          compiled: false,
          buildIdentity: "a".repeat(64),
        }),
      }),
      loadCliProcess: async () => ({ runCliMain }),
    });

    expect(runCliMain).toHaveBeenCalledOnce();
  });

  it("routes asynchronous build rejection through normal CLI error handling", async () => {
    const failure = new Error("stale build");
    const runCliMain = vi.fn(async (_argv, options) => {
      expect(() => options.updateDeps?.buildInfo?.()).toThrow(failure);
    });

    await runCliBootstrap([], {
      enableCompileCache: () => undefined,
      loadBuildInfo: async () => ({
        stationBuildInfoAsync: async () => {
          throw failure;
        },
      }),
      loadCliProcess: async () => ({ runCliMain }),
    });

    expect(runCliMain).toHaveBeenCalledOnce();
  });

  it.each([
    ["direct", ["command", "dispatch", "--stdin"]],
    ["leading config", ["--config", "/tmp/station.toml", "command", "dispatch", "--stdin"]],
    ["interleaved config", ["command", "--config", "/tmp/station.toml", "dispatch"]],
  ])("selects the narrow process for %s typed dispatch", (_name, argv) => {
    expect(isCommandDispatchInvocation(argv)).toBe(true);
  });

  it.each([
    ["another command", ["command", "get", "cmd_1"]],
    ["route help", ["command", "dispatch", "--help"]],
    ["manual", ["command", "dispatch", "--man"]],
    ["missing config value", ["--config", "command", "dispatch", "--stdin"]],
    ["option-shaped config value", ["--config", "--stdin", "command", "dispatch"]],
  ])("keeps %s on the registered CLI process", (_name, argv) => {
    expect(isCommandDispatchInvocation(argv)).toBe(false);
  });

  it("keeps the lightweight command-name index synchronized with the registry", () => {
    expect(allTopLevelCliCommandNames()).toEqual(
      cliCommandRegistry.children?.map((command) => command.name),
    );
  });
});
