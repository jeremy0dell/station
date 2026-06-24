import type { RawHarnessEvent } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { normalizeScriptedRawEvent, parseScriptedAgentEvent } from "../../src/events";

const observedAt = "2026-05-20T12:00:00.000Z";

describe("scripted harness events", () => {
  it("maps reliable attention events to high-confidence normalized observations", () => {
    const event: RawHarnessEvent = {
      provider: "scripted",
      observedAt,
      event: {
        type: "attention",
        runId: "run_web_task",
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        at: observedAt,
        message: "Approval requested.",
      },
    };

    expect(normalizeScriptedRawEvent(event)).toEqual([
      expect.objectContaining({
        provider: "scripted",
        harnessRunId: "run_web_task",
        worktreeId: "wt_web_task",
        rawEventType: "attention",
        status: {
          value: "needs_attention",
          confidence: "high",
          reason: "Approval requested.",
          source: "harness_event",
          updatedAt: observedAt,
        },
      }),
    ]);
  });

  it("marks explicit idle completion fixture events as completed turns", () => {
    const event: RawHarnessEvent = {
      provider: "scripted",
      observedAt,
      event: {
        type: "idle",
        runId: "run_web_task",
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        at: observedAt,
        message: "Turn completed.",
        turnComplete: true,
      },
    };

    expect(normalizeScriptedRawEvent(event)).toEqual([
      expect.objectContaining({
        rawEventType: "idle",
        turn: { kind: "turn_completed" },
        status: expect.objectContaining({
          value: "idle",
          confidence: "high",
        }),
      }),
    ]);
  });

  it("keeps generic scripted idle events as plain idle", () => {
    const event: RawHarnessEvent = {
      provider: "scripted",
      observedAt,
      event: {
        type: "idle",
        runId: "run_web_task",
        at: observedAt,
      },
    };

    expect(normalizeScriptedRawEvent(event)[0]).not.toHaveProperty("turn");
  });

  it("rejects invalid raw event payloads with a typed harness error", () => {
    expect(() => parseScriptedAgentEvent({ type: "activity", at: observedAt })).toThrow(
      /HARNESS_SCRIPTED_EVENT_INVALID/,
    );
  });
});
