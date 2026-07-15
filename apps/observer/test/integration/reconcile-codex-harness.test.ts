import {
  codexHookPayloadToHarnessEventReport,
  compactCodexHookPayload,
  createCodexHarnessProvider,
} from "@station/codex";
import type { StationConfig } from "@station/config";
import { ObserverEventHookInvocationSchema } from "@station/contracts";
import { createFakeExternalCommandRunner, type ExternalCommandInput } from "@station/runtime";
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
  createObserverEventHookRuntime,
  ProviderRegistry,
} from "../../src/internal";
import { createTestObserver } from "../support/testObserver";

const now = "2026-05-21T12:00:00.000Z";

describe("observer reconcile with Codex harness", () => {
  it("observes a tmux-bound Codex target as a provider-neutral harness run", async () => {
    const provider = createCodexHarnessProvider({
      now: () => new Date(now),
      runner: async (input) => ({
        command: input.command,
        args: input.args ?? [],
        stdout: "Logged in with ChatGPT\n",
        stderr: "",
        exitCode: 0,
      }),
    });
    const providers = new ProviderRegistry({
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
    });
    const core = createObserverCore({
      config,
      providers,
      clock: {
        now: () => new Date(now),
      },
    });

    await providers.healthCache.refreshAll();
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
    await expect(persistence.listProviderObservations()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "codex",
          providerType: "harness",
          entityKind: "harness_event",
          entityKey: "ses_web_task",
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

  it("keeps cross-native Stop evidence from changing readiness or firing completion", async () => {
    const clock = { now: () => new Date(now) };
    const { sqlite, persistence, eventBus, core, api } = createTestObserver({
      config,
      providers: codexProviders(),
      clock,
    });
    const notificationCalls: ExternalCommandInput[] = [];
    const reconcileProbeCalls: ExternalCommandInput[] = [];
    const eventHooks = createObserverEventHookRuntime({
      hooks: [
        {
          id: "notify-agent-state",
          events: ["worktree.agentStateChanged"],
          command: "notify-bin",
          args: ["agent-state"],
          timeoutMs: 1000,
          filter: {
            agentState: "idle",
            harness: "codex",
          },
        },
        {
          id: "reconcile-probe",
          events: ["observer.reconciled"],
          command: "probe-bin",
        },
      ],
      eventBus,
      commandRunner: createFakeExternalCommandRunner((input) => {
        if (input.command === "notify-bin") {
          notificationCalls.push(input);
        } else {
          reconcileProbeCalls.push(input);
        }
        return {
          command: input.command,
          args: input.args ?? [],
          stdout: "",
          stderr: "",
          exitCode: 0,
        };
      }),
    });

    try {
      await core.reconcile("initial-native-codex-context");

      const subagentStop = await reportAndReconcile(
        api,
        eventBus,
        codexLifecycleReport({
          reportId: "report_native_a_subagent_stop",
          nativeSessionId: "native_a",
          event: "SubagentStop",
          observedAt: "2026-05-21T12:00:01.000Z",
        }),
      );
      await waitFor(() => reconcileProbeCalls.length === 1);
      expect(subagentStop.receipt).toMatchObject({ projected: false });
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "working",
        reason: "Codex subagent reviewer stopped.",
        updatedAt: "2026-05-21T12:00:01.000Z",
      });
      await expect(persistence.listSessionTurnReadiness()).resolves.toEqual([]);
      await expect(persistence.listSessionHarnessExecutions()).resolves.toEqual([
        expect.objectContaining({
          provider: "codex",
          sessionId: "ses_web_task",
          nativeSessionId: "native_a",
          state: "working",
        }),
      ]);

      const foreignStop = await reportAndReconcile(
        api,
        eventBus,
        codexLifecycleReport({
          reportId: "report_native_b_stop",
          nativeSessionId: "native_b",
          event: "Stop",
          observedAt: "2026-05-21T12:00:02.000Z",
        }),
      );
      await waitFor(() => reconcileProbeCalls.length === 2);
      expect(foreignStop.receipt).toMatchObject({ projected: false });
      expect(
        foreignStop.events.filter(
          (event) =>
            (event.type === "worktree.agentStateChanged" && event.agent.state === "idle") ||
            (event.type === "session.updated" && event.patch.status?.value === "idle"),
        ),
      ).toEqual([]);
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "working",
        reason: "Codex subagent reviewer stopped.",
        updatedAt: "2026-05-21T12:00:01.000Z",
      });
      expect(core.getSnapshot().sessions[0]?.status).toMatchObject({
        value: "working",
        updatedAt: "2026-05-21T12:00:01.000Z",
      });
      expect(core.getSnapshot().rows[0]?.agent).not.toHaveProperty("turnReadiness");
      await expect(persistence.listSessionTurnReadiness()).resolves.toEqual([]);
      await expect(persistence.listSessionHarnessExecutions()).resolves.toEqual([
        expect.objectContaining({
          nativeSessionId: "native_a",
          state: "working",
          statusUpdatedAt: "2026-05-21T12:00:01.000Z",
        }),
      ]);
      await expect(persistence.listSessionRecoveryHandles()).resolves.toEqual([
        expect.objectContaining({
          sessionId: "ses_web_task",
          target: { kind: "native-session", id: "native_a" },
        }),
      ]);
      expect(notificationCalls).toHaveLength(0);
      await expect(persistence.listProviderObservations()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entityKind: "harness_event",
            payload: expect.objectContaining({
              reportId: "report_native_b_stop",
              nativeSessionId: "native_b",
              status: expect.objectContaining({ value: "idle" }),
            }),
          }),
        ]),
      );

      const continuation = await reportAndReconcile(
        api,
        eventBus,
        codexLifecycleReport({
          reportId: "report_native_a_continues",
          nativeSessionId: "native_a",
          event: "PreToolUse",
          observedAt: "2026-05-21T12:00:03.000Z",
        }),
      );
      await waitFor(() => reconcileProbeCalls.length === 3);
      expect(continuation.receipt).toMatchObject({ projected: false });
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "working",
        reason: "Codex is about to use Bash.",
        updatedAt: "2026-05-21T12:00:03.000Z",
      });
      expect(core.getSnapshot().rows[0]?.agent).not.toHaveProperty("turnReadiness");
      await expect(persistence.listSessionTurnReadiness()).resolves.toEqual([]);
      expect(notificationCalls).toHaveLength(0);

      const legitimateStop = codexLifecycleReport({
        reportId: "report_native_a_stop",
        nativeSessionId: "native_a",
        event: "Stop",
        observedAt: "2026-05-21T12:00:04.000Z",
      });
      await reportAndReconcile(api, eventBus, legitimateStop);
      await waitFor(() => reconcileProbeCalls.length === 4);
      await waitFor(() => notificationCalls.length === 1);
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "idle",
        turnReadiness: {
          state: "ready_to_read",
          token: "report_native_a_stop",
        },
      });
      expect(parseNotificationReportId(notificationCalls[0]?.stdin)).toBe("report_native_a_stop");

      await expect(api.reportHarnessEvent(legitimateStop)).resolves.toMatchObject({
        accepted: true,
        deduped: true,
        projected: false,
        scheduledReconcile: false,
      });
      await expect(persistence.listSessionTurnReadiness()).resolves.toEqual([
        expect.objectContaining({ token: "report_native_a_stop" }),
      ]);
      expect(notificationCalls.map((call) => parseNotificationReportId(call.stdin))).toEqual([
        "report_native_a_stop",
      ]);

      await reportAndReconcile(
        api,
        eventBus,
        codexLifecycleReport({
          reportId: "report_native_a_new_turn",
          nativeSessionId: "native_a",
          event: "PreToolUse",
          observedAt: "2026-05-21T12:00:05.000Z",
        }),
      );
      await waitFor(() => reconcileProbeCalls.length === 5);
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "working",
        updatedAt: "2026-05-21T12:00:05.000Z",
      });
      expect(core.getSnapshot().rows[0]?.agent).not.toHaveProperty("turnReadiness");
      await expect(persistence.listSessionTurnReadiness()).resolves.toEqual([]);
      expect(notificationCalls).toHaveLength(1);

      await reportAndReconcile(
        api,
        eventBus,
        codexLifecycleReport({
          reportId: "report_native_a_active_stop",
          nativeSessionId: "native_a",
          event: "Stop",
          stopHookActive: true,
          observedAt: "2026-05-21T12:00:06.000Z",
        }),
      );
      await waitFor(() => reconcileProbeCalls.length === 6);
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "working",
        reason: "A Stop hook kept Codex working.",
        updatedAt: "2026-05-21T12:00:06.000Z",
      });
      expect(core.getSnapshot().rows[0]?.agent).not.toHaveProperty("turnReadiness");
      await expect(persistence.listSessionTurnReadiness()).resolves.toEqual([]);
      await expect(persistence.listSessionHarnessExecutions()).resolves.toEqual([
        expect.objectContaining({ nativeSessionId: "native_a", state: "working" }),
      ]);
      expect(notificationCalls).toHaveLength(1);
    } finally {
      await eventHooks.shutdown();
      sqlite.close();
    }
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

