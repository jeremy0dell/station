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

  it("renders help without loading config or starting Observer", async () => {
    const spawnObserver = vi.fn();

    const result = await runCli(["session", "current", "--help"], {
      observerDeps: { spawnObserver },
    });

    expect(result).toMatchObject({ code: 0, outputFormat: "text" });
    expect(result.output).toContain("stn session current");
    expect(spawnObserver).not.toHaveBeenCalled();
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
