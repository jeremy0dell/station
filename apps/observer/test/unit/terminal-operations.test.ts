import type {
  BuildHarnessLaunchRequest,
  HarnessLaunchPlan,
  LogRecord,
  OpenWorkspaceRequest,
  OpenWorkspaceResult,
  ProviderProjectConfig,
  TerminalFocusContext,
  TerminalLaunchProcessRequest,
  TerminalLaunchProcessResult,
  TerminalTargetId,
  TerminalTargetObservation,
  WorktreeRow,
} from "@station/contracts";
import {
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import type { CommandHandlerContext } from "../../src/commands/queue.js";
import {
  closeTerminal,
  ensureAgentWorkspace,
  focusTerminal,
  hasCloseableTerminalAttachment,
} from "../../src/commands/terminalOperations.js";
import type { StationLogger } from "../../src/stationLogger.js";

const now = "2026-06-04T12:00:00.000Z";
const clock = { now: () => new Date(now) };

describe("terminal operations", () => {
  it("does not infer close authority from an open attachment", () => {
    const row = {
      terminal: { provider: "native", state: "open" },
    } as WorktreeRow;

    expect(hasCloseableTerminalAttachment({ row })).toBe(false);
  });

  it("permits cleanup only when close authority is explicit", () => {
    const row = {
      terminal: { provider: "native", state: "open", closeable: true },
    } as WorktreeRow;

    expect(hasCloseableTerminalAttachment({ row })).toBe(true);
  });

  it("opens the workspace, builds launch from the normalized terminal observation, and launches", async () => {
    const order: string[] = [];
    const terminal = new RecordingTerminalProvider({ order });
    const harness = new CapturingHarnessProvider({ order });

    await ensureAgentWorkspace(ensureInput(terminal, harness, { focus: false }));

    expect(order).toEqual(["openWorkspace", "buildLaunch", "launchProcess"]);
    expect(harness.lastBuildRequest?.terminalTarget).toMatchObject({
      id: "term_fake",
      provider: "fake-terminal",
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_feature",
      state: "open",
      cwd: "/tmp/station/web/feature",
      harnessBinding: {
        role: "main-agent",
        harnessProvider: "fake-harness",
        worktreePath: "/tmp/station/web/feature",
      },
    });
    expect(terminal.snapshot().launches[0]?.terminalTarget).toMatchObject({
      targetId: "term_fake",
      provider: "fake-terminal",
    });
  });

  it("passes exact resume targets through the harness launch request", async () => {
    const terminal = new RecordingTerminalProvider();
    const harness = new CapturingHarnessProvider();
    const resume = {
      target: { kind: "native-session" as const, id: "codex_session_123" },
      previousSessionId: "ses_web_feature",
      recoveryHandleId: "rec_codex_123",
    };

    await ensureAgentWorkspace(ensureInput(terminal, harness, { resume }));

    expect(harness.lastBuildRequest?.resume).toEqual(resume);
  });

  it("focuses only when requested and treats focus failure as non-fatal", async () => {
    const backgroundTerminal = new RecordingTerminalProvider();
    await ensureAgentWorkspace(
      ensureInput(backgroundTerminal, new CapturingHarnessProvider(), { focus: false }),
    );
    expect(backgroundTerminal.snapshot().focused).toEqual([]);

    const focusFailureTerminal = new RecordingTerminalProvider({
      failures: {
        focusTarget: {
          tag: "TerminalProviderError",
          code: "FAKE_FOCUS_FAILED",
          message: "The fake terminal failed to focus.",
          provider: "fake-terminal",
        },
      },
    });
    await ensureAgentWorkspace(
      ensureInput(focusFailureTerminal, new CapturingHarnessProvider(), {
        focus: true,
        origin: { provider: "tmux", clientId: "client_1" },
      }),
    );
    expect(focusFailureTerminal.snapshot().launches).toHaveLength(1);
    expect(focusFailureTerminal.snapshot().focused).toEqual([]);
  });

  it("focuses a listed target by session subject and preserves focus origin", async () => {
    const order: string[] = [];
    const logger = new CapturingLogger();
    const terminal = new RecordingTerminalProvider({
      order,
      targets: [
        createFakeTerminalTarget({
          id: "term_workspace",
          provider: "fake-terminal",
          projectId: "web",
          worktreeId: "wt_web_feature",
          state: "open",
          now,
        }),
        createFakeTerminalTarget({
          id: "term_agent",
          provider: "fake-terminal",
          projectId: "web",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
          state: "open",
          now,
          harnessBinding: {
            role: "main-agent",
            harnessProvider: "fake-harness",
            worktreePath: "/tmp/station/web/feature",
          },
          providerData: { paneId: "%ignored" },
        }),
      ],
    });

    await focusTerminal({
      terminal,
      subject: {
        projectId: "web",
        worktreeId: "wt_web_feature",
        sessionId: "ses_web_feature",
      },
      origin: { provider: "tmux", clientId: "client_1" },
      context: commandContext("cmd_focus"),
      clock,
      logger,
    });

    expect(order).toEqual(["listTargets", "focusTarget"]);
    expect(terminal.snapshot().focused).toEqual(["term_agent"]);
    expect(terminal.snapshot().focusContexts).toEqual([
      { origin: { provider: "tmux", clientId: "client_1" } },
    ]);
    expect(logger.records).toEqual([
      expect.objectContaining({
        level: "info",
        message: "Terminal focus decision completed.",
        attributes: expect.objectContaining({
          operation: "terminal.focus",
          commandId: "cmd_focus",
          traceId: "trace_cmd_focus",
          projectId: "web",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
          terminalProvider: "fake-terminal",
          originProvider: "tmux",
          hasOriginClientId: true,
          totalTargetCount: 2,
          matchingTargetCount: 2,
          selectedTargetId: "term_agent",
          selectedTargetState: "open",
          selectionBasis: "session-main-agent",
          outcome: "focused",
        }),
      }),
    ]);
    expect(JSON.stringify(logger.records)).not.toContain("client_1");
    expect(JSON.stringify(logger.records)).not.toContain("%ignored");
  });

  it("logs normalized provider focus failure against the selected target", async () => {
    const logger = new CapturingLogger();
    const terminal = new RecordingTerminalProvider({
      targets: [
        createFakeTerminalTarget({
          id: "term_agent",
          provider: "fake-terminal",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
          now,
        }),
      ],
      failures: {
        focusTarget: {
          tag: "TerminalProviderError",
          code: "FAKE_FOCUS_FAILED",
          message: "The fake terminal failed to focus.",
          provider: "fake-terminal",
        },
      },
    });

    await expect(
      focusTerminal({
        terminal,
        subject: { worktreeId: "wt_web_feature", sessionId: "ses_web_feature" },
        context: commandContext("cmd_focus_failed"),
        clock,
        logger,
      }),
    ).rejects.toMatchObject({ code: "FAKE_FOCUS_FAILED" });
    expect(logger.records).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "Terminal focus decision failed.",
        attributes: expect.objectContaining({
          selectedTargetId: "term_agent",
          selectionBasis: "session",
          outcome: "failed",
          errorCode: "FAKE_FOCUS_FAILED",
        }),
      }),
    ]);
  });

  it("does not let decision logger failure change successful focus", async () => {
    const terminal = new RecordingTerminalProvider({
      targets: [
        createFakeTerminalTarget({
          id: "term_agent",
          provider: "fake-terminal",
          worktreeId: "wt_web_feature",
          now,
        }),
      ],
    });
    const logger: StationLogger = {
      info: async () => Promise.reject(new Error("log unavailable")),
      warn: async () => undefined,
      error: async () => undefined,
    };

    await expect(
      focusTerminal({
        terminal,
        subject: { worktreeId: "wt_web_feature" },
        context: commandContext("cmd_focus_log_failure"),
        clock,
        logger,
      }),
    ).resolves.toBeUndefined();
  });

  it("closes the main-agent target before workspace targets for worktree subjects", async () => {
    const terminal = new RecordingTerminalProvider({
      targets: [
        createFakeTerminalTarget({
          id: "term_workspace",
          provider: "fake-terminal",
          projectId: "web",
          worktreeId: "wt_web_feature",
          state: "open",
          now,
        }),
        createFakeTerminalTarget({
          id: "term_agent",
          provider: "fake-terminal",
          projectId: "web",
          worktreeId: "wt_web_feature",
          state: "detached",
          now,
          harnessBinding: {
            role: "main-agent",
            harnessProvider: "fake-harness",
            worktreePath: "/tmp/station/web/feature",
          },
        }),
      ],
    });

    await closeTerminal({
      terminal,
      subject: { projectId: "web", worktreeId: "wt_web_feature" },
      context: commandContext("cmd_close"),
      clock,
    });

    expect(terminal.snapshot().closed).toEqual(["term_agent"]);
  });

  it("rejects stale-only and missing focus or close subjects without provider mutation", async () => {
    const logger = new CapturingLogger();
    const staleTerminal = new RecordingTerminalProvider({
      targets: [
        createFakeTerminalTarget({
          id: "term_stale",
          provider: "fake-terminal",
          projectId: "web",
          worktreeId: "wt_web_feature",
          state: "stale",
          now,
        }),
      ],
    });
    await expect(
      focusTerminal({
        terminal: staleTerminal,
        subject: { projectId: "web", worktreeId: "wt_web_feature" },
        context: commandContext("cmd_stale_focus"),
        clock,
        logger,
      }),
    ).rejects.toMatchObject({
      tag: "TerminalProviderError",
      code: "TERMINAL_TARGET_STALE",
      provider: "fake-terminal",
      worktreeId: "wt_web_feature",
    });
    expect(staleTerminal.snapshot().focused).toEqual([]);
    expect(logger.records).toEqual([
      expect.objectContaining({
        level: "warn",
        attributes: expect.objectContaining({
          totalTargetCount: 1,
          matchingTargetCount: 1,
          selectionBasis: "stale",
          errorCode: "TERMINAL_TARGET_STALE",
        }),
      }),
    ]);

    const missingTerminal = new RecordingTerminalProvider();
    await expect(
      closeTerminal({
        terminal: missingTerminal,
        subject: { worktreeId: "wt_missing" },
        context: commandContext("cmd_missing_close"),
        clock,
      }),
    ).rejects.toMatchObject({
      tag: "TerminalProviderError",
      code: "TERMINAL_TARGET_MISSING",
      provider: "fake-terminal",
      worktreeId: "wt_missing",
    });
    expect(missingTerminal.snapshot().closed).toEqual([]);
  });

  it("preserves owner-tagged provider failures", async () => {
    const terminal = new RecordingTerminalProvider({
      failures: {
        openWorkspace: {
          tag: "TerminalProviderError",
          code: "FAKE_OPEN_FAILED",
          message: "The fake terminal failed to open.",
          provider: "fake-terminal",
        },
      },
    });

    await expect(
      ensureAgentWorkspace(ensureInput(terminal, new CapturingHarnessProvider())),
    ).rejects.toMatchObject({
      tag: "TerminalProviderError",
      code: "FAKE_OPEN_FAILED",
      provider: "fake-terminal",
    });
  });

  it("closes an opened target before surfacing build and launch failures", async () => {
    const buildFailureTerminal = new RecordingTerminalProvider();
    await expect(
      ensureAgentWorkspace(
        ensureInput(
          buildFailureTerminal,
          new CapturingHarnessProvider({
            failures: {
              buildLaunch: {
                tag: "HarnessProviderError",
                code: "FAKE_BUILD_FAILED",
                message: "The fake harness failed to build.",
                provider: "fake-harness",
              },
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "FAKE_BUILD_FAILED", provider: "fake-harness" });
    expect(buildFailureTerminal.snapshot().closed).toEqual(["term_fake"]);

    const launchFailureTerminal = new RecordingTerminalProvider({
      failures: {
        launchProcess: {
          tag: "TerminalProviderError",
          code: "FAKE_LAUNCH_FAILED",
          message: "The fake terminal failed to launch.",
          provider: "fake-terminal",
        },
      },
    });
    await expect(
      ensureAgentWorkspace(ensureInput(launchFailureTerminal, new CapturingHarnessProvider())),
    ).rejects.toMatchObject({ code: "FAKE_LAUNCH_FAILED", provider: "fake-terminal" });
    expect(launchFailureTerminal.snapshot().closed).toEqual(["term_fake"]);
  });

  it("repeats launch preflight immediately before opening the workspace", async () => {
    const order: string[] = [];
    const terminal = new RecordingTerminalProvider({ order });
    const preflightError = {
      tag: "HarnessProviderError",
      code: "HARNESS_HOOKS_NOT_INSTALLED",
      message: "Required hooks are not installed.",
      provider: "fake-harness",
    } as const;

    await expect(
      ensureAgentWorkspace(
        ensureInput(terminal, new CapturingHarnessProvider({ order }), {
          launchPreflight: async () => {
            throw preflightError;
          },
        }),
      ),
    ).rejects.toMatchObject(preflightError);
    expect(order).toEqual([]);
    expect(terminal.snapshot()).toMatchObject({ targets: [], launches: [] });
  });

  it("rejects cancellation before launching", async () => {
    const terminal = new RecordingTerminalProvider();
    const controller = new AbortController();
    controller.abort({
      tag: "CancellationError",
      code: "COMMAND_CANCELLED",
      message: "Observer command was cancelled.",
    });

    await expect(
      ensureAgentWorkspace(
        ensureInput(terminal, new CapturingHarnessProvider(), {
          context: commandContext("cmd_cancelled", controller.signal),
        }),
      ),
    ).rejects.toMatchObject({ tag: "CancellationError", code: "COMMAND_CANCELLED" });
    expect(terminal.snapshot().launches).toEqual([]);
  });

  it("executes independent operations without retaining command receipts", async () => {
    const terminal = new RecordingTerminalProvider();
    const harness = new CapturingHarnessProvider();

    await ensureAgentWorkspace(
      ensureInput(terminal, harness, { context: commandContext("cmd_first") }),
    );
    await ensureAgentWorkspace(
      ensureInput(terminal, harness, { context: commandContext("cmd_second") }),
    );

    expect(terminal.snapshot().launches).toHaveLength(2);
  });

  it("leaves success lifecycle logging to the command queue", async () => {
    const logger = new CapturingLogger();

    await ensureAgentWorkspace(
      ensureInput(new RecordingTerminalProvider(), new CapturingHarnessProvider(), { logger }),
    );

    expect(logger.records).toEqual([]);
  });
});

function ensureInput(
  terminal: RecordingTerminalProvider,
  harness: CapturingHarnessProvider,
  overrides: Partial<Parameters<typeof ensureAgentWorkspace>[0]> = {},
): Parameters<typeof ensureAgentWorkspace>[0] {
  return {
    terminal,
    harness,
    launchPreflight: async () => undefined,
    project,
    worktree: createFakeWorktree({
      id: "wt_web_feature",
      projectId: "web",
      branch: "feature",
      path: "/tmp/station/web/feature",
      now,
    }),
    sessionId: "ses_web_feature",
    harnessOptions: {
      mode: "interactive",
      profile: "default",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    },
    layout: "agent-build-shell",
    focus: true,
    initialPrompt: "Start the feature.",
    context: commandContext("cmd_ensure"),
    clock,
    ...overrides,
  };
}

function commandContext(
  commandId: string,
  signal = new AbortController().signal,
): CommandHandlerContext {
  return {
    commandId,
    trace: { traceId: `trace_${commandId}`, spanId: `span_${commandId}` },
    command: { type: "terminal.focus", payload: { worktreeId: "wt_web_feature" } },
    signal,
    beginCommit: () => undefined,
  };
}

const project: ProviderProjectConfig = {
  id: "web",
  label: "web",
  root: "/tmp/station/web",
  defaults: {
    harness: "fake-harness",
    terminal: "fake-terminal",
    layout: "agent-build-shell",
  },
  worktrunk: { enabled: true },
};

class RecordingTerminalProvider extends FakeTerminalProvider {
  readonly #order: string[];

  constructor(
    options: ConstructorParameters<typeof FakeTerminalProvider>[0] & {
      order?: string[] | undefined;
    } = {},
  ) {
    const { order, ...providerOptions } = options;
    super({ now, ...providerOptions });
    this.#order = order ?? [];
  }

  override async openWorkspace(request: OpenWorkspaceRequest): Promise<OpenWorkspaceResult> {
    this.#order.push("openWorkspace");
    return super.openWorkspace(request);
  }

  override async listTargets(): Promise<TerminalTargetObservation[]> {
    this.#order.push("listTargets");
    return super.listTargets();
  }

  override async launchProcess(
    request: TerminalLaunchProcessRequest,
  ): Promise<TerminalLaunchProcessResult> {
    this.#order.push("launchProcess");
    return super.launchProcess(request);
  }

  override async focusTarget(
    targetId: TerminalTargetId,
    context?: TerminalFocusContext,
  ): Promise<void> {
    this.#order.push("focusTarget");
    return super.focusTarget(targetId, context);
  }

  override async closeTarget(targetId: TerminalTargetId): Promise<void> {
    this.#order.push("closeTarget");
    return super.closeTarget(targetId);
  }
}

class CapturingHarnessProvider extends FakeHarnessProvider {
  readonly #order: string[];
  lastBuildRequest: BuildHarnessLaunchRequest | undefined;

  constructor(
    options: ConstructorParameters<typeof FakeHarnessProvider>[0] & {
      order?: string[] | undefined;
    } = {},
  ) {
    const { order, ...providerOptions } = options;
    super({ now, ...providerOptions });
    this.#order = order ?? [];
  }

  override async buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan> {
    this.#order.push("buildLaunch");
    this.lastBuildRequest = request;
    return super.buildLaunch(request);
  }
}

class CapturingLogger implements StationLogger {
  readonly records: LogRecord[] = [];

  async info(message: string, attributes?: Record<string, unknown>): Promise<void> {
    this.record("info", message, attributes);
  }

  async warn(message: string, attributes?: Record<string, unknown>): Promise<void> {
    this.record("warn", message, attributes);
  }

  async error(message: string, attributes?: Record<string, unknown>): Promise<void> {
    this.record("error", message, attributes);
  }

  private record(
    level: LogRecord["level"],
    message: string,
    attributes?: Record<string, unknown>,
  ): void {
    const logged: LogRecord = {
      component: "observer",
      timestamp: now,
      level,
      message,
    };
    if (attributes !== undefined) logged.attributes = attributes;
    this.records.push(logged);
  }
}
