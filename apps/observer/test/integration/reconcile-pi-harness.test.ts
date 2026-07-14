import type { StationConfig } from "@station/config";
import { createPiHarnessProvider, piHookPayloadToHarnessEventReport } from "@station/pi";
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

const now = "2026-05-27T12:00:00.000Z";

describe("observer reconcile with Pi harness", () => {
  it("observes a tmux-bound Pi target as a provider-neutral harness run", async () => {
    const providers = piProviders();
    const core = createObserverCore({
      config,
      providers,
      clock: {
        now: () => new Date(now),
      },
    });

    await providers.healthCache.refreshAll();
    const snapshot = await core.reconcile("pi-terminal-binding");

    expect(snapshot.rows[0]?.agent).toMatchObject({
      harness: "pi",
      state: "unknown",
      confidence: "low",
      sessionId: "ses_web_task",
    });
    expect(snapshot.sessions[0]).toMatchObject({
      id: "ses_web_task",
      harness: {
        provider: "pi",
      },
    });
    expect(snapshot.providerHealth.pi).toMatchObject({
      status: "healthy",
    });
  });

  it("uses correlated Pi harness event reports to update live row state", async () => {
    const clock = { now: () => new Date(now) };
    const { sqlite, persistence, eventBus, core, api } = createTestObserver({
      config,
      providers: piProviders(),
      clock,
    });
    const reconciled = nextObserverReconciled(eventBus);
    await core.reconcile("initial-pi-context");
    const stateEvents = eventBus
      .subscribe({ type: ["worktree.agentStateChanged", "session.updated"] })
      [Symbol.asyncIterator]();

    const receipt = await api.reportHarnessEvent(
      piHookPayloadToHarnessEventReport({
        reportId: "report_pi_working",
        eventType: "tool_execution_start",
        observedAt: "2026-05-27T12:00:01.000Z",
        payload: {
          event_type: "tool_execution_start",
          cwd: "/tmp/station/web/task",
          pi_session_id: "pi_session_123",
          pi_session_file: "/tmp/station/pi/session.jsonl",
          tool_call_id: "toolu_1",
          tool_name: "bash",
          station_project_id: "web",
          station_worktree_id: "wt_web_task",
          station_session_id: "ses_web_task",
          station_terminal_target_id: "tmux:station:@1:%2",
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
    await expect(
      api.reportHarnessEvent(
        piHookPayloadToHarnessEventReport({
          reportId: "report_pi_done",
          eventType: "agent_end",
          observedAt: "2026-05-27T12:00:02.000Z",
          payload: {
            event_type: "agent_end",
            cwd: "/tmp/station/web/task",
            pi_session_id: "pi_session_123",
            pi_session_file: "/tmp/station/pi/session.jsonl",
            station_project_id: "web",
            station_worktree_id: "wt_web_task",
            station_session_id: "ses_web_task",
            station_terminal_target_id: "tmux:station:@1:%2",
          },
        }),
      ),
    ).resolves.toMatchObject({
      status: "accepted",
      projected: false,
      scheduledReconcile: true,
    });
    const completedSnapshot = await core.reconcile("pi-done-reconcile");
    expect(completedSnapshot.rows[0]?.agent).toMatchObject({
      harness: "pi",
      state: "idle",
      turnReadiness: {
        state: "ready_to_read",
        token: "report_pi_done",
        completedAt: "2026-05-27T12:00:02.000Z",
      },
    });
    expect(
      (await persistence.listSessionTurnReadiness()).find(
        (readiness) => readiness.sessionId === "ses_web_task",
      ),
    ).toMatchObject({
      worktreeId: "wt_web_task",
      token: "report_pi_done",
      completedAt: "2026-05-27T12:00:02.000Z",
    });
    await expect(persistence.listSessionHarnessExecutions()).resolves.toEqual([]);
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

function piProviders(): ProviderRegistry {
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
            harnessProvider: "pi",
            currentCommand: "pi",
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
      createPiHarnessProvider({
        now: () => new Date(now),
        runner: async (input) => ({
          command: input.command,
          args: input.args ?? [],
          stdout: "pi 1.2.3\n",
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
    harness: "pi",
    layout: "agent-shell",
  },
  projects: [
    {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "pi",
        terminal: "fake-terminal",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
  ],
};
