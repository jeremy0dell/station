import { z } from "zod";

export const OWNER_PROBES = Object.freeze([
  {
    id: "observer-event-bus-stalled",
    owner: "eventBus",
    sibling: "750",
    mode: "stalled-subscriber",
  },
  { id: "observer-event-bus-fast", owner: "eventBus", sibling: "750", mode: "fast-subscriber" },
  { id: "transport-stalled-peer", owner: "transport", sibling: "751", mode: "non-consuming-peer" },
  { id: "transport-fast-peer", owner: "transport", sibling: "751", mode: "consuming-peer" },
  {
    id: "client-refresh-waiters",
    owner: "client-refresh",
    sibling: "751",
    mode: "delayed-snapshot",
  },
  {
    id: "renderer-commit-retention",
    owner: "renderer",
    sibling: "752",
    mode: "fixed-graph-commits",
  },
  { id: "host-no-output-control", owner: "host", sibling: "752", mode: "no-output-pty" },
]);

export const STEPPED_COUNTS = Object.freeze([256, 1_024, 4_096, 16_384]);

const RetentionSampleSchema = z
  .object({
    operations: z.number().finite().nonnegative(),
    retainedBytes: z.number().finite().nonnegative(),
    elapsedMs: z.number().finite().nonnegative(),
  })
  .strict();

/** Returns the fixed owner-probe matrix; no provider or agent process is launched. */
export function buildOwnerProbePlan(payloadBytes = 1_024) {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes <= 0) {
    throw new Error("Owner probe payload size must be a positive safe integer.");
  }
  return OWNER_PROBES.map((probe) => ({
    ...probe,
    payloadBytes,
    counts: [...STEPPED_COUNTS],
  }));
}

/** Calculates the median pairwise slope without assuming a particular allocator curve. */
export function robustRetentionSlope(input) {
  const samples = input.map((sample) => RetentionSampleSchema.parse(sample));
  const slopes = [];
  for (let left = 0; left < samples.length; left += 1) {
    for (let right = left + 1; right < samples.length; right += 1) {
      const deltaOperations = samples[right].operations - samples[left].operations;
      if (deltaOperations > 0) {
        slopes.push((samples[right].retainedBytes - samples[left].retainedBytes) / deltaOperations);
      }
    }
  }
  if (slopes.length === 0) return 0;
  slopes.sort((left, right) => left - right);
  const middle = Math.floor(slopes.length / 2);
  return slopes.length % 2 === 0 ? (slopes[middle - 1] + slopes[middle]) / 2 : slopes[middle];
}

/** Classifies growth only when its slope clears the measured idle-noise envelope. */
export function classifyRetention(input, options = {}) {
  const samples = input.samples.map((sample) => RetentionSampleSchema.parse(sample));
  const idleSlope = options.idleSlope ?? 0;
  const tolerance = options.toleranceBytesPerOperation ?? 0;
  const slope = robustRetentionSlope(samples);
  const monotonic = slope > idleSlope + tolerance;
  return {
    slopeBytesPerOperation: slope,
    idleSlopeBytesPerOperation: idleSlope,
    toleranceBytesPerOperation: tolerance,
    classification: monotonic ? "monotonic" : "high-water-or-flat",
    samples: samples.length,
  };
}
