import type { TerminalFocusContext, TerminalProvider } from "@station/contracts";
import {
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  createObserverCore,
  createTerminalCloseHandler,
  createTerminalFocusHandler,
  createTerminalIntentRunner,
  ProviderRegistry,
} from "../../src/internal";

const now = "2026-05-21T12:00:00.000Z";

describe("observer terminal commands", () => {
  it("focuses a target resolved from worktreeId without exposing tmux details", async () => {
    const focused: string[] = [];
    const focusContexts: Array<TerminalFocusContext | undefined> = [];
    const terminal = new RecordingTerminalProvider({
      id: "tmux",
      now,
      targets: [
        createFakeTerminalTarget({
          id: "tmux:station:@1:%2",
          provider: "tmux",
          projectId: "web",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
          now,
          providerData: {
            sessionName: "station",
            windowId: "@1",
            paneId: "%2",
          },
        }),
      ],
      focused,
      focusContexts,
    });
    const core = createObserverCore({
      config,
      providers: new ProviderRegistry({
        worktree: new FakeWorktreeProvider({
          now,
          worktrees: [
            createFakeWorktree({
              id: "wt_web_feature",
              projectId: "web",
              branch: "feature",
              now,
            }),
          ],
        }),
        terminal,
        harnesses: [new FakeHarnessProvider({ now })],
      }),
      clock: { now: () => new Date(now) },
    });

    await core.reconcile("terminal-focus-test");
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: "wt_web_feature",
            projectId: "web",
            branch: "feature",
            now,
          }),
        ],
      }),
      terminal,
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const handler = createTerminalFocusHandler({
      core,
      providers,
      terminalIntentRunner: terminalIntentRunnerFor(providers),
    });

    await handler({
      commandId: "cmd_1",
      trace: { traceId: "trc_1", spanId: "spn_1", operation: "command.terminal.focus" },
      command: {
        type: "terminal.focus",
        payload: {
          worktreeId: "wt_web_feature",
          origin: {
            provider: "tmux",
            clientId: "client_1",
          },
        },
      },
      signal: new AbortController().signal,
    });

    expect(focused).toEqual(["tmux:station:@1:%2"]);
    expect(focusContexts).toEqual([
      {
        origin: {
          provider: "tmux",
          clientId: "client_1",
        },
      },
    ]);
  });

  it("throws a safe terminal provider error when the target cannot be resolved", async () => {
    const terminal = new RecordingTerminalProvider({ id: "tmux", now, targets: [], focused: [] });
    const core = createObserverCore({
      config,
      providers: new ProviderRegistry({
        worktree: new FakeWorktreeProvider({ now }),
        terminal,
        harnesses: [new FakeHarnessProvider({ now })],
      }),
      clock: { now: () => new Date(now) },
    });
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ now }),
      terminal,
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const handler = createTerminalFocusHandler({
      core,
      providers,
      terminalIntentRunner: terminalIntentRunnerFor(providers),
    });

    await expect(
      handler({
        commandId: "cmd_1",
        trace: { traceId: "trc_1", spanId: "spn_1", operation: "command.terminal.focus" },
        command: {
          type: "terminal.focus",
          payload: {
            worktreeId: "wt_missing",
          },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      tag: "TerminalProviderError",
      code: "TERMINAL_TARGET_MISSING",
      message: "No terminal is open for this worktree.",
      hint: "Start an agent or open this worktree from station before focusing it.",
      provider: "tmux",
      worktreeId: "wt_missing",
    });
  });

  it("closes a target resolved from worktreeId through the terminal provider contract", async () => {
    const closed: string[] = [];
    const terminal = new RecordingTerminalProvider({
      id: "tmux",
      now,
      targets: [
        createFakeTerminalTarget({
          id: "tmux:station:@1:%2",
          provider: "tmux",
          projectId: "web",
          worktreeId: "wt_web_feature",
          now,
        }),
      ],
      focused: [],
      closed,
    });
    const core = createObserverCore({
      config,
      providers: new ProviderRegistry({
        worktree: new FakeWorktreeProvider({
          now,
          worktrees: [
            createFakeWorktree({
              id: "wt_web_feature",
              projectId: "web",
              branch: "feature",
              now,
            }),
          ],
        }),
        terminal,
        harnesses: [new FakeHarnessProvider({ now })],
      }),
      clock: { now: () => new Date(now) },
    });

    await core.reconcile("terminal-close-test");
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: "wt_web_feature",
            projectId: "web",
            branch: "feature",
            now,
          }),
        ],
      }),
      terminal,
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const handler = createTerminalCloseHandler({
      core,
      providers,
      terminalIntentRunner: terminalIntentRunnerFor(providers),
    });

    await handler({
      commandId: "cmd_1",
      trace: { traceId: "trc_1", spanId: "spn_1", operation: "command.terminal.close" },
      command: {
        type: "terminal.close",
        payload: {
          worktreeId: "wt_web_feature",
        },
      },
      signal: new AbortController().signal,
    });

    expect(closed).toEqual(["tmux:station:@1:%2"]);
  });

  it("preserves close provider errors as SafeErrors", async () => {
    const terminal = new RecordingTerminalProvider({
      id: "tmux",
      now,
      targets: [
        createFakeTerminalTarget({
          id: "tmux:station:@1:%2",
          provider: "tmux",
          projectId: "web",
          worktreeId: "wt_web_feature",
          now,
        }),
      ],
      focused: [],
      closed: [],
      failures: {
        closeTarget: {
          tag: "TerminalProviderError",
          code: "TERMINAL_TARGET_MISSING",
          message: "The terminal target no longer exists.",
          hint: "Refresh the dashboard or reopen the worktree.",
          provider: "tmux",
        },
      },
    });
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: "wt_web_feature",
            projectId: "web",
            branch: "feature",
            now,
          }),
        ],
      }),
      terminal,
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const core = createObserverCore({
      config,
      providers,
      clock: { now: () => new Date(now) },
    });
    await core.reconcile("terminal-close-failure-test");
    const handler = createTerminalCloseHandler({
      core,
      providers,
      terminalIntentRunner: terminalIntentRunnerFor(providers),
    });

    await expect(
      handler({
        commandId: "cmd_1",
        trace: { traceId: "trc_1", spanId: "spn_1", operation: "command.terminal.close" },
        command: {
          type: "terminal.close",
          payload: {
            worktreeId: "wt_web_feature",
          },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      tag: "TerminalProviderError",
      code: "TERMINAL_TARGET_MISSING",
      provider: "tmux",
    });
  });
});

