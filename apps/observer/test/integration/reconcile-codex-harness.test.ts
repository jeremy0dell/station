import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import {
  type HarnessEventReport,
  ObserverEventHookInvocationSchema,
  STATION_SCHEMA_VERSION,
} from "@station/contracts";
import { createFakeExternalCommandRunner, type ExternalCommandInput } from "@station/runtime";
import { describe, expect, it } from "vitest";
import {
  codexHookAdapter,
  codexHookPayloadToHarnessEventReport,
  compactCodexHookPayload,
  createCodexHarnessProvider,
} from "../../../../integrations/harness/codex/src/index.js";
import {
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "../../../../packages/testing/src/index.js";
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
      runner: async (input: ExternalCommandInput) => ({
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

  it("keeps the scoped owner authoritative across inherited background activity and admits a later scoped execution", async () => {
    const { sqlite, persistence, eventBus, core, api } = createTestObserver({
      config,
      providers: codexProviders(),
      clock: { now: () => new Date(now) },
    });

    try {
      await core.reconcile("initial-inherited-identity-context");
      await reportAndReconcile(
        api,
        eventBus,
        codexLifecycleReport({
          reportId: "report_owner_a_working",
          nativeSessionId: "native_a",
          event: "PreToolUse",
          observedAt: "2026-05-21T12:00:01.000Z",
        }),
      );

      const backgroundStartReport = codexBackgroundReport({
        reportId: "report_background_b_start",
        nativeSessionId: "native_b",
        event: "SessionStart",
        observedAt: "2026-05-21T12:00:02.000Z",
      });
      expect(backgroundStartReport.correlation).toEqual({
        nativeSessionId: "native_b",
        cwd: "/tmp/codex-home/.codex/memories",
      });
      expect(backgroundStartReport.diagnostics).toMatchObject({
        correlationIssue: "station_identity_cwd_mismatch",
      });
      const backgroundStart = await reportAndReconcile(api, eventBus, backgroundStartReport);
      expect(
        backgroundStart.events.filter(
          (event) =>
            (event.type === "worktree.agentStateChanged" && event.agent?.state === "starting") ||
            (event.type === "session.updated" && event.patch.status?.value === "starting"),
        ),
      ).toEqual([]);
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "working",
        updatedAt: "2026-05-21T12:00:01.000Z",
      });
      await expect(persistence.listSessionHarnessExecutions()).resolves.toEqual([
        expect.objectContaining({ nativeSessionId: "native_a", state: "working" }),
      ]);
      await expect(persistence.listSessionRecoveryHandles()).resolves.toEqual([
        expect.objectContaining({
          sessionId: "ses_web_task",
          target: { kind: "native-session", id: "native_a" },
        }),
      ]);

      await reportAndReconcile(
        api,
        eventBus,
        codexLifecycleReport({
          reportId: "report_owner_a_idle",
          nativeSessionId: "native_a",
          event: "Stop",
          observedAt: "2026-05-21T12:00:03.000Z",
        }),
      );
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "idle",
        turnReadiness: { token: "report_owner_a_idle" },
      });

      const backgroundWorking = await reportAndReconcile(
        api,
        eventBus,
        codexBackgroundReport({
          reportId: "report_background_b_working",
          nativeSessionId: "native_b",
          event: "PreToolUse",
          observedAt: "2026-05-21T12:00:04.000Z",
        }),
      );
      expect(
        backgroundWorking.events.filter(
          (event) =>
            (event.type === "worktree.agentStateChanged" && event.agent?.state === "working") ||
            (event.type === "session.updated" && event.patch.status?.value === "working"),
        ),
      ).toEqual([]);
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "idle",
        updatedAt: "2026-05-21T12:00:03.000Z",
        turnReadiness: { token: "report_owner_a_idle" },
      });
      await expect(persistence.listSessionHarnessExecutions()).resolves.toEqual([
        expect.objectContaining({ nativeSessionId: "native_a", state: "idle" }),
      ]);
      await expect(persistence.listSessionTurnReadiness()).resolves.toEqual([
        expect.objectContaining({ token: "report_owner_a_idle" }),
      ]);
      await expect(persistence.listSessionRecoveryHandles()).resolves.toEqual([
        expect.objectContaining({ target: { kind: "native-session", id: "native_a" } }),
      ]);
      await expect(
        persistence.listProviderObservations({ entityKind: "harness_event" }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              reportId: "report_background_b_working",
              nativeSessionId: "native_b",
              diagnostics: expect.objectContaining({
                correlationIssue: "station_identity_cwd_mismatch",
              }),
            }),
          }),
        ]),
      );

      await reportAndReconcile(
        api,
        eventBus,
        codexLifecycleReport({
          reportId: "report_owner_a_resumed",
          nativeSessionId: "native_a",
          event: "PreToolUse",
          observedAt: "2026-05-21T12:00:05.000Z",
        }),
      );
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "working",
        updatedAt: "2026-05-21T12:00:05.000Z",
      });
      expect(core.getSnapshot().rows[0]?.agent).not.toHaveProperty("turnReadiness");
      await expect(persistence.listSessionHarnessExecutions()).resolves.toEqual([
        expect.objectContaining({ nativeSessionId: "native_a", state: "working" }),
      ]);

      await reportAndReconcile(
        api,
        eventBus,
        codexLifecycleReport({
          reportId: "report_owner_a_final_idle",
          nativeSessionId: "native_a",
          event: "Stop",
          observedAt: "2026-05-21T12:00:06.000Z",
        }),
      );
      await reportAndReconcile(
        api,
        eventBus,
        codexLifecycleReport({
          reportId: "report_scoped_c_working",
          nativeSessionId: "native_c",
          event: "PreToolUse",
          observedAt: "2026-05-21T12:00:07.000Z",
        }),
      );
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "working",
        updatedAt: "2026-05-21T12:00:07.000Z",
      });
      await expect(persistence.listSessionHarnessExecutions()).resolves.toEqual([
        expect.objectContaining({ nativeSessionId: "native_c", state: "working" }),
      ]);
      const recoveryHandles = await persistence.listSessionRecoveryHandles();
      expect(recoveryHandles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target: { kind: "native-session", id: "native_c" } }),
        ]),
      );
      expect(
        recoveryHandles.find(
          (handle) => handle.target.kind === "native-session" && handle.target.id === "native_b",
        ),
      ).toBeUndefined();
    } finally {
      sqlite.close();
    }
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

      const activeEvidence = await reportAndReconcile(
        api,
        eventBus,
        codexLifecycleReport({
          reportId: "report_native_a_working",
          nativeSessionId: "native_a",
          event: "PreToolUse",
          observedAt: "2026-05-21T12:00:01.000Z",
        }),
      );
      await waitFor(() => reconcileProbeCalls.length === 1);
      expect(activeEvidence.receipt).toMatchObject({ projected: false });
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "working",
        reason: "Codex is about to use Bash.",
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
            (event.type === "worktree.agentStateChanged" && event.agent?.state === "idle") ||
            (event.type === "session.updated" && event.patch.status?.value === "idle"),
        ),
      ).toEqual([]);
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "working",
        reason: "Codex is about to use Bash.",
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

  it("keeps a parent Stop ready when a delayed raw SubagentStop reaches the Codex adapter", async () => {
    const clock = { now: () => new Date(now) };
    const { sqlite, persistence, eventBus, core, api } = createTestObserver({
      config,
      providers: codexProviders(),
      clock,
    });
    const stateChangeCalls: ExternalCommandInput[] = [];
    const notificationCalls: ExternalCommandInput[] = [];
    const eventHooks = createObserverEventHookRuntime({
      hooks: [
        {
          id: "state-probe",
          events: ["worktree.agentStateChanged", "session.updated"],
          command: "state-probe-bin",
        },
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
      ],
      eventBus,
      commandRunner: createFakeExternalCommandRunner((input) => {
        if (input.command === "state-probe-bin") {
          stateChangeCalls.push(input);
        } else if (input.command === "notify-bin") {
          notificationCalls.push(input);
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
      await core.reconcile("initial-delayed-subagent-stop-context");

      const working = await ingestRawHookAndWaitForReconcile(
        api,
        eventBus,
        codexRawHookEvent({
          hookId: "hook_parent_working",
          nativeSessionId: "native_parent",
          event: "PreToolUse",
          receivedAt: "2026-05-21T12:00:01.000Z",
        }),
      );
      expect(working.receipt).toMatchObject({ accepted: true, status: "ingested" });
      await waitFor(() => stateChangeCalls.length === 2);
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "working",
        updatedAt: "2026-05-21T12:00:01.000Z",
      });

      const stopped = await ingestRawHookAndWaitForReconcile(
        api,
        eventBus,
        codexRawHookEvent({
          hookId: "hook_parent_stop",
          nativeSessionId: "native_parent",
          event: "Stop",
          receivedAt: "2026-05-21T12:00:02.000Z",
        }),
      );
      expect(stopped.receipt).toMatchObject({ accepted: true, status: "ingested" });
      await waitFor(() => stateChangeCalls.length === 4 && notificationCalls.length === 1);

      const readyAgent = core.getSnapshot().rows[0]?.agent;
      expect(readyAgent).toMatchObject({
        state: "idle",
        turnReadiness: {
          state: "ready_to_read",
        },
      });
      const readinessToken = readyAgent?.turnReadiness?.token;
      expect(readinessToken).toBe("codex:native_parent:Stop:turn_1");
      expect(parseNotificationReportId(notificationCalls[0]?.stdin)).toBe(readinessToken);

      const stateChangeCount = stateChangeCalls.length;
      const notificationCount = notificationCalls.length;
      const queueBefore = (await api.health()).harnessIngressQueue;
      const reportedBefore = await persistence.listEvents({ type: "harness.eventReported" });
      const observationsBefore = await persistence.listProviderObservations({
        entityKind: "harness_event",
      });
      const executionsBefore = await persistence.listSessionHarnessExecutions();
      const reconcileEventsBefore = await persistence.listEvents({ type: "observer.reconciled" });

      const delayed = await api.ingestProviderHookEvent(
        codexRawHookEvent({
          hookId: "hook_delayed_subagent_stop",
          nativeSessionId: "native_parent",
          event: "SubagentStop",
          receivedAt: "2026-05-21T12:00:03.000Z",
        }),
      );

      expect(delayed).toMatchObject({
        accepted: false,
        status: "ignored",
        event: "SubagentStop",
      });
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "idle",
        turnReadiness: {
          state: "ready_to_read",
          token: readinessToken,
        },
      });
      expect(stateChangeCalls).toHaveLength(stateChangeCount);
      expect(notificationCalls).toHaveLength(notificationCount);
      await expect(api.health()).resolves.toMatchObject({
        harnessIngressQueue: queueBefore,
      });
      await expect(persistence.listEvents({ type: "harness.eventReported" })).resolves.toEqual(
        reportedBefore,
      );
      await expect(
        persistence.listProviderObservations({ entityKind: "harness_event" }),
      ).resolves.toEqual(observationsBefore);
      await expect(persistence.listSessionHarnessExecutions()).resolves.toEqual(executionsBefore);
      await expect(persistence.listSessionTurnReadiness()).resolves.toEqual([
        expect.objectContaining({ token: readinessToken }),
      ]);
      await expect(persistence.listEvents({ type: "observer.reconciled" })).resolves.toEqual(
        reconcileEventsBefore,
      );
      await expect(persistence.listEvents({ type: "providerHook.ingested" })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              hookId: "hook_delayed_subagent_stop",
              event: "SubagentStop",
            }),
          }),
        ]),
      );

      await api.reconcile("explicit-after-delayed-subagent-stop");

      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "idle",
        turnReadiness: {
          state: "ready_to_read",
          token: readinessToken,
        },
      });
      expect(stateChangeCalls).toHaveLength(stateChangeCount);
      expect(notificationCalls).toHaveLength(notificationCount);
      await expect(api.health()).resolves.toMatchObject({
        harnessIngressQueue: queueBefore,
      });
      await expect(persistence.listEvents({ type: "harness.eventReported" })).resolves.toEqual(
        reportedBefore,
      );
      await expect(
        persistence.listProviderObservations({ entityKind: "harness_event" }),
      ).resolves.toEqual(observationsBefore);
      await expect(persistence.listSessionHarnessExecutions()).resolves.toEqual(executionsBefore);
      await expect(persistence.listEvents({ type: "observer.reconciled" })).resolves.toHaveLength(
        reconcileEventsBefore.length + 1,
      );
      expect(notificationCalls.map((call) => parseNotificationReportId(call.stdin))).toEqual([
        readinessToken,
      ]);
    } finally {
      await eventHooks.shutdown();
      sqlite.close();
    }
  });

  it("repairs a legacy binding claimed through inherited mismatched Codex identity", async () => {
    const fixture = await persistLegacyInheritedIdentitySequence();
    const upgraded = createTestObserver({
      config,
      providers: codexProviders(),
      clock: { now: () => new Date(now) },
      sqlitePath: fixture.sqlitePath,
    });

    try {
      await upgraded.core.reconcile("first-reconcile-after-identity-corroboration-upgrade");

      expect(upgraded.core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "idle",
        updatedAt: "2026-05-21T12:00:02.000Z",
        turnReadiness: { token: "report_legacy_owner_a_idle" },
      });
      await expect(upgraded.persistence.listSessionHarnessExecutions()).resolves.toEqual([
        expect.objectContaining({
          nativeSessionId: "native_a",
          state: "idle",
          statusUpdatedAt: "2026-05-21T12:00:02.000Z",
        }),
      ]);
      await expect(upgraded.persistence.listSessionTurnReadiness()).resolves.toEqual([
        expect.objectContaining({ token: "report_legacy_owner_a_idle" }),
      ]);
      await expect(
        upgraded.persistence.listProviderObservations({ entityKind: "harness_event" }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              reportId: "report_legacy_background_b_working",
              nativeSessionId: "native_b",
            }),
          }),
        ]),
      );
    } finally {
      upgraded.sqlite.close();
      await fixture.remove();
    }
  });

  it("repairs legacy persisted SubagentStop state after an upgrade", async () => {
    const fixture = await persistLegacySubagentStopSequence();
    const clock = { now: () => new Date(now) };

    const upgraded = createTestObserver({
      config,
      providers: codexProviders(),
      clock,
      sqlitePath: fixture.sqlitePath,
    });
    try {
      await upgraded.core.reconcile("first-reconcile-after-upgrade");

      expect(upgraded.core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "idle",
        reason: "Codex turn completed.",
        turnReadiness: {
          state: "ready_to_read",
          token: "report_legacy_stop",
        },
      });
      await expect(upgraded.persistence.listSessionTurnReadiness()).resolves.toEqual([
        expect.objectContaining({ token: "report_legacy_stop" }),
      ]);
      await expect(upgraded.persistence.listSessionHarnessExecutions()).resolves.toEqual([
        expect.objectContaining({
          nativeSessionId: "native_legacy",
          state: "idle",
          statusUpdatedAt: "2026-05-21T12:00:02.000Z",
        }),
      ]);

      await reportAndReconcile(
        upgraded.api,
        upgraded.eventBus,
        codexLifecycleReport({
          reportId: "report_replacement_working",
          nativeSessionId: "native_replacement",
          event: "PreToolUse",
          observedAt: "2026-05-21T12:00:04.000Z",
        }),
      );
      expect(upgraded.core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "working",
        reason: "Codex is about to use Bash.",
      });
      await expect(upgraded.persistence.listSessionHarnessExecutions()).resolves.toEqual([
        expect.objectContaining({
          nativeSessionId: "native_replacement",
          state: "working",
        }),
      ]);
    } finally {
      upgraded.sqlite.close();
      await fixture.remove();
    }
  });

  it("does not restore legacy readiness that the user already acknowledged", async () => {
    const fixture = await persistLegacySubagentStopSequence({ acknowledge: true });
    const upgraded = createTestObserver({
      config,
      providers: codexProviders(),
      clock: { now: () => new Date(now) },
      sqlitePath: fixture.sqlitePath,
    });
    try {
      await upgraded.core.reconcile("first-reconcile-after-acknowledged-upgrade");

      expect(upgraded.core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "idle",
        reason: "Codex turn completed.",
      });
      expect(upgraded.core.getSnapshot().rows[0]?.agent).not.toHaveProperty("turnReadiness");
      await expect(upgraded.persistence.listSessionTurnReadiness()).resolves.toEqual([]);
      await expect(upgraded.persistence.listSessionHarnessExecutions()).resolves.toEqual([
        expect.objectContaining({
          nativeSessionId: "native_legacy",
          state: "idle",
        }),
      ]);
    } finally {
      upgraded.sqlite.close();
      await fixture.remove();
    }
  });

  it("clears expired legacy binding corruption before pruning its evidence", async () => {
    const fixture = await persistLegacySubagentStopSequence();
    const upgraded = createTestObserver({
      config,
      providers: codexProviders(),
      clock: { now: () => new Date("2026-07-01T12:00:00.000Z") },
      sqlitePath: fixture.sqlitePath,
    });
    try {
      await upgraded.core.reconcile("first-reconcile-after-expired-upgrade");

      expect(upgraded.core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "unknown",
      });
      await expect(upgraded.persistence.listSessionHarnessExecutions()).resolves.toEqual([]);
      await expect(upgraded.persistence.listSessionTurnReadiness()).resolves.toEqual([]);
      await expect(
        upgraded.persistence.listProviderObservations({ entityKind: "harness_event" }),
      ).resolves.toEqual([]);

      await reportAndReconcile(
        upgraded.api,
        upgraded.eventBus,
        codexLifecycleReport({
          reportId: "report_after_expired_repair",
          nativeSessionId: "native_after_expiry",
          event: "PreToolUse",
          observedAt: "2026-07-01T12:00:01.000Z",
        }),
      );
      expect(upgraded.core.getSnapshot().rows[0]?.agent).toMatchObject({
        state: "working",
        reason: "Codex is about to use Bash.",
      });
      await expect(upgraded.persistence.listSessionHarnessExecutions()).resolves.toEqual([
        expect.objectContaining({
          nativeSessionId: "native_after_expiry",
          state: "working",
        }),
      ]);
    } finally {
      upgraded.sqlite.close();
      await fixture.remove();
    }
  });

  it("preserves newer derived state when an older rejected observation expires", async () => {
    const fixture = await persistLegacySubagentStopSequence({ laterStop: true });
    const upgraded = createTestObserver({
      config,
      providers: codexProviders(),
      clock: { now: () => new Date("2026-07-01T12:00:00.000Z") },
      sqlitePath: fixture.sqlitePath,
    });
    try {
      await upgraded.core.reconcile("expired-rejected-event-with-newer-state");

      await expect(upgraded.persistence.listSessionHarnessExecutions()).resolves.toEqual([
        expect.objectContaining({
          nativeSessionId: "native_legacy",
          state: "idle",
          statusUpdatedAt: "2026-05-21T12:00:04.000Z",
        }),
      ]);
      await expect(upgraded.persistence.listSessionTurnReadiness()).resolves.toEqual([
        expect.objectContaining({ token: "report_legacy_later_stop" }),
      ]);
      await expect(
        upgraded.persistence.listProviderObservations({ entityKind: "harness_event" }),
      ).resolves.toEqual([]);
    } finally {
      upgraded.sqlite.close();
      await fixture.remove();
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
  report: HarnessEventReport,
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

function legacySubagentStopReport(input: {
  reportId: string;
  nativeSessionId: string;
  observedAt: string;
}): HarnessEventReport {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: "codex",
    kind: "harness",
    eventType: "SubagentStop",
    observedAt: input.observedAt,
    status: {
      value: "working",
      confidence: "medium",
      reason: "Codex subagent reviewer stopped.",
      source: "harness_event",
      updatedAt: input.observedAt,
    },
    correlation: {
      projectId: "web",
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      terminalTargetId: "tmux:station:@1:%2",
      nativeSessionId: input.nativeSessionId,
      cwd: "/tmp/station/web/task",
    },
    diagnostics: {
      rawEventType: "SubagentStop",
    },
    providerData: {
      codexSessionId: input.nativeSessionId,
      hookEventName: "SubagentStop",
      codexTurnId: "turn_1",
      agentId: "agent_reviewer",
      agentType: "reviewer",
    },
  };
}

function legacyInheritedIdentityReport(input: {
  reportId: string;
  nativeSessionId: string;
  observedAt: string;
}): HarnessEventReport {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: "codex",
    kind: "harness",
    eventType: "PreToolUse",
    observedAt: input.observedAt,
    status: {
      value: "working",
      confidence: "medium",
      reason: "Codex is about to use Bash.",
      source: "harness_event",
      updatedAt: input.observedAt,
    },
    correlation: {
      projectId: "web",
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      terminalTargetId: "tmux:station:@1:%2",
      nativeSessionId: input.nativeSessionId,
      cwd: "/tmp/codex-home/.codex/memories",
    },
    diagnostics: {
      rawEventType: "PreToolUse",
    },
    providerData: {
      codexSessionId: input.nativeSessionId,
      hookEventName: "PreToolUse",
      cwd: "/tmp/codex-home/.codex/memories",
      model: "gpt-5.4-codex",
      permissionMode: "default",
      codexTurnId: "turn_background",
      toolName: "Bash",
      toolUseId: `call_${input.reportId}`,
      stationProjectId: "web",
      stationWorktreeId: "wt_web_task",
      stationWorktreePath: "/tmp/station/web/task",
      stationSessionId: "ses_web_task",
      stationTerminalProvider: "tmux",
      stationTerminalTargetId: "tmux:station:@1:%2",
    },
  };
}

async function persistLegacyInheritedIdentitySequence(): Promise<{
  sqlitePath: string;
  remove: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "station-codex-inherited-identity-upgrade-"));
  const sqlitePath = join(root, "observer.sqlite");
  const legacy = createTestObserver({
    config,
    providers: codexProviders({ acceptLegacyPersistedEvents: true }),
    clock: { now: () => new Date(now) },
    sqlitePath,
    idFactory: prefixedIds("legacy_identity"),
  });

  await legacy.core.reconcile("legacy-before-identity-corroboration-upgrade");
  await reportAndReconcile(
    legacy.api,
    legacy.eventBus,
    codexLifecycleReport({
      reportId: "report_legacy_owner_a_working",
      nativeSessionId: "native_a",
      event: "PreToolUse",
      observedAt: "2026-05-21T12:00:01.000Z",
    }),
  );
  await reportAndReconcile(
    legacy.api,
    legacy.eventBus,
    codexLifecycleReport({
      reportId: "report_legacy_owner_a_idle",
      nativeSessionId: "native_a",
      event: "Stop",
      observedAt: "2026-05-21T12:00:02.000Z",
    }),
  );
  await reportAndReconcile(
    legacy.api,
    legacy.eventBus,
    legacyInheritedIdentityReport({
      reportId: "report_legacy_background_b_working",
      nativeSessionId: "native_b",
      observedAt: "2026-05-21T12:00:03.000Z",
    }),
  );

  expect(legacy.core.getSnapshot().rows[0]?.agent).toMatchObject({
    state: "working",
    updatedAt: "2026-05-21T12:00:03.000Z",
  });
  await expect(legacy.persistence.listSessionHarnessExecutions()).resolves.toEqual([
    expect.objectContaining({ nativeSessionId: "native_b", state: "working" }),
  ]);
  await expect(legacy.persistence.listSessionTurnReadiness()).resolves.toEqual([]);
  legacy.sqlite.close();
  return {
    sqlitePath,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

async function persistLegacySubagentStopSequence(
  options: { acknowledge?: boolean; laterStop?: boolean } = {},
): Promise<{ sqlitePath: string; remove: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "station-codex-upgrade-"));
  const sqlitePath = join(root, "observer.sqlite");
  const legacy = createTestObserver({
    config,
    providers: codexProviders({ acceptLegacyPersistedEvents: true }),
    clock: { now: () => new Date(now) },
    sqlitePath,
    idFactory: prefixedIds("legacy"),
  });

  await legacy.core.reconcile("legacy-before-upgrade");
  await reportAndReconcile(
    legacy.api,
    legacy.eventBus,
    codexLifecycleReport({
      reportId: "report_legacy_working",
      nativeSessionId: "native_legacy",
      event: "PreToolUse",
      observedAt: "2026-05-21T12:00:01.000Z",
    }),
  );
  await reportAndReconcile(
    legacy.api,
    legacy.eventBus,
    codexLifecycleReport({
      reportId: "report_legacy_stop",
      nativeSessionId: "native_legacy",
      event: "Stop",
      observedAt: "2026-05-21T12:00:02.000Z",
    }),
  );
  if (options.acknowledge === true) {
    await legacy.persistence.recordCommandAccepted({
      commandId: "legacy_cmd_acknowledge",
      command: {
        type: "session.acknowledgeTurn",
        payload: {
          sessionId: "ses_web_task",
          token: "report_legacy_stop",
        },
      },
      createdAt: "2026-05-21T12:00:02.500Z",
    });
    await legacy.persistence.markCommandStarted(
      "legacy_cmd_acknowledge",
      "2026-05-21T12:00:02.500Z",
    );
    await legacy.persistence.deleteSessionTurnReadiness({
      sessionId: "ses_web_task",
      token: "report_legacy_stop",
    });
    await legacy.persistence.markCommandSucceeded(
      "legacy_cmd_acknowledge",
      "2026-05-21T12:00:02.500Z",
    );
  }
  await reportAndReconcile(
    legacy.api,
    legacy.eventBus,
    legacySubagentStopReport({
      reportId: "report_legacy_subagent_stop",
      nativeSessionId: "native_legacy",
      observedAt: "2026-05-21T12:00:03.000Z",
    }),
  );
  if (options.laterStop === true) {
    await reportAndReconcile(
      legacy.api,
      legacy.eventBus,
      codexLifecycleReport({
        reportId: "report_legacy_later_stop",
        nativeSessionId: "native_legacy",
        event: "Stop",
        observedAt: "2026-05-21T12:00:04.000Z",
      }),
    );
  }

  expect(legacy.core.getSnapshot().rows[0]?.agent).toMatchObject(
    options.laterStop === true
      ? {
          state: "idle",
          reason: "Codex turn completed.",
          turnReadiness: { token: "report_legacy_later_stop" },
        }
      : {
          state: "working",
          reason: "Codex subagent reviewer stopped.",
        },
  );
  await expect(legacy.persistence.listSessionTurnReadiness()).resolves.toEqual(
    options.laterStop === true
      ? [expect.objectContaining({ token: "report_legacy_later_stop" })]
      : [],
  );
  await expect(legacy.persistence.listSessionHarnessExecutions()).resolves.toEqual([
    expect.objectContaining({
      nativeSessionId: "native_legacy",
      state: options.laterStop === true ? "idle" : "working",
      statusUpdatedAt:
        options.laterStop === true ? "2026-05-21T12:00:04.000Z" : "2026-05-21T12:00:03.000Z",
    }),
  ]);
  legacy.sqlite.close();
  return {
    sqlitePath,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

function codexBackgroundReport(input: {
  reportId: string;
  nativeSessionId: string;
  event: "SessionStart" | "PreToolUse";
  observedAt: string;
}): HarnessEventReport {
  const common = {
    session_id: input.nativeSessionId,
    transcript_path: null,
    cwd: "/tmp/codex-home/.codex/memories",
    model: "gpt-5.4-codex",
    permission_mode: "default" as const,
    station_project_id: "web",
    station_worktree_id: "wt_web_task",
    station_worktree_path: "/tmp/station/web/task",
    station_session_id: "ses_web_task",
    station_terminal_provider: "tmux",
    station_terminal_target_id: "tmux:station:@1:%2",
  };
  const payload =
    input.event === "SessionStart"
      ? {
          ...common,
          hook_event_name: "SessionStart" as const,
          source: "startup" as const,
        }
      : {
          ...common,
          hook_event_name: "PreToolUse" as const,
          turn_id: "turn_background",
          tool_name: "Bash",
          tool_input: { command: "background task" },
          tool_use_id: `call_${input.reportId}`,
        };
  return codexHookPayloadToHarnessEventReport({
    reportId: input.reportId,
    observedAt: input.observedAt,
    payload,
  });
}

function codexLifecycleReport(input: {
  reportId: string;
  nativeSessionId: string;
  event: "PreToolUse" | "Stop";
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

async function ingestRawHookAndWaitForReconcile(
  api: ReturnType<typeof createTestObserver>["api"],
  eventBus: ReturnType<typeof createObserverEventBus>,
  event: ReturnType<typeof codexRawHookEvent>,
) {
  const eventIterator = eventBus.subscribe()[Symbol.asyncIterator]();
  const receipt = await api.ingestProviderHookEvent(event);
  expect(receipt).toMatchObject({ accepted: true, status: "ingested" });
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

function codexRawHookEvent(input: {
  hookId: string;
  nativeSessionId: string;
  event: "PreToolUse" | "Stop" | "SubagentStop";
  receivedAt: string;
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
          tool_use_id: `call_${input.hookId}`,
        }
      : input.event === "Stop"
        ? {
            ...common,
            hook_event_name: "Stop",
            stop_hook_active: false,
            last_assistant_message: "Done.",
          }
        : {
            ...common,
            hook_event_name: "SubagentStop",
            agent_transcript_path: null,
            agent_id: "agent_reviewer",
            agent_type: "reviewer",
            stop_hook_active: false,
            last_assistant_message: "Reviewed.",
          };
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: input.hookId,
    provider: "codex",
    kind: "harness" as const,
    event: input.event,
    receivedAt: input.receivedAt,
    projectId: "web",
    worktreeId: "wt_web_task",
    sessionId: "ses_web_task",
    payload,
  };
}

function parseNotificationReportId(stdin: string | undefined): string | undefined {
  if (stdin === undefined) throw new Error("Expected notification invocation stdin.");
  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch (cause) {
    throw new Error("Expected notification invocation JSON.", { cause });
  }
  const invocation = ObserverEventHookInvocationSchema.safeParse(input);
  if (!invocation.success) throw new Error("Expected a valid notification invocation.");
  if (invocation.data.event.type !== "worktree.agentStateChanged") {
    throw new Error("Expected an agent-state notification invocation.");
  }
  return invocation.data.event.reportId;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}

function codexProviders(options: { acceptLegacyPersistedEvents?: boolean } = {}): ProviderRegistry {
  const codex = createCodexHarnessProvider({
    now: () => new Date(now),
    runner: async (input: ExternalCommandInput) => ({
      command: input.command,
      args: input.args ?? [],
      stdout: "Logged in with ChatGPT\n",
      stderr: "",
      exitCode: 0,
    }),
  });
  if (options.acceptLegacyPersistedEvents === true) {
    delete codex.acceptsPersistedEvent;
  }
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
    harnesses: [codex],
    hookAdapters: [codexHookAdapter],
  });
}

function prefixedIds(prefix: string) {
  let command = 0;
  let event = 0;
  let error = 0;
  let observation = 0;
  return {
    commandId: () => `${prefix}_cmd_${++command}`,
    eventId: () => `${prefix}_evt_${++event}`,
    errorId: () => `${prefix}_err_${++error}`,
    observationId: () => `${prefix}_obs_${++observation}`,
  };
}

const config: StationConfig = {
  schemaVersion: 1,
  workspace: DEFAULT_WORKSPACE_CONFIG,
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
