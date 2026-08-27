import type {
  CommandReceipt,
  CommandRecord,
  CurrentSessionContext,
  StationCommand,
  StationSnapshot,
  TerminalCallerContextRequest,
} from "@station/contracts";
import { StationSnapshotSchema } from "@station/contracts";
import type { TerminalCommandRecord } from "@station/protocol";
import { describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";
import { parseSessionArgs } from "../../src/commands/session/args.js";
import { runSessionCommand } from "../../src/commands/session/command.js";
import { sessionCommandExitCode } from "../../src/commands/session/result.js";
import { renderSessionCommandText } from "../../src/commands/session/text.js";

const now = "2026-08-21T12:00:00.000Z";
const observerBuildVersion = `0.0.0-local+station.${"a".repeat(64)}`;
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

type RunCli = typeof import("@station/cli").runCli;

async function runCli(...args: Parameters<RunCli>): ReturnType<RunCli> {
  const cli = await import("@station/cli");
  return cli.runCli(...args);
}

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
    expect(textOutput(parent)).toContain("Discover or operate on one exact current session.");
    expect(textOutput(parent)).toContain("stn session current");
    expect(leaf).toMatchObject({ code: 0, outputFormat: "text" });
    expect(textOutput(leaf)).toContain("Print the verified invoking terminal context as JSON.");
    expect(textOutput(leaf)).toContain("stn session current");
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

describe("session discovery commands", () => {
  it("projects complete Station and external summaries in snapshot order", async () => {
    const fixture = await createTempState();
    const snapshot = sessionSnapshot();

    try {
      const result = await runSessionCommand(
        ["list", "--json"],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [snapshot]),
      );

      expect(result).toMatchObject({
        action: "list",
        filters: {},
        sessions: [
          {
            sessionId: "ses_station",
            origin: "station",
            title: "Web Control",
            projectId: "web",
            projectLabel: "Web App",
            worktreeId: "wt_web",
            worktreeTitle: "Web Control",
            branch: "feature/web-control",
            path: "/tmp/needle-path",
            tags: ["needle-tag", "ordered"],
            harness: {
              provider: "codex",
              mode: "interactive",
              pid: 444,
              runId: "needle-run",
              capabilities: harnessCapabilities(),
            },
            status: {
              value: "working",
              confidence: "high",
              reason: "Agent is editing files.",
              source: "harness_process",
              updatedAt: now,
            },
            terminal: {
              provider: "tmux",
              state: "open",
              focusable: true,
              closeable: true,
              hasWorkspace: true,
              hasPrimaryAgentEndpoint: true,
              confidence: "high",
              reason: "needle-terminal",
              observedAt: now,
            },
          },
          {
            sessionId: "external-run-42",
            origin: "external",
            projectId: "api",
            projectLabel: "API Service",
            worktreeId: "wt_api",
          },
        ],
      });
      const external = structuredResult(result).sessions[1];
      if (external === undefined) throw new Error("Expected the external session summary.");
      expect("terminal" in external).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    [["--project", "web"], ["ses_station"]],
    [["--provider", "claude"], ["external-run-42"]],
    [["--status", "idle"], ["external-run-42"]],
    [["--origin", "external"], ["external-run-42"]],
    [["--query", "API SERVICE"], ["external-run-42"]],
    [["--query", "no-current-match"], []],
  ] as const)("applies list filter %j", async (filterArgs, expectedIds) => {
    const fixture = await createTempState();
    try {
      const result = await runSessionCommand(
        ["list", ...filterArgs],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [sessionSnapshot()]),
      );
      expect(structuredResult(result).sessions.map((session) => session.sessionId)).toEqual(
        expectedIds,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ["SES_STATION", "ses_station"],
    ["WEB CONTROL", "ses_station"],
    ["WEB", "ses_station"],
    ["WEB APP", "ses_station"],
    ["WT_WEB", "ses_station"],
    ["FEATURE/WEB-CONTROL", "ses_station"],
    ["CODEX", "ses_station"],
  ] as const)("searches the documented query field %s", async (query, expectedId) => {
    const fixture = await createTempState();
    try {
      const result = await runSessionCommand(
        ["list", "--query", query],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [sessionSnapshot()]),
      );
      expect(structuredResult(result).sessions.map((session) => session.sessionId)).toContain(
        expectedId,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("combines filters with AND and preserves canonical order", async () => {
    const fixture = await createTempState();
    try {
      const result = await runSessionCommand(
        [
          "list",
          "--project",
          "api",
          "--provider",
          "claude",
          "--status",
          "idle",
          "--origin",
          "external",
          "--query",
          "feature/api-review",
        ],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [sessionSnapshot()]),
      );
      expect(structuredResult(result).sessions.map((session) => session.sessionId)).toEqual([
        "external-run-42",
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    "needle-path",
    "needle-tag",
    "needle-run",
    "needle-terminal",
    "2026-08-21",
  ])("does not search denylisted query field %s", async (query) => {
    const fixture = await createTempState();
    try {
      const result = await runSessionCommand(
        ["list", "--query", query],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [sessionSnapshot()]),
      );
      expect(structuredResult(result).sessions).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("renders terminal-safe text while retaining the structured result", async () => {
    const fixture = await createTempState();
    const snapshot = renamedSnapshot(sessionSnapshot(), "ses_station", "\u001bDanger");

    try {
      const listedArgs = parseSessionArgs(["list"]);
      const jsonArgs = parseSessionArgs(["get", "ses_station", "--json"]);
      const listed = await runSessionCommand(
        listedArgs,
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [snapshot]),
      );
      const json = await runSessionCommand(
        jsonArgs,
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [snapshot]),
      );

      if (listed.action !== "list") throw new Error("Expected a session list result.");
      const text = renderSessionCommandText(listed);
      expect(listedArgs.outputFormat).toBe("text");
      expect(text).toContain("\\u001bDanger");
      expect(text).not.toContain("\u001b");
      expect(jsonArgs.outputFormat).toBe("json");
      expect(json).toMatchObject({
        action: "get",
        session: { sessionId: "ses_station", title: "\u001bDanger" },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("gets only one exact current session ID", async () => {
    const fixture = await createTempState();
    const disallowedSelectors = ["ses_sta", "Web Control", "feature/web-control", "station", "1"];

    try {
      const found = await runSessionCommand(
        ["get", "ses_station"],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [sessionSnapshot()]),
      );
      expect(found).toMatchObject({ action: "get", session: { sessionId: "ses_station" } });

      for (const selector of disallowedSelectors) {
        await expect(
          runSessionCommand(
            ["get", selector],
            { config: fixture.config },
            snapshotObserverDeps(fixture.socketPath, [sessionSnapshot()]),
          ),
        ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND", sessionId: selector });
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects malformed IDs, duplicate filters, and missing values before startup", async () => {
    const fixture = await createTempState();
    const spawnObserver = vi.fn();
    try {
      await expect(
        runSessionCommand(["get", ""], { config: fixture.config }, { spawnObserver }),
      ).rejects.toThrow("Invalid session id");
      await expect(
        runSessionCommand(
          ["list", "--project", "web", "--project", "api"],
          { config: fixture.config },
          { spawnObserver },
        ),
      ).rejects.toThrow("Duplicate session list option: --project");
      await expect(
        runSessionCommand(
          ["list", "--project", "--json"],
          { config: fixture.config },
          { spawnObserver },
        ),
      ).rejects.toThrow("--project requires a value");
      expect(spawnObserver).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("honors --require-running without spawning", async () => {
    const fixture = await createTempState();
    const spawnObserver = vi.fn();
    try {
      await expect(
        runSessionCommand(
          ["list", "--require-running"],
          { config: fixture.config, timeoutMs: 20 },
          {
            spawnObserver,
            clientFactory: () =>
              ({ health: async () => Promise.reject(new Error("not running")) }) as never,
          },
        ),
      ).rejects.toMatchObject({ error: { code: "OBSERVER_NOT_RUNNING" } });
      expect(spawnObserver).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns a structured projection error instead of a partial summary", async () => {
    const fixture = await createTempState();
    const broken = StationSnapshotSchema.parse({
      ...sessionSnapshot(),
      rows: sessionSnapshot().rows.filter((row) => row.id !== "wt_web"),
    });
    try {
      await expect(
        runSessionCommand(
          ["list"],
          { config: fixture.config },
          snapshotObserverDeps(fixture.socketPath, [broken]),
        ),
      ).rejects.toMatchObject({
        code: "SESSION_WORKTREE_RELATIONSHIP_MISSING",
        sessionId: "ses_station",
        projectId: "web",
        worktreeId: "wt_web",
      });
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("session rename and close commands", () => {
  it("projects process correlation only for rename and close mutations", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const initial = sessionSnapshot();
    const cases = [
      {
        args: ["rename", "ses_station", "Correlated title", "--json"],
        commandId: "cmd_correlated_rename",
        command: {
          type: "session.rename",
          payload: { sessionId: "ses_station", title: "Correlated title" },
        } satisfies StationCommand,
        refreshed: renamedSnapshot(initial, "ses_station", "Correlated title"),
      },
      {
        args: ["close", "ses_station", "--mode", "all", "--json"],
        commandId: "cmd_correlated_close",
        command: {
          type: "session.close",
          payload: { sessionId: "ses_station", mode: "all" },
        } satisfies StationCommand,
        refreshed: closedSnapshot(initial, "ses_station"),
      },
    ];

    try {
      for (const testCase of cases) {
        const result = await runCli(["--config", configPath, "session", ...testCase.args], {
          observerDeps: snapshotObserverDeps(fixture.socketPath, [initial, testCase.refreshed], {
            dispatch: async () => acceptedReceipt(testCase.commandId),
            waitForCommand: async () =>
              succeededRecord(testCase.commandId, testCase.command) as TerminalCommandRecord,
          }),
        });

        expect(result).toMatchObject({
          code: 0,
          correlation: {
            status: "succeeded",
            commandId: testCase.commandId,
            traceId: "trc_session",
          },
        });
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("renames through the strict typed command and confirms refreshed identity", async () => {
    const fixture = await createTempState();
    const commandId = "cmd_rename";
    const commands: StationCommand[] = [];
    const initial = sessionSnapshot();
    const refreshed = renamedSnapshot(initial, "ses_station", "Renamed workspace");
    try {
      const result = await runSessionCommand(
        ["rename", "ses_station", "  Renamed workspace  ", "--json", "--timeout-ms", "1000"],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [initial, refreshed], {
          dispatch: async (command) => {
            commands.push(command);
            return acceptedReceipt(commandId);
          },
          waitForCommand: async () =>
            succeededRecord(commandId, firstCommand(commands)) as TerminalCommandRecord,
        }),
      );

      expect(commands).toEqual([
        {
          type: "session.rename",
          payload: { sessionId: "ses_station", title: "Renamed workspace" },
        },
      ]);
      expect(result).toMatchObject({
        action: "rename",
        target: {
          sessionId: "ses_station",
          title: "Web Control",
          branch: "feature/web-control",
          path: "/tmp/needle-path",
        },
        outcome: { status: "succeeded", receipt: { commandId } },
        convergence: {
          status: "confirmed",
          session: {
            state: "present",
            value: {
              title: "Renamed workspace",
              worktreeTitle: "Renamed workspace",
              branch: "feature/web-control",
              path: "/tmp/needle-path",
              harness: { provider: "codex", runId: "needle-run" },
            },
          },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves rejected and failed outcomes without refreshing", async () => {
    const fixture = await createTempState();
    const initial = sessionSnapshot();
    const rejectedSnapshots = vi.fn(async () => initial);
    const failedSnapshots = vi.fn(async () => initial);
    try {
      const rejected = await runSessionCommand(
        ["rename", "ses_station", "Rejected title"],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [], {
          getSnapshot: rejectedSnapshots,
          dispatch: async () => rejectedReceipt("cmd_rejected"),
        }),
      );
      const failedCommand: StationCommand = {
        type: "session.rename",
        payload: { sessionId: "ses_station", title: "Failed title" },
      };
      const failed = await runSessionCommand(
        ["rename", "ses_station", "Failed title"],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [], {
          getSnapshot: failedSnapshots,
          dispatch: async () => acceptedReceipt("cmd_failed"),
          waitForCommand: async () =>
            failedRecord("cmd_failed", failedCommand) as TerminalCommandRecord,
        }),
      );

      expect(rejected).toMatchObject({
        action: "rename",
        outcome: { status: "rejected", receipt: { commandId: "cmd_rejected" } },
      });
      expect(failed).toMatchObject({
        action: "rename",
        outcome: { status: "failed", record: { id: "cmd_failed" } },
      });
      expect(rejectedSnapshots).toHaveBeenCalledTimes(1);
      expect(failedSnapshots).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("correlates a post-dispatch rename timeout", async () => {
    const fixture = await createTempState();
    try {
      await expect(
        runSessionCommand(
          ["rename", "ses_station", "Timed title", "--timeout-ms", "5"],
          { config: fixture.config },
          snapshotObserverDeps(fixture.socketPath, [sessionSnapshot()], {
            dispatch: async () => acceptedReceipt("cmd_timeout"),
            waitForCommand: async () => {
              throw {
                tag: "TimeoutError",
                code: "PROTOCOL_COMMAND_WAIT_TIMEOUT",
                message: "Wait timed out.",
              };
            },
          }),
        ),
      ).rejects.toMatchObject({
        code: "COMMAND_WAIT_TIMEOUT",
        commandId: "cmd_timeout",
        traceId: "trc_session",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns exit-zero convergence warnings after successful rename", async () => {
    const fixture = await createTempState();
    const command: StationCommand = {
      type: "session.rename",
      payload: { sessionId: "ses_station", title: "Expected title" },
    };
    try {
      const result = await runSessionCommand(
        ["rename", "ses_station", "Expected title", "--json"],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [sessionSnapshot(), sessionSnapshot()], {
          dispatch: async () => acceptedReceipt("cmd_stale"),
          waitForCommand: async () =>
            succeededRecord("cmd_stale", command) as TerminalCommandRecord,
        }),
      );
      expect(result).toMatchObject({
        action: "rename",
        outcome: { status: "succeeded" },
        convergence: {
          status: "warning",
          session: { state: "present" },
          warning: { code: "SESSION_RENAME_CONVERGENCE_STALE" },
        },
      });
      expect(sessionCommandExitCode(result)).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns an exit-zero warning when the success refresh fails", async () => {
    const fixture = await createTempState();
    const command: StationCommand = {
      type: "session.rename",
      payload: { sessionId: "ses_station", title: "Expected title" },
    };
    let snapshotQueries = 0;
    try {
      const result = await runSessionCommand(
        ["rename", "ses_station", "Expected title"],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [], {
          getSnapshot: async () => {
            snapshotQueries += 1;
            if (snapshotQueries === 1) return sessionSnapshot();
            throw new Error("refresh unavailable");
          },
          dispatch: async () => acceptedReceipt("cmd_refresh_failed"),
          waitForCommand: async () =>
            succeededRecord("cmd_refresh_failed", command) as TerminalCommandRecord,
        }),
      );

      expect(result).toMatchObject({
        action: "rename",
        outcome: { status: "succeeded" },
        convergence: {
          status: "warning",
          session: { state: "unknown" },
          warning: {
            code: "SNAPSHOT_RPC_FAILED",
            sessionId: "ses_station",
            projectId: "web",
            worktreeId: "wt_web",
          },
        },
      });
      expect(snapshotQueries).toBe(2);
      expect(sessionCommandExitCode(result)).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ["harness", false],
    ["harness", true],
    ["terminal", false],
    ["terminal", true],
    ["all", false],
    ["all", true],
  ] as const)("closes mode %s with force=%s without worktree removal", async (mode, force) => {
    const fixture = await createTempState();
    const commands: StationCommand[] = [];
    const initial = sessionSnapshot();
    const refreshed = closedSnapshot(initial, "ses_station");
    try {
      const args = ["close", "ses_station", "--mode", mode];
      if (force) args.push("--force");
      const result = await runSessionCommand(
        args,
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [initial, refreshed], {
          dispatch: async (command) => {
            commands.push(command);
            return acceptedReceipt(`cmd_close_${mode}_${force}`);
          },
          waitForCommand: async () =>
            succeededRecord(
              `cmd_close_${mode}_${force}`,
              firstCommand(commands),
            ) as TerminalCommandRecord,
        }),
      );

      const expectedPayload: { sessionId: string; mode: typeof mode; force?: true } = {
        sessionId: "ses_station",
        mode,
      };
      if (force) expectedPayload.force = true;
      expect(commands).toEqual([{ type: "session.close", payload: expectedPayload }]);
      expect(commands.every((command) => command.type !== "worktree.remove")).toBe(true);
      expect(result).toMatchObject({
        action: "close",
        outcome: { status: "succeeded" },
        convergence: {
          status: "confirmed",
          session: { state: "missing" },
          worktree: {
            state: "present",
            value: {
              worktreeId: "wt_web",
              branch: "feature/web-control",
              path: "/tmp/needle-path",
            },
          },
        },
      });
      if (!force) expect("force" in firstCommand(commands).payload).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("confirms a still-present stopped harness and retained worktree after close", async () => {
    const fixture = await createTempState();
    const command: StationCommand = {
      type: "session.close",
      payload: { sessionId: "ses_station", mode: "harness" },
    };
    const refreshed = sessionStatusSnapshot(sessionSnapshot(), "ses_station", "exited");
    try {
      const result = await runSessionCommand(
        ["close", "ses_station", "--mode", "harness"],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [sessionSnapshot(), refreshed], {
          dispatch: async () => acceptedReceipt("cmd_close_present"),
          waitForCommand: async () =>
            succeededRecord("cmd_close_present", command) as TerminalCommandRecord,
        }),
      );
      expect(result).toMatchObject({
        action: "close",
        convergence: {
          status: "confirmed",
          session: {
            state: "present",
            value: { sessionId: "ses_station", status: { value: "exited" } },
          },
          worktree: { state: "present", value: { worktreeId: "wt_web" } },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("warns when close harness still projects the run as active", async () => {
    const fixture = await createTempState();
    const command: StationCommand = {
      type: "session.close",
      payload: { sessionId: "ses_station", mode: "harness" },
    };
    try {
      const result = await runSessionCommand(
        ["close", "ses_station", "--mode", "harness"],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [sessionSnapshot(), sessionSnapshot()], {
          dispatch: async () => acceptedReceipt("cmd_close_stale_harness"),
          waitForCommand: async () =>
            succeededRecord("cmd_close_stale_harness", command) as TerminalCommandRecord,
        }),
      );
      expect(result).toMatchObject({
        action: "close",
        convergence: {
          status: "warning",
          session: {
            state: "present",
            value: { sessionId: "ses_station", status: { value: "working" } },
          },
          worktree: { state: "present", value: { worktreeId: "wt_web" } },
          warning: { code: "SESSION_CLOSE_CONVERGENCE_STALE" },
        },
      });
      expect(sessionCommandExitCode(result)).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("warns when a successful close cannot prove worktree retention", async () => {
    const fixture = await createTempState();
    const command: StationCommand = {
      type: "session.close",
      payload: { sessionId: "ses_station", mode: "all" },
    };
    const missingWorktree = StationSnapshotSchema.parse({
      ...closedSnapshot(sessionSnapshot(), "ses_station"),
      rows: sessionSnapshot().rows.filter((row) => row.id !== "wt_web"),
    });
    try {
      const result = await runSessionCommand(
        ["close", "ses_station", "--mode", "all"],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [sessionSnapshot(), missingWorktree], {
          dispatch: async () => acceptedReceipt("cmd_close_warning"),
          waitForCommand: async () =>
            succeededRecord("cmd_close_warning", command) as TerminalCommandRecord,
        }),
      );
      expect(result).toMatchObject({
        action: "close",
        convergence: {
          status: "warning",
          session: { state: "unknown" },
          worktree: { state: "missing" },
          warning: { code: "SESSION_CLOSE_WORKTREE_MISSING" },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects missing or invalid close mode before startup", async () => {
    const fixture = await createTempState();
    const spawnObserver = vi.fn();
    try {
      await expect(
        runSessionCommand(["close", "ses_station"], { config: fixture.config }, { spawnObserver }),
      ).rejects.toThrow("requires --mode");
      await expect(
        runSessionCommand(
          ["close", "ses_station", "--mode", "delete"],
          { config: fixture.config },
          { spawnObserver },
        ),
      ).rejects.toThrow("--mode must be harness, terminal, or all");
      await expect(
        runSessionCommand(
          ["close", "ses_station", "--all"],
          { config: fixture.config },
          { spawnObserver },
        ),
      ).rejects.toThrow("Unknown session close option: --all");
      expect(spawnObserver).not.toHaveBeenCalled();
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
          version: observerBuildVersion,
          socketPath: requestedSocketPath,
        }),
        getCurrentSessionContext,
      }) as never,
    sleep: async () => undefined,
    buildVersion: observerBuildVersion,
    socketPath,
  };
}

function structuredResult(
  result: Awaited<ReturnType<typeof runSessionCommand>>,
): Extract<Awaited<ReturnType<typeof runSessionCommand>>, { action: "list" }> {
  if (!("action" in result) || result.action !== "list") {
    throw new Error("Expected a session list result.");
  }
  return result;
}

function firstCommand(commands: readonly StationCommand[]): StationCommand {
  const command = commands[0];
  if (command === undefined) throw new Error("Expected one dispatched command.");
  return command;
}

function snapshotObserverDeps(
  socketPath: string,
  snapshots: readonly StationSnapshot[],
  options: {
    getSnapshot?: () => Promise<StationSnapshot>;
    dispatch?: (command: StationCommand) => Promise<CommandReceipt>;
    waitForCommand?: (commandId: string) => Promise<TerminalCommandRecord>;
  } = {},
) {
  let snapshotIndex = 0;
  let lastCommand: StationCommand | undefined;
  return {
    buildVersion: observerBuildVersion,
    clientFactory: (requestedSocketPath: string) =>
      ({
        health: async () => ({
          schemaVersion: "0.11.0",
          status: "healthy",
          pid: 1234,
          startedAt: now,
          version: observerBuildVersion,
          socketPath: requestedSocketPath,
        }),
        getSnapshot:
          options.getSnapshot ??
          (async () => {
            const snapshot = snapshots[snapshotIndex] ?? snapshots.at(-1);
            snapshotIndex += 1;
            if (snapshot === undefined) throw new Error("No snapshot fixture is available.");
            return snapshot;
          }),
        dispatch: async (command: StationCommand) => {
          lastCommand = command;
          return options.dispatch?.(command) ?? acceptedReceipt("cmd_default");
        },
        waitForCommand:
          options.waitForCommand ??
          (async (commandId: string) => {
            if (lastCommand === undefined) throw new Error("No command was dispatched.");
            return succeededRecord(commandId, lastCommand) as TerminalCommandRecord;
          }),
      }) as never,
    sleep: async () => undefined,
    socketPath,
  };
}

function acceptedReceipt(commandId: string): CommandReceipt {
  return {
    commandId,
    traceId: "trc_session",
    spanId: "spn_session",
    accepted: true,
    status: "accepted",
  };
}

function rejectedReceipt(commandId: string): CommandReceipt {
  return {
    commandId,
    traceId: "trc_session",
    spanId: "spn_session",
    accepted: false,
    status: "rejected",
    error: {
      tag: "CommandRejectedError",
      code: "SESSION_COMMAND_REJECTED",
      message: "The session command was rejected.",
    },
  };
}

function succeededRecord(id: string, command: StationCommand): CommandRecord {
  return {
    id,
    type: command.type,
    command,
    status: "succeeded",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    traceId: "trc_session",
    spanId: "spn_session",
  } as CommandRecord;
}

function failedRecord(id: string, command: StationCommand): CommandRecord {
  return {
    id,
    type: command.type,
    command,
    status: "failed",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    traceId: "trc_session",
    spanId: "spn_session",
    error: {
      tag: "SessionCommandError",
      code: "SESSION_COMMAND_FAILED",
      message: "The session command failed.",
    },
  } as CommandRecord;
}

function harnessCapabilities() {
  return {
    canLaunch: true,
    canDiscoverRuns: true,
    canEmitEvents: true,
    canReceivePrompt: true,
    canResume: true,
    canStop: true,
    canRunNonInteractive: true,
    canExposeApprovalState: true,
    supportsModifiedEnterSoftNewline: false,
  };
}

function sessionSnapshot(): StationSnapshot {
  return StationSnapshotSchema.parse({
    schemaVersion: "0.11.0",
    generatedAt: now,
    observer: { pid: 1234, startedAt: now, version: "0.0.0", healthy: true },
    providerHealth: {},
    projects: [
      {
        id: "web",
        label: "Web App",
        root: "/projects/web",
        defaults: { harness: "codex", terminal: "tmux", layout: "agent-build-shell" },
        health: {
          providerId: "worktrunk",
          providerType: "worktree",
          status: "healthy",
          lastCheckedAt: now,
        },
        counts: {
          sessions: 1,
          worktrees: 1,
          agents: 1,
          working: 1,
          idle: 0,
          attention: 0,
          unknown: 0,
        },
      },
      {
        id: "api",
        label: "API Service",
        root: "/projects/api",
        defaults: { harness: "claude", terminal: "tmux", layout: "agent-build-shell" },
        health: {
          providerId: "worktrunk",
          providerType: "worktree",
          status: "healthy",
          lastCheckedAt: now,
        },
        counts: {
          sessions: 1,
          worktrees: 1,
          agents: 1,
          working: 0,
          idle: 1,
          attention: 0,
          unknown: 0,
        },
      },
    ],
    rows: [
      {
        id: "wt_web",
        projectId: "web",
        projectLabel: "Web App",
        title: "Web Control",
        branch: "feature/web-control",
        path: "/tmp/needle-path",
        registrationIdentity: "registration-web",
        worktree: { state: "exists", source: "worktrunk" },
        terminal: {
          provider: "tmux",
          state: "open",
          focusable: true,
          closeable: true,
          hasWorkspace: true,
          hasPrimaryAgentEndpoint: true,
          confidence: "high",
          reason: "needle-terminal",
          observedAt: now,
        },
        display: { statusLabel: "working", sortPriority: 10, alert: false },
      },
      {
        id: "wt_api",
        projectId: "api",
        projectLabel: "API Service",
        title: "API Review",
        branch: "feature/api-review",
        path: "/projects/api/review",
        registrationIdentity: "registration-api",
        worktree: { state: "exists", source: "worktrunk" },
        display: { statusLabel: "idle", sortPriority: 20, alert: false },
      },
    ],
    sessions: [
      {
        id: "ses_station",
        origin: "station",
        projectId: "web",
        worktreeId: "wt_web",
        createdAt: now,
        updatedAt: now,
        harness: {
          provider: "codex",
          mode: "interactive",
          pid: 444,
          runId: "needle-run",
          capabilities: harnessCapabilities(),
        },
        terminal: {
          provider: "tmux",
          state: "open",
          focusable: true,
          closeable: true,
          hasWorkspace: true,
          hasPrimaryAgentEndpoint: true,
          confidence: "high",
          reason: "needle-terminal",
          observedAt: now,
        },
        status: {
          value: "working",
          confidence: "high",
          reason: "Agent is editing files.",
          source: "harness_process",
          updatedAt: now,
        },
        title: "Web Control",
        tags: ["needle-tag", "ordered"],
      },
      {
        id: "external-run-42",
        origin: "external",
        projectId: "api",
        worktreeId: "wt_api",
        createdAt: now,
        updatedAt: now,
        harness: {
          provider: "claude",
          mode: "unknown",
          capabilities: harnessCapabilities(),
        },
        status: {
          value: "idle",
          confidence: "medium",
          reason: "External run is waiting.",
          source: "harness_event",
          updatedAt: now,
        },
        title: "API Review",
        tags: [],
      },
    ],
    sessionGroups: [],
    counts: {
      projects: 2,
      sessions: 2,
      worktrees: 2,
      agents: 2,
      working: 1,
      idle: 1,
      attention: 0,
      unknown: 0,
    },
    alerts: [],
  });
}

function renamedSnapshot(
  snapshot: StationSnapshot,
  sessionId: string,
  title: string,
): StationSnapshot {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error("Session fixture is missing.");
  return StationSnapshotSchema.parse({
    ...snapshot,
    rows: snapshot.rows.map((row) =>
      row.projectId === session.projectId && row.id === session.worktreeId
        ? { ...row, title }
        : row,
    ),
    sessions: snapshot.sessions.map((candidate) =>
      candidate.id === sessionId ? { ...candidate, title } : candidate,
    ),
  });
}

function closedSnapshot(snapshot: StationSnapshot, sessionId: string): StationSnapshot {
  return StationSnapshotSchema.parse({
    ...snapshot,
    sessions: snapshot.sessions.filter((session) => session.id !== sessionId),
  });
}

function sessionStatusSnapshot(
  snapshot: StationSnapshot,
  sessionId: string,
  value: StationSnapshot["sessions"][number]["status"]["value"],
): StationSnapshot {
  return StationSnapshotSchema.parse({
    ...snapshot,
    sessions: snapshot.sessions.map((session) =>
      session.id === sessionId ? { ...session, status: { ...session.status, value } } : session,
    ),
  });
}
