import { describe, expect, it } from "vitest";
import {
  classifyTransportRetention,
  robustRetentionSlope,
  transportStayedBounded,
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

  it("accepts only repeated overflow closure within the configured transport bounds", () => {
    const cell = {
      status: "overflow-closed",
      transportLimits: { maxQueuedFrames: 1_024, maxQueuedBytes: 4 * 1024 * 1024 },
      transportDiagnostics: {
        inboundQueueDepth: 0,
        inboundQueueBytes: 0,
        inboundHighWaterDepth: 1_024,
        inboundHighWaterBytes: 4 * 1024 * 1024,
        outboundBackpressureCount: 0,
        overflowCount: 1,
        closeCount: 1,
      },
    };
    const control = {
      status: "complete",
      transportDiagnostics: {
        inboundQueueDepth: 0,
        inboundQueueBytes: 0,
        outboundBackpressureCount: 0,
        overflowCount: 0,
        closeCount: 1,
      },
    };

    expect(transportStayedBounded([control], [cell], 1)).toBe(true);
    expect(
      transportStayedBounded(
        [control],
        [
          {
            ...cell,
            transportDiagnostics: { ...cell.transportDiagnostics, inboundQueueBytes: 1 },
          },
        ],
        1,
      ),
    ).toBe(false);
    expect(
      transportStayedBounded(
        [
          {
            ...control,
            transportDiagnostics: { ...control.transportDiagnostics, overflowCount: 1 },
          },
        ],
        [cell],
        1,
      ),
    ).toBe(false);
    expect(transportStayedBounded([control], [{ ...cell, status: "complete" }], 1)).toBe(false);
    expect(transportStayedBounded([control], [cell], 2)).toBe(false);
  });
});
