import { HarnessEventObservationSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  codexAppServerEventToHarnessEventObservation,
  parseCodexAppServerEvent,
  statusFromCodexAppServerEvent,
} from "../../src/appServer";
import { CodexHarnessProviderError } from "../../src/errors";

const now = "2026-06-17T12:00:00.000Z";

describe("Codex app-server event parsing", () => {
  it("maps a completed proposed plan to plan approval attention", () => {
    expect(
      codexAppServerEventToHarnessEventObservation(
        {
          method: "item/plan/delta",
          params: {
            threadId: "thr_plan",
            turnId: "turn_1",
            itemId: "item_plan_1",
            delta: "1. Inspect the code.",
          },
        },
        context(),
      ),
    ).toEqual([]);

    const event = parseCodexAppServerEvent({
      method: "item/completed",
      params: {
        threadId: "thr_plan",
        turnId: "turn_1",
        completedAtMs: 1781712000000,
        item: {
          type: "plan",
          id: "item_plan_1",
          text: "1. Inspect the code.\n2. Patch the mapper.",
        },
      },
    });

    expect(event).toMatchObject({
      kind: "item-completed",
      itemType: "plan",
    });
    expect(statusFromCodexAppServerEvent(event, now)).toMatchObject({
      value: "needs_attention",
      confidence: "high",
      reason: "Codex proposed a plan.",
      attention: "plan_approval",
    });

    const observations = codexAppServerEventToHarnessEventObservation(
      {
        method: "item/completed",
        params: {
          threadId: "thr_plan",
          turnId: "turn_1",
          completedAtMs: 1781712000000,
          item: {
            type: "plan",
            id: "item_plan_1",
            text: "Plan text must stay provider-local.",
          },
        },
      },
      context(),
    );

    expect(observations).toHaveLength(1);
    expect(HarnessEventObservationSchema.parse(observations[0])).toEqual(observations[0]);
    expect(observations[0]).toMatchObject({
      provider: "codex",
      sessionId: "ses_web_task",
      worktreeId: "wt_web_task",
      harnessRunId: "codex:app-server:thr_plan",
      nativeSessionId: "thr_plan",
      rawEventType: "item/completed",
      status: {
        value: "needs_attention",
        source: "harness_event",
        attention: "plan_approval",
      },
      providerData: {
        transport: "app-server",
        appServerMethod: "item/completed",
        codexThreadId: "thr_plan",
        codexTurnId: "turn_1",
        codexItemId: "item_plan_1",
        itemType: "plan",
      },
    });
    expect(JSON.stringify(observations[0]?.providerData)).not.toContain("Plan text");
  });

  it("maps thread approval and user-input flags to needs_attention", () => {
    const approvalObservation = codexAppServerEventToHarnessEventObservation(
      {
        method: "thread/status/changed",
        params: {
          threadId: "thr_approval",
          status: {
            type: "active",
            activeFlags: ["waitingOnApproval"],
          },
        },
      },
      context(),
    )[0];

    expect(approvalObservation).toMatchObject({
      status: {
        value: "needs_attention",
        reason: "Codex is waiting for approval.",
      },
      providerData: {
        threadStatusType: "active",
        activeFlags: ["waitingOnApproval"],
      },
    });

    const userInputObservation = codexAppServerEventToHarnessEventObservation(
      {
        method: "thread/status/changed",
        params: {
          threadId: "thr_input",
          status: {
            type: "active",
            activeFlags: ["waitingOnUserInput"],
          },
        },
      },
      context(),
    )[0];

    expect(userInputObservation).toMatchObject({
      status: {
        value: "needs_attention",
        reason: "Codex is waiting for user input.",
      },
    });
  });

  it("maps App Server request messages to needs_attention", () => {
    const observations = codexAppServerEventToHarnessEventObservation(
      {
        method: "item/tool/requestUserInput",
        id: 42,
        params: {
          threadId: "thr_input",
          turnId: "turn_1",
          itemId: "item_tool_1",
          questions: [],
          autoResolutionMs: null,
        },
      },
      context(),
    );

    expect(observations[0]).toMatchObject({
      status: {
        value: "needs_attention",
        reason: "Codex requested user input.",
      },
      providerData: {
        requestId: 42,
        codexThreadId: "thr_input",
        codexTurnId: "turn_1",
        codexItemId: "item_tool_1",
      },
    });
  });

  it("does not emit progress or ordinary completion events", () => {
    expect(
      codexAppServerEventToHarnessEventObservation(
        {
          method: "turn/plan/updated",
          params: {
            threadId: "thr_progress",
            turnId: "turn_1",
            explanation: null,
            plan: [
              { step: "Inspect the mapper", status: "completed" },
              { step: "Write the test", status: "inProgress" },
            ],
          },
        },
        context(),
      ),
    ).toEqual([]);
    expect(
      codexAppServerEventToHarnessEventObservation(
        {
          method: "item/completed",
          params: {
            threadId: "thr_progress",
            turnId: "turn_1",
            completedAtMs: 1781712000000,
            item: {
              type: "agentMessage",
              id: "item_message_1",
              text: "Done.",
            },
          },
        },
        context(),
      ),
    ).toEqual([]);
    expect(
      codexAppServerEventToHarnessEventObservation(
        {
          method: "turn/completed",
          params: {
            threadId: "thr_done",
            turn: {
              id: "turn_1",
              status: "completed",
              items: [],
              itemsView: "full",
              error: null,
              startedAt: 1781712000,
              completedAt: 1781712002,
              durationMs: 2000,
            },
          },
        },
        context(),
      ),
    ).toEqual([]);
    expect(
      codexAppServerEventToHarnessEventObservation(
        {
          method: "thread/status/changed",
          params: {
            threadId: "thr_active",
            status: {
              type: "active",
              activeFlags: [],
            },
          },
        },
        context(),
      ),
    ).toEqual([]);
    expect(
      codexAppServerEventToHarnessEventObservation(
        {
          method: "thread/status/changed",
          params: {
            threadId: "thr_done",
            status: {
              type: "idle",
            },
          },
        },
        context(),
      ),
    ).toEqual([]);
  });

  it("maps interrupted and failed turn completion without emitting normal idle noise", () => {
    const interruptedObservation = codexAppServerEventToHarnessEventObservation(
      {
        method: "turn/completed",
        params: {
          threadId: "thr_interrupted",
          turn: {
            id: "turn_1",
            status: "interrupted",
            items: [],
            itemsView: "full",
            error: null,
            startedAt: 1781712000,
            completedAt: 1781712001,
            durationMs: 1000,
          },
        },
      },
      context(),
    )[0];

    const failedObservation = codexAppServerEventToHarnessEventObservation(
      {
        method: "turn/completed",
        params: {
          threadId: "thr_failed",
          turn: {
            id: "turn_2",
            status: "failed",
            items: [],
            itemsView: "full",
            error: null,
            startedAt: 1781712000,
            completedAt: 1781712001,
            durationMs: 1000,
          },
        },
      },
      context(),
    )[0];

    expect(interruptedObservation?.status).toMatchObject({
      value: "idle",
      reason: "Codex turn was interrupted.",
    });
    expect(failedObservation?.status).toMatchObject({
      value: "stuck",
      reason: "Codex turn failed.",
    });
  });

  it("ignores unsupported app-server notifications", () => {
    expect(
      codexAppServerEventToHarnessEventObservation(
        {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thr_1",
            turnId: "turn_1",
            itemId: "item_message_1",
            delta: "hello",
          },
        },
        context(),
      ),
    ).toEqual([]);
  });

  it("throws typed provider errors for invalid supported messages", () => {
    expect(() =>
      parseCodexAppServerEvent({
        method: "thread/status/changed",
        params: {
          status: {
            type: "active",
            activeFlags: [],
          },
        },
      }),
    ).toThrowError(CodexHarnessProviderError);
  });
});

function context() {
  return {
    observedAt: now,
    projectId: "web",
    worktreeId: "wt_web_task",
    sessionId: "ses_web_task",
    cwd: "/tmp/station/web/task",
  };
}
