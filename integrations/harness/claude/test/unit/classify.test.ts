import { HarnessRunObservationSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createClaudeHarnessProvider } from "../../src/provider";

const now = "2026-06-11T12:00:00.000Z";

describe("Claude discovered run status", () => {
  it("keeps terminal-only Claude evidence unknown with low confidence", async () => {
    const [run] = await discovered();
    expect(run).toMatchObject({
      provider: "claude",
      status: { value: "unknown", confidence: "low", source: "harness_process" },
    });
    expect(run?.status.reason).toContain("no reliable Claude status signal");
  });

  it("preserves reliable needs_attention hook observations in the run contract", () => {
    const run = HarnessRunObservationSchema.parse({
      id: "claude:tmux:station:@1:%2",
      provider: "claude",
      observedAt: now,
      status: {
        value: "needs_attention",
        confidence: "high",
        reason: "Claude Code requested permission for Bash.",
        source: "harness_event",
        updatedAt: now,
      },
    });
    expect(run.status).toMatchObject({ value: "needs_attention", source: "harness_event" });
  });

  it("normalizes persisted exited process observations", () => {
    const run = HarnessRunObservationSchema.parse({
      id: "claude:tmux:station:@1:%2",
      provider: "claude",
      state: "exited",
      confidence: "high",
      reason: "Claude Code process exited.",
      observedAt: now,
    });
    expect(run.status).toMatchObject({ value: "exited", confidence: "high", source: "unknown" });
  });
});

function discovered() {
  return createClaudeHarnessProvider().discoverRuns({
    projects: [],
    worktrees: [],
    terminalTargets: [
      {
        id: "tmux:station:@1:%2",
        provider: "tmux",
        state: "open",
        observedAt: now,
        harnessBinding: {
          role: "main-agent",
          harnessProvider: "claude",
          currentCommand: "claude",
        },
      },
    ],
  });
}