function terminalIntentRunnerFor(providers: ProviderRegistry) {
  return createTerminalIntentRunner({
    providers: {
      terminals: providers.terminals,
      harnesses: providers.harnesses,
    },
  });
}

class RecordingTerminalProvider extends FakeTerminalProvider implements TerminalProvider {
  readonly #focused: string[];
  readonly #focusContexts: Array<TerminalFocusContext | undefined>;
  readonly #closed: string[];

  constructor(
    options: ConstructorParameters<typeof FakeTerminalProvider>[0] & {
      focused: string[];
      focusContexts?: Array<TerminalFocusContext | undefined>;
      closed?: string[];
    },
  ) {
    super(options);
    this.#focused = options.focused;
    this.#focusContexts = options.focusContexts ?? [];
    this.#closed = options.closed ?? [];
  }

  override async focusTarget(targetId: string, context?: TerminalFocusContext): Promise<void> {
    await super.focusTarget(targetId);
    this.#focused.push(targetId);
    this.#focusContexts.push(context);
  }

  override async closeTarget(targetId: string): Promise<void> {
    await super.closeTarget(targetId);
    this.#closed.push(targetId);
  }
}

const config = {
  schemaVersion: 1 as const,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "tmux",
    harness: "fake-harness",
    layout: "agent-shell",
  },
  projects: [
    {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "fake-harness",
        terminal: "tmux",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
  ],
};
