import { describe, expect, it } from "bun:test";
import { FLEET_STATUS_ORDER, stationAgentStatusTone } from "./statusUi.js";

describe("status UI metadata", () => {
  it("keeps fleet order and agent tones centralized", () => {
    expect(FLEET_STATUS_ORDER).toEqual([
      "ready",
      "working",
      "needsYou",
      "unknown",
      "exited",
      "idle",
      "starting",
    ]);
    expect(
      [
        "needs_attention",
        "stuck",
        "working",
        "starting",
        "idle",
        "unknown",
        "exited",
        "none",
      ].map(stationAgentStatusTone),
    ).toEqual([
      "danger",
      "danger",
      "working",
      "working",
      "success",
      "warning",
      "neutral",
      "neutral",
    ]);
  });
});
