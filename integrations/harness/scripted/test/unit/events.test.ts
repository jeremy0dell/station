import { describe, expect, it } from "vitest";
import { parseScriptedAgentEvent, statusFromScriptedEvent } from "../../src/events";

const observedAt = "2026-05-20T12:00:00.000Z";

describe("scripted harness events", () => {
  it("maps reliable attention events to high-confidence normalized observations", () => {
    const event = parseScriptedAgentEvent({
      type: "attention",
      runId: "run_web_task",
      projectId: "web",
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      at: observedAt,
      message: "Approval requested.",
    });

    expect(statusFromScriptedEvent(event)).toEqual({
      value: "needs_attention",
      confidence: "high",
      reason: "Approval requested.",
      source: "harness_event",
      updatedAt: observedAt,
    });
  });

  it("marks explicit idle completion fixture events as completed turns", () => {
    const event = parseScriptedAgentEvent({
      type: "idle",
      runId: "run_web_task",
      projectId: "web",
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      at: observedAt,
      message: "Turn completed.",
      turnComplete: true,
    });

    expect(event.turnComplete).toBe(true);
    expect(statusFromScriptedEvent(event)).toMatchObject({ value: "idle", confidence: "high" });
  });

  it("keeps generic scripted idle events as plain idle", () => {
    const event = parseScriptedAgentEvent({
      type: "idle",
      runId: "run_web_task",
      at: observedAt,
    });

    expect(event).not.toHaveProperty("turnComplete");
    expect(statusFromScriptedEvent(event)).toMatchObject({ value: "idle", confidence: "high" });
  });

  it("rejects invalid raw event payloads with a typed harness error", () => {
    expect(() => parseScriptedAgentEvent({ type: "activity", at: observedAt })).toThrow(
      /HARNESS_SCRIPTED_EVENT_INVALID/,
    );
  });
});
