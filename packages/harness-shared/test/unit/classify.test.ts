import { HarnessRunObservationSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";

const now = "2026-06-11T12:00:00.000Z";

describe("discovered harness status", () => {
  it("keeps a current typed attention status", () => {
    expect(
      current({ value: "needs_attention", confidence: "high", reason: "blocked" }).status,
    ).toMatchObject({ value: "needs_attention", confidence: "high", reason: "blocked" });
  });

  it("normalizes a legacy high-confidence attention state", () => {
    expect(legacy("needs_attention", "high", "blocked").status).toMatchObject({
      value: "needs_attention",
      confidence: "high",
      reason: "blocked",
      source: "unknown",
    });
  });

  it("normalizes a legacy exited state without inventing a source", () => {
    expect(legacy("exited", "high", "done").status).toMatchObject({
      value: "exited",
      confidence: "high",
      reason: "done",
      source: "unknown",
    });
  });

  it("preserves explicit status sources", () => {
    expect(current({ value: "exited", confidence: "high", reason: "done" }).status.source).toBe(
      "harness_event",
    );
  });

  it("keeps unknown discovery status provider-owned", () => {
    expect(current().status).toMatchObject({
      value: "unknown",
      confidence: "low",
      reason: "no reliable signal",
      source: "harness_event",
    });
  });

  it("keeps optional identity and provider data on legacy normalization", () => {
    const run = HarnessRunObservationSchema.parse({
      id: "run-1",
      provider: "claude",
      projectId: "web",
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      state: "unknown",
      confidence: "low",
      reason: "fallback",
      observedAt: now,
      providerData: { terminalTargetId: "tmux:1" },
    });
    expect(run).toMatchObject({
      projectId: "web",
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      providerData: { terminalTargetId: "tmux:1" },
    });
  });

  it("rejects fields outside both strict run formats", () => {
    expect(HarnessRunObservationSchema.safeParse({ ...current(), extra: true }).success).toBe(
      false,
    );
  });
});

function current(
  status = { value: "unknown" as const, confidence: "low" as const, reason: "no reliable signal" },
) {
  return HarnessRunObservationSchema.parse({
    id: "run-1",
    provider: "claude",
    observedAt: now,
    status: {
      ...status,
      source: "harness_event",
      updatedAt: now,
    },
  });
}

function legacy(value: string, confidence: string, reason: string) {
  return HarnessRunObservationSchema.parse({
    id: "run-1",
    provider: "claude",
    state: value,
    confidence,
    reason,
    observedAt: now,
  });
}
