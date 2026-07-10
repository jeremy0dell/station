import type {
  BuildHarnessLaunchRequest,
  EnsureAgentWorkspaceIntent,
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
} from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import {
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  createTerminalIntentRunner,
  type TerminalIntentProviderAccess,
  type TerminalIntentRunner,
} from "../../src/commands/terminalIntentRunner";

const now = "2026-06-04T12:00:00.000Z";
const clock = { now: () => new Date(now) };

describe("createTerminalIntentRunner", () => {
  it("opens the workspace, builds launch from the normalized terminal observation, and launches", async () => {
    const order: string[] = [];
    const terminal = new RecordingTerminalProvider({ order });
    const harness = new CapturingHarnessProvider({ order });
    const runner = runnerFor(terminal, [harness]);

    const receipt = await runner.submitIntent({ ...ensureIntent(), focus: false }, {});

    expect(receipt).toMatchObject({
      status: "accepted",
      accepted: true,
      commandId: "cmd_ensure",
      type: "session.ensureAgentWorkspace",
      terminalProvider: "fake-terminal",
    });
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
    expect(terminal.snapshot().launches).toHaveLength(1);
    expect(terminal.snapshot().launches[0]?.terminalTarget).toMatchObject({
      targetId: "term_fake",
      provider: "fake-terminal",
    });
  });

  it("passes exact resume targets through the harness launch request", async () => {
    const harness = new CapturingHarnessProvider();
    const runner = runnerFor(new RecordingTerminalProvider(), [harness]);
    const resume = {
      target: {
        kind: "native-session" as const,
        id: "codex_session_123",
      },
      previousSessionId: "ses_web_feature",
      recoveryHandleId: "rec_codex_123",
    };

    await expect(
      runner.submitIntent({
        ...ensureIntent(),
        resume,
      }),
    ).resolves.toMatchObject({
      status: "accepted",
    });

    expect(harness.lastBuildRequest?.resume).toEqual(resume);
  });

  it("focuses only when requested and treats focus failure as non-fatal", async () => {
    const backgroundTerminal = new RecordingTerminalProvider();
    const background = runnerFor(backgroundTerminal, [new CapturingHarnessProvider()]);

    await expect(
      background.submitIntent({ ...ensureIntent(), focus: false }),
    ).resolves.toMatchObject({
      status: "accepted",
    });
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
    const focused = runnerFor(focusFailureTerminal, [new CapturingHarnessProvider()]);

    await expect(
      focused.submitIntent({
        ...ensureIntent(),
        focus: true,
        origin: {
          provider: "tmux",
          clientId: "client_1",
        },
      }),
    ).resolves.toMatchObject({
      status: "accepted",
    });
    expect(focusFailureTerminal.snapshot().launches).toHaveLength(1);
    expect(focusFailureTerminal.snapshot().focused).toEqual([]);
  });

  it("focuses a listed target by session subject and preserves focus origin", async () => {
    const order: string[] = [];
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
          providerData: {
            paneId: "%ignored",
          },
        }),
      ],
    });
    const runner = runnerFor(terminal, [new CapturingHarnessProvider()]);

    await expect(
      runner.submitIntent({
        type: "terminal.focus",
        commandId: "cmd_focus",
        terminalProvider: "fake-terminal",
        subject: {
          projectId: "web",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
        },
        origin: {
          provider: "tmux",
          clientId: "client_1",
        },
      }),
    ).resolves.toMatchObject({
      status: "accepted",
    });

    expect(order).toEqual(["listTargets", "focusTarget"]);
    expect(terminal.snapshot().focused).toEqual(["term_agent"]);
    expect(terminal.snapshot().focusContexts).toEqual([
      {
        origin: {
          provider: "tmux",
          clientId: "client_1",
        },
      },
    ]);
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

    await expect(
      runnerFor(terminal, [new CapturingHarnessProvider()]).submitIntent({
        type: "terminal.close",
        commandId: "cmd_close",
        terminalProvider: "fake-terminal",
        subject: {
          projectId: "web",
          worktreeId: "wt_web_feature",
        },
        force: true,
      }),
    ).resolves.toMatchObject({
      status: "accepted",
    });

    expect(terminal.snapshot().closed).toEqual(["term_agent"]);
  });

  it("rejects stale-only and missing focus or close subjects without calling provider mechanics", async () => {
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
      runnerFor(staleTerminal, [new CapturingHarnessProvider()]).submitIntent({
        type: "terminal.focus",
        commandId: "cmd_stale_focus",
        terminalProvider: "fake-terminal",
        subject: {
          projectId: "web",
          worktreeId: "wt_web_feature",
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        tag: "TerminalProviderError",
        code: "TERMINAL_TARGET_STALE",
        provider: "fake-terminal",
        worktreeId: "wt_web_feature",
      },
    });
    expect(staleTerminal.snapshot().focused).toEqual([]);

    const missingTerminal = new RecordingTerminalProvider();
    await expect(
      runnerFor(missingTerminal, [new CapturingHarnessProvider()]).submitIntent({
        type: "terminal.close",
        commandId: "cmd_missing_close",
        terminalProvider: "fake-terminal",
        subject: {
          worktreeId: "wt_missing",
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        tag: "TerminalProviderError",
        code: "TERMINAL_TARGET_MISSING",
        provider: "fake-terminal",
        worktreeId: "wt_missing",
      },
    });
    expect(missingTerminal.snapshot().closed).toEqual([]);
  });

  it("returns owner-tagged rejected receipts for missing harness and provider failures", async () => {
    await expect(
      runnerFor(new RecordingTerminalProvider(), []).submitIntent(ensureIntent()),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        tag: "HarnessProviderError",
        code: "HARNESS_PROVIDER_UNAVAILABLE",
        provider: "fake-harness",
      },
    });

    await expect(
      runnerFor(
        new RecordingTerminalProvider({
          failures: {
            openWorkspace: {
              tag: "TerminalProviderError",
              code: "FAKE_OPEN_FAILED",
              message: "The fake terminal failed to open.",
              provider: "fake-terminal",
            },
          },
        }),
        [new CapturingHarnessProvider()],
      ).submitIntent(ensureIntent()),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        tag: "TerminalProviderError",
        code: "FAKE_OPEN_FAILED",
        provider: "fake-terminal",
      },
    });
  });

  it("closes an opened target before rejecting build and launch failures", async () => {
    const buildFailureTerminal = new RecordingTerminalProvider();
    await expect(
      runnerFor(buildFailureTerminal, [
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
      ]).submitIntent(ensureIntent()),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "FAKE_BUILD_FAILED",
        provider: "fake-harness",
      },
    });
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
      runnerFor(launchFailureTerminal, [new CapturingHarnessProvider()]).submitIntent(
        ensureIntent(),
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "FAKE_LAUNCH_FAILED",
        provider: "fake-terminal",
      },
    });
    expect(launchFailureTerminal.snapshot().closed).toEqual(["term_fake"]);
  });

  it("returns a rejected receipt for cancellation before launching", async () => {
    const terminal = new RecordingTerminalProvider();
    const controller = new AbortController();
    controller.abort({
      tag: "CancellationError",
      code: "COMMAND_CANCELLED",
      message: "Observer command was cancelled.",
    });

    await expect(
      runnerFor(terminal, [new CapturingHarnessProvider()]).submitIntent(ensureIntent(), {
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        tag: "CancellationError",
        code: "COMMAND_CANCELLED",
      },
    });
    expect(terminal.snapshot().launches).toEqual([]);
  });

  it("deduplicates duplicate commandId and type submissions in-process", async () => {
    const terminal = new RecordingTerminalProvider();
    const runner = runnerFor(terminal, [new CapturingHarnessProvider()]);

    const first = await runner.submitIntent(ensureIntent());
    const second = await runner.submitIntent(ensureIntent());

    expect(first).toEqual(second);
    expect(terminal.snapshot().launches).toHaveLength(1);
  });

  it("logs terminal intent submission and receipt with product identifiers", async () => {
    const logger = new CapturingLogger();
    const runner = createTerminalIntentRunner({
      providers: {
        terminals: new Map([["fake-terminal", new RecordingTerminalProvider()]]),
        harnesses: new Map([["fake-harness", new CapturingHarnessProvider()]]),
      },
      clock,
      logger,
    });

    await expect(
      runner.submitIntent(ensureIntent(), {
        trace: {
          traceId: "trace_1",
          spanId: "span_1",
        },
      }),
    ).resolves.toMatchObject({
      status: "accepted",
    });

    expect(logger.records).toEqual([
      expect.objectContaining({
        level: "info",
        message: "Terminal intent submitted.",
        attributes: expect.objectContaining({
          commandId: "cmd_ensure",
          intentType: "session.ensureAgentWorkspace",
          terminalProvider: "fake-terminal",
          harnessProvider: "fake-harness",
          projectId: "web",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
          traceId: "trace_1",
          spanId: "span_1",
        }),
      }),
      expect.objectContaining({
        level: "info",
        message: "Terminal intent accepted.",
        attributes: expect.objectContaining({
          commandId: "cmd_ensure",
          intentType: "session.ensureAgentWorkspace",
          terminalProvider: "fake-terminal",
          harnessProvider: "fake-harness",
          projectId: "web",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
        }),
      }),
    ]);
  });
});

