import { describe, expect, it } from "vitest";
import {
  classifyTransportRetention,
  robustRetentionSlope,
} from "../../scripts/test-runners/run-memory-transport-profile.mjs";

describe("transport memory profile analysis", () => {
  it("uses the median pairwise physical-footprint slope", () => {
    expect(
      robustRetentionSlope([
        { operations: 0, physicalFootprintBytes: 100 },
        { operations: 10, physicalFootprintBytes: 200 },
        { operations: 20, physicalFootprintBytes: 300 },
      ]),
    ).toBe(10);
  });

  it("requires repeatable differential growth and a material final gap", () => {
    const control = [
      { operations: 1_000, physicalFootprintBytes: 100 * 1024 * 1024 },
      { operations: 256_000, physicalFootprintBytes: 110 * 1024 * 1024 },
    ];
    const retained = [
      { operations: 1_000, physicalFootprintBytes: 120 * 1024 * 1024 },
      { operations: 256_000, physicalFootprintBytes: 520 * 1024 * 1024 },
    ];

    expect(classifyTransportRetention(control, retained)).toMatchObject({
      implicated: true,
      finalGapBytes: 410 * 1024 * 1024,
    });
    expect(classifyTransportRetention(control, control).implicated).toBe(false);
  });
});
