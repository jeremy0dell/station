import {
  ClaudeHarnessProvider,
  claudeHookPayloadToHarnessEventReport,
  compactClaudeHookPayload,
} from "@station/claude";
import type { StationConfig } from "@station/config";
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

const now = "2026-06-11T12:00:00.000Z";

describe("observer reconcile with Claude harness", () => {
  it("observes a tmux-bound Claude target as a provider-neutral harness run", async () => {
    const core = createObserverCore({
      config,
      providers: claudeProviders(),
      clock: {
        now: () => new Date(now),
      },
    });

    const snapshot = await core.reconcile("claude-terminal-binding");

    expect(snapshot.rows[0]?.agent).toMatchObject({
      harness: "claude",
      state: "unknown",
      confidence: "low",
      sessionId: "ses_web_task",
    });
    expect(snapshot.sessions[0]).toMatchObject({
      id: "ses_web_task",
      harness: {
        provider: "claude",
      },
    });
    expect(snapshot.providerHealth.claude).toMatchObject({
      status: "healthy",
    });
  });

  it("uses claude hook event reports to update live row state", async () => {
    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ clock });
    const persistence = createObserverPersistence({
      sqlite,
      clock,
      idFactory: ids(),
    });
    const eventBus = createObserverEventBus();
    const providers = claudeProviders();
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
    await core.reconcile("initial-claude-context");

    const working = await api.reportHarnessEvent(
      claudeReport("report_claude_working", "2026-06-11T12:00:01.000Z", {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
        tool_use_id: "toolu_1",
      }),
    );
    expect(working).toMatchObject({ status: "accepted", scheduledReconcile: true });

    let snapshot = await core.reconcile("claude-working");
    expect(snapshot.rows[0]?.agent).toMatchObject({
      harness: "claude",
      state: "working",
      confidence: "medium",
      sessionId: "ses_web_task",
    });

    await api.reportHarnessEvent(
      claudeReport("report_claude_permission", "2026-06-11T12:00:02.000Z", {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "curl https://example.com" },
      }),
    );
    snapshot = await core.reconcile("claude-permission");
    expect(snapshot.rows[0]?.agent).toMatchObject({
      state: "needs_attention",
      confidence: "high",
    });

    await api.reportHarnessEvent(
      claudeReport("report_claude_idle", "2026-06-11T12:00:03.000Z", {
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: "Done.",
      }),
    );
    snapshot = await core.reconcile("claude-idle");
    expect(snapshot.rows[0]?.agent).toMatchObject({
      state: "idle",
      confidence: "high",
    });
    expect(snapshot.sessions[0]?.status).toMatchObject({
      value: "idle",
      source: "harness_event",
      updatedAt: "2026-06-11T12:00:03.000Z",
    });

    // /clear emits SessionEnd(reason: "clear") immediately followed by a fresh
    // SessionStart; the clear must not flip the row to exited.
    await api.reportHarnessEvent(
      claudeReport("report_claude_clear", "2026-06-11T12:00:04.000Z", {
        hook_event_name: "SessionEnd",
        reason: "clear",
      }),
    );
    snapshot = await core.reconcile("claude-clear");
    expect(snapshot.rows[0]?.agent).toMatchObject({
      state: "idle",
    });

    await api.reportHarnessEvent(
      claudeReport("report_claude_exit", "2026-06-11T12:00:05.000Z", {
        hook_event_name: "SessionEnd",
        reason: "prompt_input_exit",
      }),
    );
    snapshot = await core.reconcile("claude-exit");
    expect(snapshot.rows[0]?.agent).toMatchObject({
      state: "exited",
      confidence: "high",
    });

    await expect(persistence.listProviderObservations()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "claude",
          providerType: "harness",
          entityKind: "harness_event",
          entityKey: "claude:tmux:station:@1:%2",
          payload: expect.objectContaining({
            provider: "claude",
            worktreeId: "wt_web_task",
            nativeSessionId: "claude_session_123",
          }),
        }),
      ]),
    );
    sqlite.close();
  });
});

function claudeReport(reportId: string, observedAt: string, fields: Record<string, unknown>) {
  const compacted = compactClaudeHookPayload({
    session_id: "claude_session_123",
    transcript_path: "/home/user/.claude/projects/-tmp-station-web-task/claude_session_123.jsonl",
    cwd: "/tmp/station/web/task",
    permission_mode: "default",
    station_project_id: "web",
    station_worktree_id: "wt_web_task",
    station_session_id: "ses_web_task",
    station_terminal_target_id: "tmux:station:@1:%2",
    ...fields,
  });
  return claudeHookPayloadToHarnessEventReport({
    reportId,
    observedAt,
    payload: compacted.payload,
    diagnostics: {
      payloadBytes: compacted.originalByteCount,
      compactedBytes: compacted.compactedByteCount,
      compacted: compacted.compacted,
      omittedFieldNames: compacted.omittedFieldNames,
    },
  });
}

function claudeProviders(): ProviderRegistry {
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
            harnessProvider: "claude",
            currentCommand: "claude",
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
      new ClaudeHarnessProvider({
        now: () => new Date(now),
        runner: async (input) => ({
          command: input.command,
          args: input.args ?? [],
          stdout: "2.1.173 (Claude Code)\n",
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
    harness: "claude",
    layout: "agent-shell",
  },
  projects: [
    {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "claude",
        terminal: "fake-terminal",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
  ],
};
