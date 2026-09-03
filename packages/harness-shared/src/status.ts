import type { ObservedStatus } from "@station/contracts";

export type HarnessEventStatusExtra = {
  attention?: NonNullable<ObservedStatus["attention"]>;
  source?: ObservedStatus["source"];
};

/** `source` defaults to harness_event, so process-derived and unknown-provenance statuses
 * must pass `extra.source` explicitly. */
export function harnessEventStatus(
  value: ObservedStatus["value"],
  confidence: ObservedStatus["confidence"],
  reason: string,
  updatedAt: string,
  extra: HarnessEventStatusExtra = {},
): ObservedStatus {
  const status: ObservedStatus = {
    value,
    confidence,
    reason,
    source: extra.source ?? "harness_event",
    updatedAt,
  };
  if (extra.attention !== undefined) {
    status.attention = extra.attention;
  }
  return status;
}
