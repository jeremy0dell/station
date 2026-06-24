import type { HarnessRunObservation } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { classifyHarnessRunStatus } from "../../src/classify";

const now = "2026-06-11T12:00:00.000Z";

describe("classifyHarnessRunStatus", () => {
  it("classifies high-confidence needs_attention as a harness event", () => {
    const status = classifyHarnessRunStatus(
      run({ state: "needs_attention", confidence: "high", reason: "blocked" }),
      { provider: "claude", fallbackReason: "fallback" },
    );

    expect(status).toMatchObject({
      provider: "claude",
      runId: "run-1",
      status: {
        value: "needs_attention",
        confidence: "high",
        reason: "blocked",
        source: "harness_event",
      },
    });
  });

  it("classifies high-confidence exited with the default process source", () => {
    const status = classifyHarnessRunStatus(
      run({ state: "exited", confidence: "high", reason: "done" }),
      { provider: "codex", fallbackReason: "fallback" },
    );

    expect(status.status).toMatchObject({
      value: "exited",
      confidence: "high",
      reason: "done",
      source: "harness_process",
    });
  });

  it("can override the exited source", () => {
    const status = classifyHarnessRunStatus(
      run({ state: "exited", confidence: "high", reason: "done" }),
      { provider: "cursor", fallbackReason: "fallback", exitedSource: "harness_event" },
    );

    expect(status.status.source).toBe("harness_event");
  });

  it("can skip needs_attention classification", () => {
    const status = classifyHarnessRunStatus(
      run({ state: "needs_attention", confidence: "high", reason: "blocked" }),
      { provider: "pi", fallbackReason: "no signal", needsAttention: false },
    );

    expect(status.status.value).toBe("unknown");
    expect(status.status.reason).toBe("no signal");
  });

  it("falls back to unknown with the provider-specific reason", () => {
    const status = classifyHarnessRunStatus(run(), {
      provider: "opencode",
      fallbackReason: "no reliable signal",
    });

    expect(status.status).toMatchObject({
      value: "unknown",
      confidence: "low",
      reason: "no reliable signal",
      source: "harness_process",
    });
  });

  it("copies optional identity fields and providerData when present", () => {
    const status = classifyHarnessRunStatus(
      run({
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        providerData: { terminalTargetId: "tmux:1" },
      }),
      { provider: "claude", fallbackReason: "fallback" },
    );

    expect(status.projectId).toBe("web");
    expect(status.worktreeId).toBe("wt_web_task");
    expect(status.sessionId).toBe("ses_web_task");
    expect(status.providerData).toEqual({ terminalTargetId: "tmux:1" });
  });

  it("omits optional fields when they are absent", () => {
    const status = classifyHarnessRunStatus(
      run({
        projectId: undefined,
        worktreeId: undefined,
        sessionId: undefined,
        providerData: undefined,
      }),
      { provider: "claude", fallbackReason: "fallback" },
    );

    expect(status).not.toHaveProperty("projectId");
    expect(status).not.toHaveProperty("worktreeId");
    expect(status).not.toHaveProperty("sessionId");
    expect(status).not.toHaveProperty("providerData");
  });
});

function run(overrides: Partial<HarnessRunObservation> = {}): HarnessRunObservation {
  return {
    id: "run-1",
    provider: "claude",
    state: "unknown",
    confidence: "low",
    reason: "no signal yet",
    observedAt: now,
    ...overrides,
  };
}
