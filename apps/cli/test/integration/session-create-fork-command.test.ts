import type {
  CommandReceipt,
  CommandRecord,
  CurrentSessionContext,
  SessionCreateCommandResult,
  SessionForkCommandResult,
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
import { defaultStdinMaxBytes } from "../../src/stdin.js";

const now = "2026-08-27T12:00:00.000Z";
const observerBuildVersion = `0.0.0-local+station.${"a".repeat(64)}`;
const promptSecret = "PROMPT_SECRET_do_not_echo\nKeep this formatting.\n";
const currentContext: CurrentSessionContext = {
  source: {
    provider: "tmux",
    targetId: "tmux:caller:$9:@8:%7",
    generation: "caller-generation",
    authorityId: "caller-authority",
    expiresAt: "2026-08-27T12:10:00.000Z",
  },
  presentation: "presented",
  session: {
    id: "ses_other_caller",
    projectId: "other",
    worktreeId: "wt_other_caller",
  },
};

type RunCli = typeof import("@station/cli").runCli;

async function runCli(...args: Parameters<RunCli>): ReturnType<RunCli> {
  const cli = await import("@station/cli");
  return cli.runCli(...args);
}

describe("session create and fork commands", () => {
  it("creates detached with exact options, safe output, durable identities, and no focus", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const initial = creationSnapshot();
    const commands: StationCommand[] = [];
    const result = detachedCreateResult("group_root");
    try {
      const cliResult = await runCli(
        [
          "--config",
          configPath,
          "session",
          "create",
          "web",
          "--branch",
          "feature/new-cli",
          "--terminal",
          "tmux",
          "--title",
          "  CLI review  ",
          "--base",
          "main",
          "--harness",
          "claude",
          "--layout",
          "agent-only",
          "--group",
          "group_root",
          "--prompt-stdin",
          "--json",
        ],
        {
          stdin: promptSecret,
          observerDeps: creationObserverDeps(fixture.socketPath, [initial], {
            getSnapshot: creationSnapshotSequence(initial, commands, result),
            dispatch: async (command) => {
              commands.push(command);
              return acceptedReceipt("cmd_create");
            },
            waitForCommand: async () =>
              succeededRecord("cmd_create", firstCommand(commands), result),
          }),
        },
      );

      expect(commands).toEqual([
        {
          type: "session.create",
          payload: {
            projectId: "web",
            branch: "feature/new-cli",
            title: "CLI review",
            base: "main",
            harness: { provider: "claude" },
            terminal: { provider: "tmux", layout: "agent-only" },
            placement: { intent: "detached" },
            group: { kind: "existing", groupId: "group_root" },
            initialPrompt: promptSecret,
          },
        },
      ]);
      expect("focus" in firstCommand(commands).payload.terminal).toBe(false);
      expect(cliResult).toMatchObject({
        code: 0,
        correlation: { status: "succeeded", commandId: "cmd_create", traceId: "trc_creation" },
        output: {
          action: "create",
          outcome: {
            status: "succeeded",
            receipt: { commandId: "cmd_create" },
            result,
          },
          convergence: { status: "confirmed", session: { state: "present" } },
        },
      });
      expect(JSON.stringify(cliResult)).not.toContain(promptSecret.trim());
      expect(JSON.stringify(cliResult)).not.toContain("initialPrompt");
      expect(JSON.stringify(cliResult.output)).not.toContain("/projects/web/");
      expect(JSON.stringify(cliResult.output)).not.toContain("The created harness is starting.");
      const text = renderSessionCommandText(cliResult.output as never);
      expect(text).not.toContain("/projects/web/");
      expect(text).not.toContain("The created harness is starting.");
      expect(text).not.toContain("CLI review");
    } finally {
      await fixture.cleanup();
    }
  });

  it("forks beside fresh caller authority while keeping code source, harness, and Group exact", async () => {
    const fixture = await createTempState();
    const initial = creationSnapshot();
    const commands: StationCommand[] = [];
    const result = siblingForkResult();
    const callers: TerminalCallerContextRequest[] = [];
    try {
      const commandResult = await runSessionCommand(
        ["fork", "ses_source", "--branch", "feature/forked", "--from-current"],
        {
          config: fixture.config,
          caller: () => ({
            process: { pid: 901, startToken: "caller-process" },
            claims: { TMUX_PANE: "%7" },
          }),
        },
        creationObserverDeps(fixture.socketPath, [initial], {
          getSnapshot: creationSnapshotSequence(initial, commands, result),
          getCurrentSessionContext: async (caller) => {
            callers.push(caller);
            return currentContext;
          },
          dispatch: async (command) => {
            commands.push(command);
            return acceptedReceipt("cmd_fork");
          },
          waitForCommand: async () => succeededRecord("cmd_fork", firstCommand(commands), result),
        }),
      );

      expect(callers).toEqual([
        { process: { pid: 901, startToken: "caller-process" }, claims: { TMUX_PANE: "%7" } },
      ]);
      expect(commands).toEqual([
        {
          type: "session.fork",
          payload: {
            projectId: "web",
            sourceWorktreeId: "wt_source",
            branch: "feature/forked",
            harness: { provider: "codex" },
            terminal: { provider: "tmux" },
            placement: { intent: "sibling", source: currentContext.source },
            group: {
              kind: "source",
              sourceSessionId: "ses_source",
              groupId: "group_source",
            },
          },
        },
      ]);
      const command = firstCommand(commands);
      expect(command.type).toBe("session.fork");
      if (command.type !== "session.fork") throw new Error("Expected session.fork.");
      expect("copyDirty" in command.payload).toBe(false);
      expect("base" in command.payload).toBe(false);
      expect("layout" in command.payload.terminal).toBe(false);
      expect(commandResult).toMatchObject({
        action: "fork",
        outcome: { status: "succeeded", result },
        convergence: { status: "confirmed" },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("confirms fork inheritance against the Observer's transaction-resolved Group", async () => {
    const fixture = await createTempState();
    const initial = creationSnapshot();
    const commands: StationCommand[] = [];
    const result = siblingForkResult("group_transaction");
    try {
      const commandResult = await runSessionCommand(
        ["fork", "ses_source", "--branch", "feature/moved-group", "--from-current"],
        { config: fixture.config },
        creationObserverDeps(fixture.socketPath, [], {
          getSnapshot: creationSnapshotSequence(initial, commands, result),
          dispatch: async (command) => {
            commands.push(command);
            return acceptedReceipt("cmd_moved_group");
          },
          waitForCommand: async () =>
            succeededRecord("cmd_moved_group", firstCommand(commands), result),
        }),
      );

      const command = firstCommand(commands);
      if (command.type !== "session.fork") throw new Error("Expected session.fork.");
      expect(command.payload.group).toMatchObject({ groupId: "group_source" });
      expect(commandResult).toMatchObject({
        outcome: { status: "succeeded", result: { resolvedGroupId: "group_transaction" } },
        convergence: { status: "confirmed", session: { state: "present" } },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("warns when a duplicate-named Group does not match the durable resolved Group", async () => {
    const fixture = await createTempState();
    const initial = creationSnapshot();
    const commands: StationCommand[] = [];
    const result = detachedCreateResult("group_inline");
    let snapshotCalls = 0;
    try {
      const commandResult = await runSessionCommand(
        [
          "create",
          "web",
          "--branch",
          "feature/duplicate-group",
          "--terminal",
          "tmux",
          "--new-group",
          "Duplicate",
        ],
        { config: fixture.config },
        creationObserverDeps(fixture.socketPath, [], {
          getSnapshot: async () => {
            snapshotCalls += 1;
            if (snapshotCalls === 1) return initial;
            const refreshed = createdSnapshot(initial, commands, result);
            return StationSnapshotSchema.parse({
              ...refreshed,
              sessionGroups: [
                ...refreshed.sessionGroups.map((group) =>
                  group.id === "group_inline" ? { ...group, sessionIds: [] } : group,
                ),
                {
                  id: "group_duplicate",
                  projectId: "web",
                  name: "Duplicate",
                  sessionIds: [result.sessionId],
                  version: 1,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            });
          },
          dispatch: async (command) => {
            commands.push(command);
            return acceptedReceipt("cmd_duplicate_group");
          },
          waitForCommand: async () =>
            succeededRecord("cmd_duplicate_group", firstCommand(commands), result),
        }),
      );

      expect(commandResult).toMatchObject({
        outcome: { status: "succeeded", result: { resolvedGroupId: "group_inline" } },
        convergence: {
          status: "warning",
          session: { state: "present" },
          warning: { code: "SESSION_CREATE_CONVERGENCE_STALE" },
        },
      });
      expect(sessionCommandExitCode(commandResult)).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves copy-dirty tri-state and supports an explicit Ungrouped fork", async () => {
    const fixture = await createTempState();
    const cases = [
      { flags: [] as string[], expected: undefined },
      { flags: ["--copy-dirty"], expected: true },
      { flags: ["--no-copy-dirty", "--ungrouped"], expected: false },
    ];
    try {
      for (const [index, testCase] of cases.entries()) {
        const commands: StationCommand[] = [];
        const result = await runSessionCommand(
          [
            "fork",
            "ses_source",
            "--branch",
            `feature/tri-state-${index}`,
            "--terminal",
            "tmux",
            ...testCase.flags,
          ],
          { config: fixture.config },
          creationObserverDeps(fixture.socketPath, [creationSnapshot()], {
            dispatch: async (command) => {
              commands.push(command);
              return rejectedReceipt(`cmd_tri_${index}`);
            },
          }),
        );
        const command = firstCommand(commands);
        if (command.type !== "session.fork") throw new Error("Expected session.fork.");
        expect(command.payload.copyDirty).toBe(testCase.expected);
        expect("copyDirty" in command.payload).toBe(testCase.expected !== undefined);
        expect("group" in command.payload).toBe(!testCase.flags.includes("--ungrouped"));
        expect(sessionCommandExitCode(result)).toBe(1);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("maps inline and explicit Ungrouped create intent without inferring placement", async () => {
    const fixture = await createTempState();
    const cases = [
      {
        flags: ["--new-group", "CLI Group"],
        expectedGroup: { kind: "create", name: "CLI Group" },
      },
      { flags: ["--ungrouped"], expectedGroup: undefined },
      { flags: [] as string[], expectedGroup: undefined },
    ];
    try {
      for (const [index, testCase] of cases.entries()) {
        const commands: StationCommand[] = [];
        await runSessionCommand(
          [
            "create",
            "web",
            "--branch",
            `feature/group-${index}`,
            "--terminal",
            "tmux",
            ...testCase.flags,
          ],
          { config: fixture.config },
          creationObserverDeps(fixture.socketPath, [creationSnapshot()], {
            dispatch: async (command) => {
              commands.push(command);
              return rejectedReceipt(`cmd_group_${index}`);
            },
          }),
        );
        const command = firstCommand(commands);
        if (command.type !== "session.create") throw new Error("Expected session.create.");
        expect(command.payload.group).toEqual(testCase.expectedGroup);
        expect("group" in command.payload).toBe(testCase.expectedGroup !== undefined);
        expect(command.payload.placement).toEqual({ intent: "detached" });
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects invalid placement, Group, copy, terminal, and layout grammar before startup", () => {
    expect(() => parseSessionArgs(["create", "web", "--branch", "feature/x"])).toThrow(
      "requires --from-current or --terminal tmux",
    );
    expect(() =>
      parseSessionArgs([
        "create",
        "web",
        "--branch",
        "feature/x",
        "--from-current",
        "--terminal",
        "tmux",
      ]),
    ).toThrow("Placement options conflict");
    expect(() =>
      parseSessionArgs(["create", "web", "--branch", "feature/x", "--terminal", "native"]),
    ).toThrow("--terminal must be tmux");
    expect(() =>
      parseSessionArgs([
        "create",
        "web",
        "--branch",
        "feature/x",
        "--terminal",
        "tmux",
        "--group",
        "group_root",
        "--ungrouped",
      ]),
    ).toThrow("Group options conflict");
    expect(() =>
      parseSessionArgs([
        "fork",
        "ses_source",
        "--branch",
        "feature/x",
        "--terminal",
        "tmux",
        "--copy-dirty",
        "--no-copy-dirty",
      ]),
    ).toThrow("Copy-dirty options conflict");
    expect(() =>
      parseSessionArgs([
        "fork",
        "ses_source",
        "--branch",
        "feature/x",
        "--terminal",
        "tmux",
        "--layout",
        "provider-dsl",
      ]),
    ).toThrow("--layout must be default, agent-only, or agent-build-shell");
    expect(() =>
      parseSessionArgs([
        "create",
        "web",
        "--branch",
        "feature/x",
        "--terminal",
        "tmux",
        "--title",
        "   ",
      ]),
    ).toThrow("--title requires a non-empty title");
    expect(
      parseSessionArgs([
        "create",
        "web",
        "--branch",
        "feature/x",
        "--terminal",
        "tmux",
        "--title",
        "  Normalized  ",
      ]),
    ).toMatchObject({ title: "Normalized" });
  });

  it("rejects empty, oversized, or missing prompt stdin before Observer startup", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const spawnObserver = vi.fn();
    try {
      await expect(
        runSessionCommand(
          ["create", "web", "--branch", "feature/prompt", "--terminal", "tmux", "--prompt-stdin"],
          { config: fixture.config },
          { spawnObserver },
        ),
      ).rejects.toMatchObject({ code: "CLI_SESSION_PROMPT_STDIN_REQUIRED" });
      await expect(
        runSessionCommand(
          ["create", "web", "--branch", "feature/title", "--terminal", "tmux", "--title", "   "],
          { config: fixture.config },
          { spawnObserver },
        ),
      ).rejects.toMatchObject({ code: "CLI_SESSION_CREATE_INPUT_INVALID" });
      for (const stdin of ["", " \n\t"]) {
        await expect(
          runCli(
            [
              "--config",
              configPath,
              "session",
              "create",
              "web",
              "--branch",
              "feature/prompt",
              "--terminal",
              "tmux",
              "--prompt-stdin",
            ],
            { stdin, observerDeps: { spawnObserver } },
          ),
        ).rejects.toMatchObject({ code: "CLI_SESSION_PROMPT_STDIN_REQUIRED" });
      }
      await expect(
        runCli(
          [
            "--config",
            configPath,
            "session",
            "create",
            "web",
            "--branch",
            "feature/prompt",
            "--terminal",
            "tmux",
            "--prompt-stdin",
          ],
          { stdin: "x".repeat(defaultStdinMaxBytes + 1), observerDeps: { spawnObserver } },
        ),
      ).rejects.toMatchObject({ code: "CLI_SESSION_PROMPT_STDIN_TOO_LARGE" });
      expect(spawnObserver).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects invalid Groups but treats cached provider health as advisory", async () => {
    const fixture = await createTempState();
    const dispatch = vi.fn(async () => rejectedReceipt("cmd_cached_health"));
    try {
      await expect(
        runSessionCommand(
          [
            "create",
            "web",
            "--branch",
            "feature/nested",
            "--terminal",
            "tmux",
            "--group",
            "group_nested",
          ],
          { config: fixture.config },
          creationObserverDeps(fixture.socketPath, [creationSnapshot()], { dispatch }),
        ),
      ).rejects.toMatchObject({ code: "SESSION_CREATE_GROUP_NOT_ROOT" });
      await expect(
        runSessionCommand(
          [
            "fork",
            "ses_ungrouped",
            "--branch",
            "feature/no-group",
            "--terminal",
            "tmux",
            "--inherit-group",
          ],
          { config: fixture.config },
          creationObserverDeps(fixture.socketPath, [creationSnapshot()], { dispatch }),
        ),
      ).rejects.toMatchObject({ code: "SESSION_FORK_SOURCE_GROUP_MISSING" });
      const unavailable = StationSnapshotSchema.parse({
        ...creationSnapshot(),
        projects: creationSnapshot().projects.map((project) => ({
          ...project,
          health: { ...project.health, status: "unavailable" },
        })),
        providerHealth: {
          ...creationSnapshot().providerHealth,
          tmux: {
            ...creationSnapshot().providerHealth.tmux,
            status: "unavailable",
          },
          codex: {
            ...creationSnapshot().providerHealth.codex,
            status: "unavailable",
          },
        },
      });
      const result = await runSessionCommand(
        ["create", "web", "--branch", "feature/recovered", "--terminal", "tmux"],
        { config: fixture.config },
        creationObserverDeps(fixture.socketPath, [unavailable], { dispatch }),
      );
      expect(result).toMatchObject({ action: "create", outcome: { status: "rejected" } });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("requires supported fresh current authority and never resolves it for detached placement", async () => {
    const fixture = await createTempState();
    const dispatch = vi.fn(async () => rejectedReceipt("cmd_detached"));
    const detachedCurrent = vi.fn(async () => {
      throw new Error("detached placement must not inspect current context");
    });
    try {
      await runSessionCommand(
        ["create", "web", "--branch", "feature/detached", "--terminal", "tmux"],
        { config: fixture.config },
        creationObserverDeps(fixture.socketPath, [creationSnapshot()], {
          dispatch,
          getCurrentSessionContext: detachedCurrent,
        }),
      );
      expect(detachedCurrent).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledTimes(1);

      const unsupportedCurrent = vi.fn(async () => ({
        ...currentContext,
        source: { ...currentContext.source, provider: "native" },
      }));
      await expect(
        runSessionCommand(
          ["create", "web", "--branch", "feature/unsupported", "--from-current"],
          { config: fixture.config },
          creationObserverDeps(fixture.socketPath, [creationSnapshot()], {
            dispatch,
            getCurrentSessionContext: unsupportedCurrent,
          }),
        ),
      ).rejects.toMatchObject({ code: "SESSION_CURRENT_TERMINAL_UNSUPPORTED" });

      const staleCurrent = vi.fn(async () => {
        throw {
          tag: "TerminalPlacementError",
          code: "TERMINAL_PLACEMENT_AUTHORITY_EXPIRED",
          message: "The current placement authority expired.",
        };
      });
      await expect(
        runSessionCommand(
          ["create", "web", "--branch", "feature/stale", "--from-current"],
          { config: fixture.config },
          creationObserverDeps(fixture.socketPath, [creationSnapshot()], {
            dispatch,
            getCurrentSessionContext: staleCurrent,
          }),
        ),
      ).rejects.toMatchObject({
        code: "TERMINAL_PLACEMENT_AUTHORITY_EXPIRED",
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps rejected and failed outcomes prompt-safe and skips success refresh", async () => {
    const fixture = await createTempState();
    const initial = creationSnapshot();
    const snapshots = vi.fn(async () => initial);
    const failedCommands: StationCommand[] = [];
    try {
      const rejected = await runSessionCommand(
        ["create", "web", "--branch", "feature/rejected", "--terminal", "tmux"],
        { config: fixture.config },
        creationObserverDeps(fixture.socketPath, [], {
          getSnapshot: snapshots,
          dispatch: async () => rejectedReceipt("cmd_rejected"),
        }),
      );
      const failed = await runSessionCommand(
        ["create", "web", "--branch", "feature/failed", "--terminal", "tmux", "--prompt-stdin"],
        { config: fixture.config, initialPrompt: promptSecret },
        creationObserverDeps(fixture.socketPath, [], {
          getSnapshot: snapshots,
          dispatch: async (command) => {
            failedCommands.push(command);
            return acceptedReceipt("cmd_failed");
          },
          waitForCommand: async () => failedRecord("cmd_failed", firstCommand(failedCommands)),
        }),
      );

      expect(rejected).toMatchObject({ action: "create", outcome: { status: "rejected" } });
      expect(failed).toMatchObject({
        action: "create",
        outcome: {
          status: "failed",
          completion: {
            commandId: "cmd_failed",
            error: { code: "SESSION_COMMAND_FAILED" },
          },
        },
      });
      expect(JSON.stringify(failed)).not.toContain(promptSecret.trim());
      expect(snapshots).toHaveBeenCalledTimes(2);
      expect(sessionCommandExitCode(rejected)).toBe(1);
      expect(sessionCommandExitCode(failed)).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects missing or conflicting durable results with command correlation", async () => {
    const fixture = await createTempState();
    const commands: StationCommand[] = [];
    try {
      await expect(
        runSessionCommand(
          ["create", "web", "--branch", "feature/missing", "--terminal", "tmux"],
          { config: fixture.config },
          creationObserverDeps(fixture.socketPath, [creationSnapshot()], {
            dispatch: async (command) => {
              commands.push(command);
              return acceptedReceipt("cmd_missing_result");
            },
            waitForCommand: async () =>
              succeededRecord("cmd_missing_result", firstCommand(commands)),
          }),
        ),
      ).rejects.toMatchObject({
        code: "SESSION_CREATE_RESULT_MISSING",
        commandId: "cmd_missing_result",
        traceId: "trc_creation",
      });
      commands.length = 0;
      await expect(
        runSessionCommand(
          ["create", "web", "--branch", "feature/mismatch", "--terminal", "tmux"],
          { config: fixture.config },
          creationObserverDeps(fixture.socketPath, [creationSnapshot()], {
            dispatch: async (command) => {
              commands.push(command);
              return acceptedReceipt("cmd_mismatch_result");
            },
            waitForCommand: async () =>
              succeededRecord("cmd_mismatch_result", firstCommand(commands), {
                ...detachedCreateResult(),
                projectId: "other",
              }),
          }),
        ),
      ).rejects.toMatchObject({
        code: "SESSION_CREATE_RESULT_MISMATCH",
        commandId: "cmd_mismatch_result",
      });
      commands.length = 0;
      await expect(
        runSessionCommand(
          [
            "create",
            "web",
            "--branch",
            "feature/group-mismatch",
            "--terminal",
            "tmux",
            "--group",
            "group_root",
          ],
          { config: fixture.config },
          creationObserverDeps(fixture.socketPath, [creationSnapshot()], {
            dispatch: async (command) => {
              commands.push(command);
              return acceptedReceipt("cmd_group_mismatch");
            },
            waitForCommand: async () =>
              succeededRecord(
                "cmd_group_mismatch",
                firstCommand(commands),
                detachedCreateResult("group_source"),
              ),
          }),
        ),
      ).rejects.toMatchObject({
        code: "SESSION_CREATE_RESULT_MISMATCH",
        commandId: "cmd_group_mismatch",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves correlated timeouts and returns exit-zero convergence warnings", async () => {
    const fixture = await createTempState();
    const commands: StationCommand[] = [];
    try {
      await expect(
        runSessionCommand(
          [
            "create",
            "web",
            "--branch",
            "feature/timeout",
            "--terminal",
            "tmux",
            "--timeout-ms",
            "5",
          ],
          { config: fixture.config },
          creationObserverDeps(fixture.socketPath, [creationSnapshot()], {
            dispatch: async (command) => {
              commands.push(command);
              return acceptedReceipt("cmd_timeout");
            },
            waitForCommand: async () => {
              throw { tag: "TimeoutError", code: "WAIT_TIMEOUT", message: "Timed out." };
            },
          }),
        ),
      ).rejects.toMatchObject({
        code: "COMMAND_WAIT_TIMEOUT",
        commandId: "cmd_timeout",
        traceId: "trc_creation",
      });

      commands.length = 0;
      const result = detachedCreateResult();
      const warning = await runSessionCommand(
        ["create", "web", "--branch", "feature/stale", "--terminal", "tmux"],
        { config: fixture.config },
        creationObserverDeps(fixture.socketPath, [creationSnapshot(), creationSnapshot()], {
          dispatch: async (command) => {
            commands.push(command);
            return acceptedReceipt("cmd_stale");
          },
          waitForCommand: async () => succeededRecord("cmd_stale", firstCommand(commands), result),
        }),
      );
      expect(warning).toMatchObject({
        action: "create",
        outcome: { status: "succeeded", result },
        convergence: {
          status: "warning",
          session: { state: "missing" },
          warning: { code: "SESSION_CREATE_CONVERGENCE_MISSING" },
        },
      });
      expect(sessionCommandExitCode(warning)).toBe(0);
      expect(renderSessionCommandText(warning as never)).toContain("Convergence: warning");
    } finally {
      await fixture.cleanup();
    }
  });
});

function creationObserverDeps(
  socketPath: string,
  snapshots: readonly StationSnapshot[],
  options: {
    getSnapshot?: () => Promise<StationSnapshot>;
    getCurrentSessionContext?: (
      caller: TerminalCallerContextRequest,
    ) => Promise<CurrentSessionContext>;
    dispatch?: (command: StationCommand) => Promise<CommandReceipt>;
    waitForCommand?: (commandId: string) => Promise<CommandRecord>;
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
        getCurrentSessionContext: options.getCurrentSessionContext ?? (async () => currentContext),
        dispatch: async (command: StationCommand) => {
          lastCommand = command;
          return options.dispatch?.(command) ?? acceptedReceipt("cmd_default");
        },
        waitForCommand:
          options.waitForCommand ??
          (async (commandId: string) => {
            if (lastCommand === undefined) throw new Error("No command was dispatched.");
            return succeededRecord(commandId, lastCommand);
          }),
      }) as never,
    sleep: async () => undefined,
    socketPath,
  };
}

function creationSnapshotSequence(
  initial: StationSnapshot,
  commands: readonly StationCommand[],
  result: SessionCreateCommandResult | SessionForkCommandResult,
): () => Promise<StationSnapshot> {
  let initialReturned = false;
  return async () => {
    if (!initialReturned) {
      initialReturned = true;
      return initial;
    }
    return createdSnapshot(initial, commands, result);
  };
}

function acceptedReceipt(commandId: string): CommandReceipt {
  return {
    commandId,
    traceId: "trc_creation",
    spanId: "spn_creation",
    accepted: true,
    status: "accepted",
  };
}

function rejectedReceipt(commandId: string): CommandReceipt {
  return {
    commandId,
    traceId: "trc_creation",
    spanId: "spn_creation",
    accepted: false,
    status: "rejected",
    error: {
      tag: "CommandRejectedError",
      code: "SESSION_COMMAND_REJECTED",
      message: "The session command was rejected.",
    },
  };
}

function succeededRecord(
  id: string,
  command: StationCommand,
  result?: SessionCreateCommandResult | SessionForkCommandResult,
): TerminalCommandRecord {
  const record: CommandRecord = {
    id,
    type: command.type,
    command,
    status: "succeeded",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    traceId: "trc_creation",
    spanId: "spn_creation",
    ...(result === undefined ? {} : { result }),
  } as CommandRecord;
  return record as TerminalCommandRecord;
}

function failedRecord(id: string, command: StationCommand): TerminalCommandRecord {
  return {
    id,
    type: command.type,
    command,
    status: "failed",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    traceId: "trc_creation",
    spanId: "spn_creation",
    error: {
      tag: "SessionCommandError",
      code: "SESSION_COMMAND_FAILED",
      message: "The session command failed.",
    },
  } as TerminalCommandRecord;
}

function detachedCreateResult(
  resolvedGroupId?: SessionCreateCommandResult["resolvedGroupId"],
): SessionCreateCommandResult {
  const result: SessionCreateCommandResult = {
    type: "session.create",
    projectId: "web",
    worktreeId: "wt_created",
    sessionId: "ses_created",
    requestedPlacement: "detached",
    resolvedPlacement: {
      provider: "tmux",
      targetId: "tmux:created:$1:@2",
      generation: "created-generation",
      presentation: "detached",
    },
  };
  if (resolvedGroupId !== undefined) result.resolvedGroupId = resolvedGroupId;
  return result;
}

function siblingForkResult(
  resolvedGroupId: SessionForkCommandResult["resolvedGroupId"] = "group_source",
): SessionForkCommandResult {
  const result: SessionForkCommandResult = {
    type: "session.fork",
    projectId: "web",
    worktreeId: "wt_forked",
    sessionId: "ses_forked",
    requestedPlacement: "sibling",
    resolvedPlacement: {
      provider: "tmux",
      targetId: "tmux:forked:$9:@10",
      generation: "forked-generation",
      presentation: "presented",
    },
  };
  if (resolvedGroupId !== undefined) result.resolvedGroupId = resolvedGroupId;
  return result;
}

function firstCommand(commands: readonly StationCommand[]): StationCommand {
  const command = commands[0];
  if (command === undefined) throw new Error("Expected one dispatched command.");
  return command;
}

function createdSnapshot(
  initial: StationSnapshot,
  commands: readonly StationCommand[],
  result: SessionCreateCommandResult | SessionForkCommandResult,
): StationSnapshot {
  const command = firstCommand(commands);
  if (command.type !== "session.create" && command.type !== "session.fork") {
    throw new Error("Expected a session creation command.");
  }
  const title = command.payload.title ?? command.payload.branch;
  const harnessProvider = command.payload.harness?.provider ?? "codex";
  const group = command.payload.group;
  const sourceSessionId = group?.kind === "source" ? group.sourceSessionId : undefined;
  const groups = initial.sessionGroups.map((candidate) => {
    const retainedSessionIds = candidate.sessionIds.filter(
      (sessionId) =>
        sessionId !== result.sessionId &&
        (sourceSessionId === undefined ||
          candidate.id === result.resolvedGroupId ||
          sessionId !== sourceSessionId),
    );
    if (candidate.id !== result.resolvedGroupId) {
      return { ...candidate, sessionIds: retainedSessionIds };
    }
    return {
      ...candidate,
      sessionIds: [
        ...new Set([
          ...retainedSessionIds,
          ...(sourceSessionId === undefined ? [] : [sourceSessionId]),
          result.sessionId,
        ]),
      ],
    };
  });
  if (
    result.resolvedGroupId !== undefined &&
    !groups.some((candidate) => candidate.id === result.resolvedGroupId)
  ) {
    groups.push({
      id: result.resolvedGroupId,
      projectId: result.projectId,
      name: group?.kind === "create" ? group.name : "Transaction Group",
      sessionIds: [...(sourceSessionId === undefined ? [] : [sourceSessionId]), result.sessionId],
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }
  return StationSnapshotSchema.parse({
    ...initial,
    rows: [
      ...initial.rows,
      {
        id: result.worktreeId,
        projectId: result.projectId,
        projectLabel: "Web App",
        title,
        branch: command.payload.branch,
        path: `/projects/web/${result.worktreeId}`,
        registrationIdentity: `registration-${result.worktreeId}`,
        worktree: { state: "exists", source: "worktrunk" },
        terminal: {
          provider: "tmux",
          state: "open",
          focusable: true,
          closeable: true,
          hasWorkspace: true,
          hasPrimaryAgentEndpoint: true,
        },
        display: { statusLabel: "starting", sortPriority: 20, alert: false },
      },
    ],
    sessions: [
      ...initial.sessions,
      {
        id: result.sessionId,
        origin: "station",
        projectId: result.projectId,
        worktreeId: result.worktreeId,
        createdAt: now,
        updatedAt: now,
        harness: {
          provider: harnessProvider,
          mode: "interactive",
          capabilities: harnessCapabilities(),
        },
        terminal: {
          provider: "tmux",
          state: "open",
          focusable: true,
          closeable: true,
          hasWorkspace: true,
          hasPrimaryAgentEndpoint: true,
        },
        status: {
          value: "starting",
          confidence: "high",
          reason: "The created harness is starting.",
          source: "harness_process",
          updatedAt: now,
        },
        title,
        tags: [],
      },
    ],
    sessionGroups: groups,
  });
}

function creationSnapshot(): StationSnapshot {
  return StationSnapshotSchema.parse({
    schemaVersion: "0.11.0",
    generatedAt: now,
    observer: { pid: 1234, startedAt: now, version: "0.0.0", healthy: true },
    providerHealth: {
      worktrunk: {
        providerId: "worktrunk",
        providerType: "worktree",
        status: "healthy",
        lastCheckedAt: now,
      },
      tmux: {
        providerId: "tmux",
        providerType: "terminal",
        status: "healthy",
        lastCheckedAt: now,
      },
      codex: {
        providerId: "codex",
        providerType: "harness",
        status: "healthy",
        lastCheckedAt: now,
      },
      claude: {
        providerId: "claude",
        providerType: "harness",
        status: "healthy",
        lastCheckedAt: now,
      },
    },
    harnesses: [
      { id: "codex", label: "Codex" },
      { id: "claude", label: "Claude" },
    ],
    projects: [
      {
        id: "web",
        label: "Web App",
        root: "/projects/web",
        defaults: { harness: "codex", terminal: "native", layout: "custom-project-layout" },
        health: {
          providerId: "worktrunk",
          providerType: "worktree",
          status: "healthy",
          lastCheckedAt: now,
        },
        counts: {
          sessions: 2,
          worktrees: 2,
          agents: 2,
          working: 1,
          idle: 1,
          attention: 0,
          unknown: 0,
        },
      },
    ],
    rows: [
      sourceRow("wt_source", "Source session", "feature/source"),
      sourceRow("wt_ungrouped", "Ungrouped source", "feature/ungrouped"),
    ],
    sessions: [
      sourceSession("ses_source", "wt_source", "Source session", "codex"),
      sourceSession("ses_ungrouped", "wt_ungrouped", "Ungrouped source", "claude"),
    ],
    sessionGroups: [
      {
        id: "group_source",
        projectId: "web",
        name: "Source Group",
        sessionIds: ["ses_source"],
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "group_root",
        projectId: "web",
        name: "Root Group",
        sessionIds: [],
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "group_nested",
        projectId: "web",
        parentGroupId: "group_root",
        name: "Nested Group",
        sessionIds: [],
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    counts: {
      projects: 1,
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

function sourceRow(id: string, title: string, branch: string) {
  return {
    id,
    projectId: "web",
    projectLabel: "Web App",
    title,
    branch,
    path: `/projects/web/${id}`,
    registrationIdentity: `registration-${id}`,
    worktree: { state: "exists" as const, source: "worktrunk" as const, dirty: true },
    terminal: {
      provider: "tmux",
      state: "open" as const,
      focusable: true,
      closeable: true,
      hasWorkspace: true,
      hasPrimaryAgentEndpoint: true,
    },
    display: { statusLabel: "working", sortPriority: 10, alert: false },
  };
}

function sourceSession(id: string, worktreeId: string, title: string, provider: string) {
  return {
    id,
    origin: "station" as const,
    projectId: "web",
    worktreeId,
    createdAt: now,
    updatedAt: now,
    harness: {
      provider,
      mode: "interactive" as const,
      capabilities: harnessCapabilities(),
    },
    terminal: {
      provider: "tmux",
      state: "open" as const,
      focusable: true,
      closeable: true,
      hasWorkspace: true,
      hasPrimaryAgentEndpoint: true,
    },
    status: {
      value: "working" as const,
      confidence: "high" as const,
      reason: "The source harness is running.",
      source: "harness_process" as const,
      updatedAt: now,
    },
    title,
    tags: [],
  };
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
