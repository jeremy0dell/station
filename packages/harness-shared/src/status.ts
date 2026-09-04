import type { ObservedStatus } from "@station/contracts";

/** Every caller normalizes a hook event, so `source` is fixed. A provider deriving status from
 * process state instead must build its own literal. */
export function harnessEventStatus(
  value: ObservedStatus["value"],
  confidence: ObservedStatus["confidence"],
  reason: string,
  updatedAt: string,
  extra: { attention?: NonNullable<ObservedStatus["attention"]> } = {},
): ObservedStatus {
  const status: ObservedStatus = {
    value,
    confidence,
    reason,
    source: "harness_event",
    updatedAt,
  };
  if (extra.attention !== undefined) {
    status.attention = extra.attention;
  }
  return status;
}
