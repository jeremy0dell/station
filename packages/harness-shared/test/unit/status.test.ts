import { describe, expect, it } from "vitest";
import { harnessEventStatus } from "../../src/status";

const now = "2026-05-27T12:00:00.000Z";

describe("harnessEventStatus", () => {
  it("defaults the source to harness_event and omits attention", () => {
    expect(harnessEventStatus("working", "medium", "Editing file.", now)).toEqual({
      value: "working",
      confidence: "medium",
      reason: "Editing file.",
      source: "harness_event",
      updatedAt: now,
    });
  });

  it("carries an explicit source for process-derived and unknown-provenance statuses", () => {
    expect(
      harnessEventStatus("exited", "high", "Agent exited.", now, {
        source: "harness_process",
      }),
    ).toMatchObject({ source: "harness_process" });
    expect(
      harnessEventStatus("unknown", "low", "Stale activity.", now, { source: "unknown" }),
    ).toMatchObject({ source: "unknown" });
  });

  it("sets attention only when the caller supplies a kind", () => {
    const attention = harnessEventStatus("needs_attention", "high", "Approve?", now, {
      attention: "tool_approval",
    });

    expect(attention.attention).toBe("tool_approval");
    expect(harnessEventStatus("idle", "high", "Idle.", now)).not.toHaveProperty("attention");
  });
});
