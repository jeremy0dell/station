import type { ObservabilityRetentionConfig } from "@station/config";
import { mergeRetentionPolicy } from "@station/observability";
import { addDays } from "../utils/time.js";

export function providerObservationRetentionDays(retention?: ObservabilityRetentionConfig): number {
  return mergeRetentionPolicy(retention).sqlite.providerObservationsMaxDays;
}

export function providerObservationExpiresAt(observedAt: string, days: number): string {
  return addDays(observedAt, days);
}
