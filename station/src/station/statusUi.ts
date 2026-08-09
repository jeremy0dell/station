import type { FleetSummary } from "@station/dashboard-core/selectors";

export type ProjectRollupStatus = "needsYou" | "working" | "ready" | "idle";

type StatusUi = {
  label: string;
  glyph: string;
  tone: "danger" | "working" | "success" | "warning" | "neutral";
  animate: boolean;
  fleet: "always" | "nonzero" | "hidden";
  projectPriority: number | null;
};

export const STATION_STATUS_UI = {
  ready: { label: "ready", glyph: "●", tone: "success", animate: false, fleet: "always", projectPriority: 1 },
  working: { label: "working", glyph: "⠿", tone: "working", animate: true, fleet: "always", projectPriority: 2 },
  needsYou: { label: "needs you", glyph: "!", tone: "danger", animate: false, fleet: "always", projectPriority: 3 },
  idle: { label: "idle", glyph: "○", tone: "neutral", animate: false, fleet: "always", projectPriority: 0 },
  starting: { label: "starting", glyph: "+", tone: "neutral", animate: false, fleet: "hidden", projectPriority: null },
  unknown: { label: "unknown", glyph: "?", tone: "warning", animate: false, fleet: "nonzero", projectPriority: null },
  exited: { label: "exited", glyph: "x", tone: "neutral", animate: false, fleet: "nonzero", projectPriority: null },
} as const satisfies Record<keyof FleetSummary, StatusUi>;

export const FLEET_STATUS_ORDER = [
  "ready", "working", "needsYou", "unknown", "exited", "idle", "starting",
] as const satisfies readonly (keyof FleetSummary)[];
