import type { HarnessRunObservation } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { classifyScriptedRunStatus } from "../../src/statusPolicy";

const now = "2026-05-20T12:00:10.000Z";

function run(
  providerData: Record<string, unknown>,
  overrides: Partial<HarnessRunObservation> = {},
): HarnessRunObservation {
  return {
    id: "run_web_task",
    provider: "scripted",
    projectId: "web",
    worktreeId: "wt_web_task",
    sessionId: "ses_web_task",
    state: "unknown",
    confidence: "low",
    reason: "Unclassified scripted run.",
    observedAt: now,
    providerData,
    ...overrides,
  };
}

describe("scripted status confidence policy", () => {
  it("keeps ambiguous inactivity unknown with low confidence", () => {
    const status = classifyScriptedRunStatus(run({ events: [] }), { now });

    expect(status.status).toMatchObject({
      value: "unknown",
      confidence: "low",
      reason: "Scripted run has no reliable lifecycle event.",
    });
  });

  it("treats malformed providerData as missing lifecycle history", () => {
    const status = classifyScriptedRunStatus(run({ events: "not-an-array" }), { now });

    expect(status.status).toMatchObject({
      value: "unknown",
      confidence: "low",
      reason: "Scripted run has no reliable lifecycle event.",
    });
  });

  it("classifies recent activity as working with medium confidence", () => {
    const status = classifyScriptedRunStatus(
      run({
        events: [{ type: "activity", at: now, runId: "run_web_task", message: "Editing file." }],
      }),
      { now },
    );

    expect(status.status).toMatchObject({
      value: "working",
      confidence: "medium",
      reason: "Editing file.",
    });
  });

  it("classifies reliable attention and exit signals with high confidence", () => {
    expect(
      classifyScriptedRunStatus(
        run({
          events: [{ type: "attention", at: now, runId: "run_web_task", message: "Needs input." }],
        }),
        { now },
      ).status,
    ).toMatchObject({
      value: "needs_attention",
      confidence: "high",
      reason: "Needs input.",
    });

    expect(
      classifyScriptedRunStatus(
        run({
          events: [{ type: "exit", at: now, runId: "run_web_task", exitCode: 0 }],
        }),
        { now },
      ).status,
    ).toMatchObject({
      value: "exited",
      confidence: "high",
      reason: "Scripted agent exited with code 0.",
    });
  });
});
