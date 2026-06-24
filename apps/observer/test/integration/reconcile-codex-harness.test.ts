import {
  CodexHarnessProvider,
  codexHookPayloadToHarnessEventReport,
  compactCodexHookPayload,
} from "@station/codex";
import type { StationConfig } from "@station/config";
import {
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  createObserverCore,
  type createObserverEventBus,
  ProviderRegistry,
} from "../../src/internal";
import { createTestObserver } from "../support/testObserver";

const now = "2026-05-21T12:00:00.000Z";

describe("observer reconcile with Codex harness", () => {
  it("observes a tmux-bound Codex target as a provider-neutral harness run", async () => {
    const provider = new CodexHarnessProvider({
      now: () => new Date(now),
      runner: async (input) => ({
        command: input.command,
        args: input.args ?? [],
        stdout: "Logged in with ChatGPT\n",
        stderr: "",
        exitCode: 0,
      }),
    });
    const core = createObserverCore({
      config,
      providers: new ProviderRegistry({
        worktree: new FakeWorktreeProvider({
          now,
          worktrees: [
            createFakeWorktree({
              id: "wt_web_task",
              projectId: "web",
              branch: "task",
              path: "/tmp/station/web/task",
              now,
            }),
          ],
        }),
        terminal: new FakeTerminalProvider({
          now,
          targets: [
            createFakeTerminalTarget({
              id: "tmux:station:@1:%2",
              provider: "tmux",
              projectId: "web",
              worktreeId: "wt_web_task",
              sessionId: "ses_web_task",
              now,
              harnessBinding: {
                role: "main-agent",
                harnessProvider: "codex",
                currentCommand: "codex",
              },
              providerData: {
                sessionName: "station",
                windowId: "@1",
                paneId: "%2",
              },
            }),
          ],
        }),
        harnesses: [provider],
      }),
      clock: {
        now: () => new Date(now),
      },
    });

    const snapshot = await core.reconcile("codex-terminal-binding");

    expect(snapshot.rows[0]?.agent).toMatchObject({
      harness: "codex",
      state: "unknown",
      confidence: "low",
      sessionId: "ses_web_task",
    });
    expect(snapshot.sessions[0]).toMatchObject({
      id: "ses_web_task",
      harness: {
        provider: "codex",
      },
    });
    expect(snapshot.providerHealth.codex).toMatchObject({
      status: "healthy",
    });
  });

  it("uses correlated Codex hook events to update live row state", async () => {
    const clock = { now: () => new Date(now) };
    const { sqlite, persistence, eventBus, core, api } = createTestObserver({
      config,
      providers: codexProviders(),
      clock,
    });
    const reconciled = nextObserverReconciled(eventBus);
    await core.reconcile("initial-codex-context");
    const stateEvents = eventBus
      .subscribe({ type: ["worktree.agentStateChanged", "session.updated"] })
      [Symbol.asyncIterator]();

    const compacted = compactCodexHookPayload({
      session_id: "codex_session_123",
      transcript_path: null,
      cwd: "/tmp/station/web/task/src",
      hook_event_name: "PreToolUse",
      model: "gpt-5.4-codex",
      permission_mode: "default",
      turn_id: "turn_1",
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_use_id: "call_test",
      station_worktree_id: "wt_web_task",
      station_terminal_target_id: "tmux:station:@1:%2",
    });
    const receipt = await api.reportHarnessEvent(
      codexHookPayloadToHarnessEventReport({
        reportId: "report_codex_working",
        observedAt: "2026-05-21T12:00:01.000Z",
        payload: compacted.payload,
        diagnostics: {
          payloadBytes: compacted.originalByteCount,
          compactedBytes: compacted.compactedByteCount,
          compacted: compacted.compacted,
          omittedFieldNames: compacted.omittedFieldNames,
        },
      }),
    );

    expect(receipt).toMatchObject({
      status: "accepted",
      projected: false,
      scheduledReconcile: true,
    });
    await expect(stateEvents.next()).resolves.toMatchObject({
      value: {
        type: "worktree.agentStateChanged",
        worktreeId: "wt_web_task",
        agent: expect.objectContaining({
          state: "working",
        }),
      },
    });
    await expect(stateEvents.next()).resolves.toMatchObject({
      value: {
        type: "session.updated",
        sessionId: "ses_web_task",
        patch: expect.objectContaining({
          status: expect.objectContaining({
            value: "working",
            source: "harness_event",
          }),
        }),
      },
    });
    await expect(reconciled.next).resolves.toMatchObject({
      value: { type: "observer.reconciled" },
    });
    await reconciled.close();
    await stateEvents.return?.();
    const snapshot = core.getSnapshot();
    expect(snapshot.rows[0]?.agent).toMatchObject({
      harness: "codex",
      state: "working",
      confidence: "medium",
      sessionId: "ses_web_task",
      updatedAt: "2026-05-21T12:00:01.000Z",
    });
    expect(snapshot.sessions[0]?.status).toMatchObject({
      value: "working",
      source: "harness_event",
      updatedAt: "2026-05-21T12:00:01.000Z",
    });
    expect(snapshot.rows[0]?.id).toBe("wt_web_task");
    expect(snapshot.counts).toMatchObject({
      working: 1,
      attention: 0,
      unknown: 0,
    });
    expect(await persistence.listHarnessRuns()).toEqual([
      expect.objectContaining({
        id: "codex:tmux:station:@1:%2",
        state: "working",
        confidence: "medium",
        lastSeenAt: now,
      }),
    ]);
    await expect(persistence.listProviderObservations()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "codex",
          providerType: "harness",
          entityKind: "harness_event",
          entityKey: "wt_web_task",
          payload: expect.objectContaining({
            provider: "codex",
            worktreeId: "wt_web_task",
            status: expect.objectContaining({
              value: "working",
              source: "harness_event",
            }),
          }),
        }),
      ]),
    );
    sqlite.close();
  });
});

function nextObserverReconciled(eventBus: ReturnType<typeof createObserverEventBus>) {
  const events = eventBus.subscribe({ type: "observer.reconciled" })[Symbol.asyncIterator]();
  return {
    next: events.next(),
    close: async () => {
      await events.return?.();
    },
  };
}

function codexProviders(): ProviderRegistry {
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider({
      now,
      worktrees: [
        createFakeWorktree({
          id: "wt_web_task",
          projectId: "web",
          branch: "task",
          path: "/tmp/station/web/task",
          now,
        }),
      ],
    }),
    terminal: new FakeTerminalProvider({
      now,
      targets: [
        createFakeTerminalTarget({
          id: "tmux:station:@1:%2",
          provider: "tmux",
          projectId: "web",
          worktreeId: "wt_web_task",
          sessionId: "ses_web_task",
          now,
          harnessBinding: {
            role: "main-agent",
            harnessProvider: "codex",
            currentCommand: "codex",
          },
          providerData: {
            sessionName: "station",
            windowId: "@1",
            paneId: "%2",
          },
        }),
      ],
    }),
    harnesses: [
      new CodexHarnessProvider({
        now: () => new Date(now),
        runner: async (input) => ({
          command: input.command,
          args: input.args ?? [],
          stdout: "Logged in with ChatGPT\n",
          stderr: "",
          exitCode: 0,
        }),
      }),
    ],
  });
}

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "codex",
    layout: "agent-shell",
  },
  projects: [
    {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "codex",
        terminal: "fake-terminal",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
  ],
};
