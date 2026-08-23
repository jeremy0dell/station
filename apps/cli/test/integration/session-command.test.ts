import { runCli } from "@station/cli";
import { runSessionCommand } from "@station/cli/internal";
import type { CurrentSessionContext, TerminalCallerContextRequest } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";

const now = "2026-08-21T12:00:00.000Z";
const context: CurrentSessionContext = {
  source: {
    provider: "tmux",
    targetId: "tmux:generation:$1:@2:%3",
    generation: "generation",
    authorityId: "authority",
    expiresAt: "2026-08-21T12:10:00.000Z",
  },
  presentation: "presented",
};

describe("session current command", () => {
  it("prints the strict JSON result and forwards only bounded tmux claims", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const callers: TerminalCallerContextRequest[] = [];

    try {
      const result = await runCli(["--config", configPath, "session", "current"], {
        sessionDeps: {
          processEvidence: {
            read: (pid) => ({ pid, parentPid: 1, startToken: "process-start" }),
          },
          environment: {
            TMUX: "/tmp/tmux.sock,123,0",
            TMUX_PANE: "%3",
            STATION_MUST_NOT_CROSS_RPC: "secret",
          },
        },
        observerDeps: runningObserverDeps(fixture.socketPath, async (caller) => {
          callers.push(caller);
          return context;
        }),
      });

      expect(result).toEqual({ code: 0, output: context });
      expect(callers).toHaveLength(1);
      expect(callers[0]?.process).toMatchObject({ pid: process.pid });
      expect(callers[0]?.process.startToken).toBe("process-start");
      expect(callers[0]?.claims).toEqual({
        TMUX: "/tmp/tmux.sock,123,0",
        TMUX_PANE: "%3",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("renders parent and leaf help without loading config or starting Observer", async () => {
    const spawnObserver = vi.fn();

    const parent = await runCli(["--config", "/missing/config.toml", "session", "--help"], {
      observerDeps: { spawnObserver },
    });
    const leaf = await runCli(
      ["--config", "/missing/config.toml", "session", "current", "--help"],
      { observerDeps: { spawnObserver } },
    );

    expect(parent).toMatchObject({ code: 0, outputFormat: "text" });
    expect(textOutput(parent)).toContain("Resolve verified context for the invoking terminal.");
    expect(textOutput(parent)).toContain("pnpm stn session current");
    expect(leaf).toMatchObject({ code: 0, outputFormat: "text" });
    expect(textOutput(leaf)).toContain("Print the verified invoking terminal context as JSON.");
    expect(textOutput(leaf)).toContain("pnpm stn session current");
    expect(spawnObserver).not.toHaveBeenCalled();
  });

  it("documents execution, placement support, source handling, and detached placement", async () => {
    const result = await runCli(["session", "current", "--man"]);

    expect(result).toMatchObject({ code: 0, outputFormat: "text" });
    const manual = textOutput(result);
    expect(manual).toContain("Normal execution loads configuration");
    expect(manual).toContain("may start or contact the Observer");
    expect(manual).toContain("tmux is currently the only placement-capable terminal provider");
    expect(manual).toContain("short-lived, one-shot bearer input");
    expect(manual).toContain("raw sibling session.create or session.fork dispatch");
    expect(manual).toContain("do not persist or log it");
    expect(manual).toContain("Detached placement is source-free");
    expect(manual).toContain("does not use stn session current");
  });

  it("reports missing, unknown, and extra arguments with accurate help hints", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const spawnObserver = vi.fn();

    try {
      await expect(
        runCli(["--config", configPath, "session"], { observerDeps: { spawnObserver } }),
      ).rejects.toThrow("Session command requires a subcommand. Use: stn session --help.");
      await expect(
        runCli(["--config", configPath, "session", "create"], {
          observerDeps: { spawnObserver },
        }),
      ).rejects.toThrow("Unknown session command: create. Use: stn session --help.");
      await expect(
        runCli(["--config", configPath, "session", "current", "--json", "later"], {
          observerDeps: { spawnObserver },
        }),
      ).rejects.toThrow(
        "Unexpected argument for stn session current: --json. Use: stn session current --help.",
      );
      expect(spawnObserver).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails with a structured error when process evidence is unavailable", async () => {
    const fixture = await createTempState();
    const getCurrentSessionContext = vi.fn(async () => context);

    try {
      await expect(
        runSessionCommand(
          ["current"],
          {
            config: fixture.config,
            processEvidence: { read: () => undefined },
          },
          runningObserverDeps(fixture.socketPath, getCurrentSessionContext),
        ),
      ).rejects.toMatchObject({
        tag: "SessionCommandError",
        code: "SESSION_CURRENT_PROCESS_EVIDENCE_UNAVAILABLE",
      });
      expect(getCurrentSessionContext).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });
});

function textOutput(result: { output?: unknown }): string {
  expect(typeof result.output).toBe("string");
  return String(result.output);
}

function runningObserverDeps(
  socketPath: string,
  getCurrentSessionContext: (
    caller: TerminalCallerContextRequest,
  ) => Promise<CurrentSessionContext>,
) {
  return {
    clientFactory: (requestedSocketPath: string) =>
      ({
        health: async () => ({
          schemaVersion: "0.11.0",
          status: "healthy",
          pid: 1234,
          startedAt: now,
          version: "0.7.0",
          socketPath: requestedSocketPath,
        }),
        getCurrentSessionContext,
      }) as never,
    sleep: async () => undefined,
    buildVersion: "0.0.0",
    socketPath,
  };
}