function runnerFor(
  terminal: RecordingTerminalProvider,
  harnesses: CapturingHarnessProvider[],
): TerminalIntentRunner {
  const providers: TerminalIntentProviderAccess = {
    terminals: new Map([[terminal.id, terminal]]),
    harnesses: new Map(harnesses.map((provider) => [provider.id, provider])),
  };
  return createTerminalIntentRunner({
    providers,
    clock,
  });
}

function ensureIntent(): EnsureAgentWorkspaceIntent {
  const worktree = createFakeWorktree({
    id: "wt_web_feature",
    projectId: "web",
    branch: "feature",
    path: "/tmp/station/web/feature",
    now,
  });
  return {
    type: "session.ensureAgentWorkspace",
    commandId: "cmd_ensure",
    terminalProvider: "fake-terminal",
    project,
    worktree,
    sessionId: "ses_web_feature",
    harness: {
      provider: "fake-harness",
      mode: "interactive",
      profile: "default",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    },
    layout: "agent-build-shell",
    focus: true,
    initialPrompt: "Start the feature.",
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
  worktrunk: {
    enabled: true,
  },
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

class CapturingLogger implements JsonlLogger {
  readonly path = "/tmp/station/test-observer.jsonl";
  readonly records: LogRecord[] = [];

  async log(
    record: Omit<LogRecord, "timestamp" | "component"> & { timestamp?: string },
  ): Promise<LogRecord> {
    const logged: LogRecord = {
      component: "observer",
      timestamp: record.timestamp ?? now,
      level: record.level,
      message: record.message,
    };
    if (record.attributes !== undefined) logged.attributes = record.attributes;
    this.records.push(logged);
    return logged;
  }

  async debug(message: string, attributes?: Record<string, unknown>): Promise<LogRecord> {
    return this.log(logInput("debug", message, attributes));
  }

  async info(message: string, attributes?: Record<string, unknown>): Promise<LogRecord> {
    return this.log(logInput("info", message, attributes));
  }

  async warn(message: string, attributes?: Record<string, unknown>): Promise<LogRecord> {
    return this.log(logInput("warn", message, attributes));
  }

  async error(message: string, attributes?: Record<string, unknown>): Promise<LogRecord> {
    return this.log(logInput("error", message, attributes));
  }
}

function logInput(
  level: LogRecord["level"],
  message: string,
  attributes: Record<string, unknown> | undefined,
): Omit<LogRecord, "timestamp" | "component"> {
  const input: Omit<LogRecord, "timestamp" | "component"> = {
    level,
    message,
  };
  if (attributes !== undefined) input.attributes = attributes;
  return input;
}