async function reportAndReconcile(
  api: ReturnType<typeof createTestObserver>["api"],
  eventBus: ReturnType<typeof createObserverEventBus>,
  report: ReturnType<typeof codexHookPayloadToHarnessEventReport>,
) {
  const eventIterator = eventBus.subscribe()[Symbol.asyncIterator]();
  const receipt = await api.reportHarnessEvent(report);
  expect(receipt).toMatchObject({ accepted: true, status: "accepted" });
  const events = [];
  while (true) {
    const next = await eventIterator.next();
    if (next.done) throw new Error("Event subscription ended before reconcile.");
    events.push(next.value);
    if (next.value.type === "observer.reconciled") break;
  }
  await eventIterator.return?.();
  return { receipt, events };
}

function codexLifecycleReport(input: {
  reportId: string;
  nativeSessionId: string;
  event: "PreToolUse" | "SubagentStop" | "Stop";
  stopHookActive?: boolean;
  observedAt: string;
}) {
  const common = {
    session_id: input.nativeSessionId,
    transcript_path: null,
    cwd: "/tmp/station/web/task",
    model: "gpt-5.4-codex",
    permission_mode: "default",
    turn_id: "turn_1",
    station_project_id: "web",
    station_worktree_id: "wt_web_task",
    station_worktree_path: "/tmp/station/web/task",
    station_session_id: "ses_web_task",
    station_terminal_provider: "tmux",
    station_terminal_target_id: "tmux:station:@1:%2",
  };
  const payload =
    input.event === "PreToolUse"
      ? {
          ...common,
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
          tool_use_id: `call_${input.reportId}`,
        }
      : input.event === "SubagentStop"
        ? {
            ...common,
            hook_event_name: "SubagentStop",
            agent_transcript_path: null,
            agent_id: "agent_reviewer",
            agent_type: "reviewer",
            stop_hook_active: false,
            last_assistant_message: "Reviewed.",
          }
        : {
            ...common,
            hook_event_name: "Stop",
            stop_hook_active: input.stopHookActive ?? false,
            last_assistant_message: "Done.",
          };
  return codexHookPayloadToHarnessEventReport({
    reportId: input.reportId,
    observedAt: input.observedAt,
    payload,
  });
}

function parseNotificationReportId(stdin: string | undefined): string | undefined {
  if (stdin === undefined) throw new Error("Expected notification invocation stdin.");
  return ObserverEventHookInvocationSchema.parse(JSON.parse(stdin)).event.reportId;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
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
      createCodexHarnessProvider({
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
