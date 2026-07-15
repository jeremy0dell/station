import type { StationConfig } from "@station/config";
import { ObserverEventHookInvocationSchema } from "@station/contracts";
import {
  createCursorHarnessProvider,
  cursorProviderHookPayloadToHarnessEventReport,
} from "@station/cursor";
import { createFakeExternalCommandRunner, type ExternalCommandInput } from "@station/runtime";
import {
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { createObserverEventHookRuntime, ProviderRegistry } from "../../src/internal";
import { createTestObserver } from "../support/testObserver";

const now = "2026-07-14T12:00:00.000Z";

describe("observer reconcile with Cursor harness", () => {
  it("keeps foreign Stops diagnostic and notifies once for the bound native execution", async () => {
    const clock = { now: () => new Date(now) };
    const { sqlite, persistence, eventBus, core, api } = createTestObserver({
      config,
      providers: cursorProviders(),
      clock,
    });
    const notificationCalls: ExternalCommandInput[] = [];
    const reconcileProbeCalls: ExternalCommandInput[] = [];
    const eventHooks = createObserverEventHookRuntime({
      hooks: [
        {
          id: "notify-cursor-idle",
          events: ["worktree.agentStateChanged"],
          command: "notify-bin",
          filter: { agentState: "idle", harness: "cursor" },
        },
        {
          id: "reconcile-probe",
          events: ["observer.reconciled"],
          command: "probe-bin",
        },
      ],
      eventBus,
      commandRunner: createFakeExternalCommandRunner((input) => {
        if (input.command === "notify-bin") notificationCalls.push(input);
        else reconcileProbeCalls.push(input);
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
      await core.reconcile("initial-cursor-context");

      await reportAndReconcile(
        api,
        eventBus,
        cursorReport({
          reportId: "report_cursor_a_working",
          nativeSessionId: "cursor_a",
          event: "preToolUse",
          observedAt: "2026-07-14T12:00:01.000Z",
        }),
      );
      await waitFor(() => reconcileProbeCalls.length === 1);
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
        harness: "cursor",
        state: "working",
      });
      await expect(persistence.listSessionHarnessExecutions()).resolves.toEqual([
        expect.objectContaining({ nativeSessionId: "cursor_a", state: "working" }),
      ]);

      await reportAndReconcile(
        api,
        eventBus,
        cursorReport({
          reportId: "report_cursor_b_stop",
          nativeSessionId: "cursor_b",
          event: "stop",
          observedAt: "2026-07-14T12:00:02.000Z",
        }),
      );
      await waitFor(() => reconcileProbeCalls.length === 2);
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({ state: "working" });
      await expect(persistence.listSessionTurnReadiness()).resolves.toEqual([]);
      expect(notificationCalls).toHaveLength(0);

      await reportAndReconcile(
        api,
        eventBus,
        cursorReport({
          reportId: "report_cursor_a_stop",
          nativeSessionId: "cursor_a",
          event: "stop",
          observedAt: "2026-07-14T12:00:03.000Z",
        }),
      );
      await waitFor(() => reconcileProbeCalls.length === 3);
      await waitFor(() => notificationCalls.length === 1);
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({ state: "idle" });
      expect(core.getSnapshot().rows[0]?.agent).not.toHaveProperty("turnReadiness");
      await expect(persistence.listSessionTurnReadiness()).resolves.toEqual([]);
      expect(parseNotificationReportId(notificationCalls[0]?.stdin)).toBe("report_cursor_a_stop");

      await reportAndReconcile(
        api,
        eventBus,
        cursorReport({
          reportId: "report_cursor_a_new_work",
          nativeSessionId: "cursor_a",
          event: "preToolUse",
          observedAt: "2026-07-14T12:00:04.000Z",
        }),
      );
      await waitFor(() => reconcileProbeCalls.length === 4);
      expect(core.getSnapshot().rows[0]?.agent).toMatchObject({ state: "working" });
      expect(notificationCalls).toHaveLength(1);
    } finally {
      await eventHooks.shutdown();
      sqlite.close();
    }
  });
});

async function reportAndReconcile(
  api: ReturnType<typeof createTestObserver>["api"],
  eventBus: ReturnType<typeof createTestObserver>["eventBus"],
  report: ReturnType<typeof cursorProviderHookPayloadToHarnessEventReport>,
) {
  const events = eventBus.subscribe()[Symbol.asyncIterator]();
  const receipt = await api.reportHarnessEvent(report);
  expect(receipt).toMatchObject({ accepted: true, status: "accepted" });
  while (true) {
    const next = await events.next();
    if (next.done) throw new Error("Event subscription ended before reconcile.");
    if (next.value.type === "observer.reconciled") break;
  }
  await events.return?.();
}

function cursorReport(input: {
  reportId: string;
  nativeSessionId: string;
  event: "preToolUse" | "stop";
  observedAt: string;
}) {
  const common = {
    hook_event_name: input.event,
    session_id: input.nativeSessionId,
    cwd: "/tmp/station/web/task",
    station_project_id: "web",
    station_worktree_id: "wt_web_task",
    station_worktree_path: "/tmp/station/web/task",
    station_session_id: "ses_web_task",
    station_terminal_provider: "tmux",
    station_terminal_target_id: "tmux:station:@1:%2",
  };
  return cursorProviderHookPayloadToHarnessEventReport({
    reportId: input.reportId,
    observedAt: input.observedAt,
    payload:
      input.event === "stop"
        ? { ...common, status: "completed" }
        : { ...common, tool_name: "Bash", tool_use_id: `tool_${input.reportId}` },
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

function cursorProviders(): ProviderRegistry {
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
            harnessProvider: "cursor",
            currentCommand: "agent",
          },
        }),
      ],
    }),
    harnesses: [
      createCursorHarnessProvider({
        now: () => new Date(now),
        runner: async (input) => ({
          command: input.command,
          args: input.args ?? [],
          stdout: "2026.1.0\n",
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
    harness: "cursor",
    layout: "agent-shell",
  },
  projects: [
    {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "cursor",
        terminal: "fake-terminal",
        layout: "agent-shell",
      },
      worktrunk: { enabled: true },
    },
  ],
};
