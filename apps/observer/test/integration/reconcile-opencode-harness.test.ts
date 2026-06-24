import type { StationConfig } from "@station/config";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { OpenCodeHarnessProvider } from "@station/opencode";
import {
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  createCommandQueue,
  createObserverApi,
  createObserverCore,
  createObserverEventBus,
  createObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
} from "../../src/internal";

const now = "2026-05-20T12:00:00.000Z";

describe("observer reconcile with OpenCode harness", () => {
  it("observes a tmux-bound OpenCode target as a provider-neutral harness run", async () => {
    const core = createObserverCore({
      config,
      providers: opencodeProviders(),
      clock: {
        now: () => new Date(now),
      },
    });

    const snapshot = await core.reconcile("opencode-terminal-binding");

    expect(snapshot.rows[0]?.agent).toMatchObject({
      harness: "opencode",
      state: "unknown",
      confidence: "low",
      sessionId: "ses_web_task",
    });
    expect(snapshot.sessions[0]).toMatchObject({
      id: "ses_web_task",
      harness: {
        provider: "opencode",
      },
    });
    expect(snapshot.providerHealth.opencode).toMatchObject({
      status: "healthy",
    });
  });

  it("uses correlated OpenCode plugin hook events to update live row state", async () => {
    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ clock });
    const persistence = createObserverPersistence({
      sqlite,
      clock,
      idFactory: ids(),
    });
    const eventBus = createObserverEventBus();
    const providers = opencodeProviders();
    const core = createObserverCore({
      config,
      providers,
      persistence,
      sqlite,
      clock,
    });
    const api = createObserverApi({
      core,
      providers,
      persistence,
      commandQueue: createCommandQueue({ persistence, clock, idFactory: ids(), eventBus }),
      eventBus,
      clock,
      config,
      hookReconcileDebounceMs: 0,
    });
    await core.reconcile("initial-opencode-context");

    const receipt = await api.ingestProviderHookEvent({
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: "hook_opencode_busy",
      provider: "opencode",
      kind: "harness",
      event: "session.status",
      receivedAt: "2026-05-20T12:00:01.000Z",
      projectId: "web",
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      payload: {
        event_type: "session.status",
        cwd: "/tmp/station/web/task",
        opencode_session_id: "opencode_session_123",
        status_type: "busy",
        station_project_id: "web",
        station_worktree_id: "wt_web_task",
        station_session_id: "ses_web_task",
        station_terminal_target_id: "tmux:station:@1:%2",
      },
    });

    expect(receipt).toMatchObject({
      status: "ingested",
      accepted: true,
    });
    const snapshot = await core.reconcile("opencode-hook-event");
    expect(snapshot.rows[0]?.agent).toMatchObject({
      harness: "opencode",
      state: "working",
      confidence: "high",
      sessionId: "ses_web_task",
      updatedAt: "2026-05-20T12:00:01.000Z",
    });
    expect(snapshot.sessions[0]?.status).toMatchObject({
      value: "working",
      source: "harness_event",
      updatedAt: "2026-05-20T12:00:01.000Z",
    });
    const stateEvents = eventBus
      .subscribe({ type: "worktree.agentStateChanged" })
      [Symbol.asyncIterator]();
    await api.ingestProviderHookEvent({
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: "hook_opencode_idle",
      provider: "opencode",
      kind: "harness",
      event: "session.status",
      receivedAt: "2026-05-20T12:00:02.000Z",
      projectId: "web",
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      payload: {
        event_type: "session.status",
        cwd: "/tmp/station/web/task",
        opencode_session_id: "opencode_session_123",
        status_type: "idle",
        station_project_id: "web",
        station_worktree_id: "wt_web_task",
        station_session_id: "ses_web_task",
        station_terminal_target_id: "tmux:station:@1:%2",
      },
    });
    await api.reconcile("opencode-idle-reconcile");
    await expect(stateEvents.next()).resolves.toMatchObject({
      value: {
        type: "worktree.agentStateChanged",
        worktreeId: "wt_web_task",
        agent: expect.objectContaining({
          harness: "opencode",
          state: "idle",
          reason: "OpenCode session status is idle.",
        }),
      },
    });
    await expect(persistence.listProviderObservations()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "opencode",
          providerType: "harness",
          entityKind: "harness_event",
          entityKey: "opencode:tmux:station:@1:%2",
          payload: expect.objectContaining({
            provider: "opencode",
            worktreeId: "wt_web_task",
            nativeSessionId: "opencode_session_123",
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

function opencodeProviders(): ProviderRegistry {
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
            harnessProvider: "opencode",
            currentCommand: "opencode",
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
      new OpenCodeHarnessProvider({
        now: () => new Date(now),
        runner: async (input) => ({
          command: input.command,
          args: input.args ?? [],
          stdout: "1.15.12\n",
          stderr: "",
          exitCode: 0,
        }),
      }),
    ],
  });
}

function ids() {
  let command = 0;
  let event = 0;
  let observation = 0;
  let breadcrumb = 0;
  return {
    commandId: () => `cmd_${++command}`,
    eventId: () => `evt_${++event}`,
    observationId: () => `obs_${++observation}`,
    breadcrumbId: () => `crumb_${++breadcrumb}`,
  };
}

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "opencode",
    layout: "agent-shell",
  },
  projects: [
    {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "opencode",
        terminal: "fake-terminal",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
  ],
};
