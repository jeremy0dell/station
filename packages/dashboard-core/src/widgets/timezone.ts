import type { TuiTimezoneWidgetConfig, TuiTimezoneZone } from "@station/config";

const INVALID_ZONE_TIME = "--:--";

/** Wall-clock time in an IANA zone, formatted like the time widget; "--:--" on an unknown zone. */
export function zoneTime(date: Date, zone: TuiTimezoneZone, timeFormat: "12h" | "24h"): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone.timeZone,
      hour: "numeric",
      minute: "2-digit",
      hourCycle: timeFormat === "24h" ? "h23" : "h12",
    }).formatToParts(date);
  } catch {
    return INVALID_ZONE_TIME;
  }
  const get = (type: Intl.DateTimeFormatPart["type"]): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const hour = get("hour");
  const minute = get("minute");
  if (hour === "" || minute === "") {
    return INVALID_ZONE_TIME;
  }
  if (timeFormat === "24h") {
    return `${hour.padStart(2, "0")}:${minute}`;
  }
  return `${hour}:${minute} ${get("dayPeriod").toUpperCase()}`;
}

export function formatTimezoneWidget(
  date: Date,
  config: TuiTimezoneWidgetConfig,
): { text: string; compact: string } {
  const timeFormat = config.timeFormat ?? "12h";
  const rendered = config.zones.map((zone) => `${zone.label} ${zoneTime(date, zone, timeFormat)}`);
  const text = rendered.join(" · ");
  // Compact keeps only the first zone — the pair's anchor.
  return { text, compact: rendered[0] ?? text };
}
