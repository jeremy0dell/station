import type { TuiTimeWidgetConfig } from "@station/config";

export function formatTimeWidget(date: Date, config: TuiTimeWidgetConfig): string {
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");

  if ((config.timeFormat ?? "12h") === "24h") {
    return `${String(hours).padStart(2, "0")}:${minutes}`;
  }

  const period = hours < 12 ? "AM" : "PM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${minutes} ${period}`;
}

export function millisecondsUntilNextMinute(date: Date): number {
  const elapsedInMinute = date.getSeconds() * 1000 + date.getMilliseconds();
  return Math.max(1, 60_000 - elapsedInMinute);
}
