import { type RuntimeClock, systemClock, toIsoTimestamp } from "@station/runtime";

export function nowIso(clock?: RuntimeClock | undefined): string {
  return toIsoTimestamp((clock ?? systemClock).now());
}

export function addMs(timestamp: string, ms: number): string {
  return new Date(Date.parse(timestamp) + ms).toISOString();
}

export function addDays(timestamp: string, days: number): string {
  return addMs(timestamp, days * 24 * 60 * 60 * 1000);
}
