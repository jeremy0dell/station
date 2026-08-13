import { HarnessRunObservationSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createCodexHarnessProvider } from "../../src/provider";

const now = "2026-05-21T12:00:00.000Z";

describe("Codex discovered run status", () => {
  it("keeps terminal-only Codex evidence unknown with low confidence", async () => {
    const [run] = await discovered();
    expect(run).toMatchObject({
      provider: "codex",
      status: { value: "unknown", confidence: "low", source: "harness_process" },
    });
    expect(run?.status.reason).toContain("no reliable Codex status signal");
  });

  it("preserves reliable needs_attention hook observations in the run contract", () => {
    const run = HarnessRunObservationSchema.parse({
      id: "codex:tmux:station:@1:%2",
      provider: "codex",
      observedAt: now,
      status: {
        value: "needs_attention",
        confidence: "high",
        reason: "Codex requested permission for Bash.",
        source: "harness_event",
        updatedAt: now,
      },
    });
    expect(run.status).toMatchObject({ value: "needs_attention", source: "harness_event" });
  });

  it("normalizes persisted exited process observations", () => {
    const run = HarnessRunObservationSchema.parse({
      id: "codex:tmux:station:@1:%2",
      provider: "codex",
      state: "exited",
      confidence: "high",
      reason: "Codex process exited.",
      observedAt: now,
    });
    expect(run.status).toMatchObject({ value: "exited", confidence: "high", source: "unknown" });
  });
});

function discovered() {
  return createCodexHarnessProvider().discoverRuns({
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
          harnessProvider: "codex",
          currentCommand: "codex",
        },
      },
    ],
  });
}
