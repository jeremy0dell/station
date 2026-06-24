import type {
  ObserverEventHookConfig,
  ObserverEventHookInvocation,
  StationEvent,
  StationSnapshot,
} from "@station/contracts";
import { ObserverEventHookInvocationSchema, STATION_SCHEMA_VERSION } from "@station/contracts";
import { createFakeExternalCommandRunner, type ExternalCommandInput } from "@station/runtime";
import { describe, expect, it } from "vitest";
import {
  createObserverEventHookRuntime,
  observerEventHookMatches,
} from "../../src/hooks/observerEventHooks";
import { agentStateChangedEventsFromReconcile } from "../../src/runtime/api";
import { createObserverEventBus } from "../../src/runtime/eventBus";

describe("observer event hooks", () => {
  it("matches event type and agent state filters", () => {
    const hook = notifyIdleHook();

    expect(observerEventHookMatches(hook, agentEvent("idle"))).toBe(true);
    expect(observerEventHookMatches(hook, agentEvent("working"))).toBe(false);
    expect(observerEventHookMatches(hook, { type: "observer.started", at: now })).toBe(false);
  });

  it("matches hook-reported Codex Stop filters", () => {
    const hook = notifyCodexStopHook();

    expect(observerEventHookMatches(hook, hookReportedStopEvent())).toBe(true);
    expect(
      observerEventHookMatches(hook, {
        ...hookReportedStopEvent(),
        changeSource: "reconcile",
      }),
    ).toBe(false);
    expect(
      observerEventHookMatches(hook, {
        ...hookReportedStopEvent(),
        harnessEventType: "PermissionRequest",
      }),
    ).toBe(false);
  });

  it("runs matching hooks with invocation JSON on stdin", async () => {
    const eventBus = createObserverEventBus();
    const calls: ExternalCommandInput[] = [];
    const runtime = createObserverEventHookRuntime({
      hooks: [notifyIdleHook()],
      eventBus,
      commandRunner: createFakeExternalCommandRunner((input) => {
        calls.push(input);
        return {
          command: input.command,
          args: input.args ?? [],
          stdout: "",
          stderr: "",
          exitCode: 0,
        };
      }),
    });

    eventBus.publish(agentEvent("working"));
    eventBus.publish(agentEvent("idle"));
    await waitFor(() => calls.length === 1);
    await runtime.shutdown();

    expect(calls[0]).toMatchObject({
      command: "notify-bin",
      args: ["turn-completion"],
      timeoutMs: 1000,
    });
    const invocation = parseInvocation(calls[0]?.stdin);
    expect(invocation).toMatchObject({
      hookId: "notify-agent-idle",
      event: {
        type: "worktree.agentStateChanged",
        agent: {
          state: "idle",
          harness: "codex",
        },
      },
    });
  });

  it("isolates hook command failures from event publication", async () => {
    const eventBus = createObserverEventBus();
    let calls = 0;
    const runtime = createObserverEventHookRuntime({
      hooks: [notifyIdleHook()],
      eventBus,
      commandRunner: createFakeExternalCommandRunner(() => {
        calls += 1;
        throw new Error("boom");
      }),
    });

    expect(() => eventBus.publish(agentEvent("idle"))).not.toThrow();
    await waitFor(() => calls === 1);
    await runtime.shutdown();
  });

  it("derives reconcile events only for concrete agent state transitions", () => {
    const idle = snapshot([row("idle", now, "Codex turn completed.")]);
    const idleRefresh = snapshot([row("idle", "2026-06-01T12:00:01.000Z", "Codex is idle.")]);
    const working = snapshot([row("working", "2026-06-01T12:00:02.000Z", "Codex is working.")]);
    const noAgentRow = row("idle", now, "Codex turn completed.");
    delete noAgentRow.agent;
    const noAgent = snapshot([noAgentRow]);

    expect(agentStateChangedEventsFromReconcile(snapshot([]), idle)).toEqual([]);
    expect(agentStateChangedEventsFromReconcile(idle, idleRefresh)).toEqual([]);
    expect(agentStateChangedEventsFromReconcile(idle, noAgent)).toEqual([
      {
        type: "worktree.agentStateChanged",
        worktreeId: "wt_web_task",
        changeSource: "reconcile",
      },
    ]);
    expect(agentStateChangedEventsFromReconcile(working, idle)).toMatchObject([
      {
        type: "worktree.agentStateChanged",
        worktreeId: "wt_web_task",
        changeSource: "reconcile",
        agent: {
          state: "idle",
          harness: "codex",
        },
      },
    ]);
  });
});

const now = "2026-06-01T12:00:00.000Z";

function notifyIdleHook(): ObserverEventHookConfig {
  return {
    id: "notify-agent-idle",
    events: ["worktree.agentStateChanged"],
    command: "notify-bin",
    args: ["turn-completion"],
    timeoutMs: 1000,
    filter: {
      agentState: "idle",
      harness: "codex",
    },
  };
}

function notifyCodexStopHook(): ObserverEventHookConfig {
  return {
    ...notifyIdleHook(),
    filter: {
      agentState: "idle",
      harness: "codex",
      changeSource: "harness_event_report",
      harnessEventType: "Stop",
    },
  };
}

function agentEvent(state: "idle" | "working"): StationEvent {
  return {
    type: "worktree.agentStateChanged",
    worktreeId: "wt_web_task",
    agent: {
      harness: "codex",
      state,
      confidence: "high",
      reason: state === "idle" ? "Codex turn completed." : "Codex is working.",
      updatedAt: now,
    },
  };
}

function hookReportedStopEvent(): StationEvent {
  return {
    ...agentEvent("idle"),
    changeSource: "harness_event_report",
    harnessEventType: "Stop",
    reportId: "report_codex_stop",
  };
}

function snapshot(rows: StationSnapshot["rows"]): StationSnapshot {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    generatedAt: now,
    observer: {
      pid: 123,
      startedAt: now,
      version: "0.0.0",
      healthy: true,
    },
    providerHealth: {},
    projects: [],
    rows,
    sessions: [],
    counts: {
      projects: 0,
      worktrees: rows.length,
      agents: rows.filter((candidate) => candidate.agent !== undefined).length,
      working: rows.filter((candidate) => candidate.agent?.state === "working").length,
      idle: rows.filter((candidate) => candidate.agent?.state === "idle").length,
      attention: 0,
      unknown: 0,
    },
    alerts: [],
  };
}

function row(
  state: NonNullable<StationSnapshot["rows"][number]["agent"]>["state"],
  updatedAt: string,
  reason: string,
): StationSnapshot["rows"][number] {
  return {
    id: "wt_web_task",
    projectId: "web",
    projectLabel: "web",
    branch: "task",
    path: "/tmp/station/web/task",
    worktree: {
      state: "exists",
      source: "station",
    },
    agent: {
      harness: "codex",
      state,
      confidence: "high",
      reason,
      updatedAt,
    },
    display: {
      statusLabel: state === "idle" ? "idle" : "working",
      sortPriority: 1,
      alert: false,
    },
  };
}

function parseInvocation(source: string | undefined): ObserverEventHookInvocation {
  if (source === undefined) {
    throw new Error("Expected invocation stdin.");
  }
  return ObserverEventHookInvocationSchema.parse(JSON.parse(source));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}
