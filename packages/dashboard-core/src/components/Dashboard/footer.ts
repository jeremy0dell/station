import {
  dashboardFooterLabel,
  QUIT_HINT_CLOSE,
  QUIT_HINT_FILTER_CLOSE,
} from "../../state/keymap.js";
import type { DashboardPersistentFilter, TuiScreen } from "../../state/types.js";
import {
  clipTextLineSegments,
  normalizeTextLineWidth,
  textLineSegmentsWidth,
} from "./segmentLayout.js";

export type DashboardFilterFooterSegmentRole = "badge" | "key" | "description" | "spacer";

export type DashboardFilterFooterSegment = {
  text: string;
  role: DashboardFilterFooterSegmentRole;
};

export type DashboardFooterModel =
  | { kind: "loading"; text: string }
  | { kind: "dashboard"; text: string }
  | { kind: "persistentFilterApplied"; text: string }
  | {
      kind: "persistentFilterEditing";
      segments: readonly DashboardFilterFooterSegment[];
    };

export function dashboardFooterModel({
  columns,
  quitHint,
  hasSnapshot,
  firstRun,
  screen,
  persistentFilter,
}: {
  columns: number;
  quitHint: string;
  hasSnapshot: boolean;
  firstRun: boolean;
  screen?: TuiScreen;
  persistentFilter?: DashboardPersistentFilter;
}): DashboardFooterModel {
  if (!hasSnapshot) {
    return { kind: "loading", text: quitHint };
  }
  if (screen?.name === "persistentFilter") {
    return persistentFilterEditingFooter(columns);
  }
  if (persistentFilter !== undefined) {
    const appliedQuitHint = quitHint === QUIT_HINT_CLOSE ? QUIT_HINT_FILTER_CLOSE : quitHint;
    return {
      kind: "persistentFilterApplied",
      text: dashboardFooterLabel({
        columns,
        quitHint: appliedQuitHint,
        firstRun,
        persistentFilter: true,
      }),
    };
  }
  return {
    kind: "dashboard",
    text: dashboardFooterLabel({ columns, quitHint, firstRun }),
  };
}

function persistentFilterEditingFooter(
  columns: number,
): Extract<DashboardFooterModel, { kind: "persistentFilterEditing" }> {
  const width = normalizeTextLineWidth(columns);
  const candidates: readonly (readonly DashboardFilterFooterSegment[])[] = [
    persistentFilterFooterSegments([
      ["←→", "cursor"],
      ["Enter", "apply"],
      ["Ctrl-U", "clear"],
      ["Esc", "cancel"],
    ]),
    persistentFilterFooterSegments([
      ["Enter", "apply"],
      ["^U", "clear"],
      ["Esc", "cancel"],
    ]),
    persistentFilterFooterSegments([
      ["↵", "apply"],
      ["Esc", "cancel"],
    ]),
  ];
  const selected = candidates.find((candidate) => textLineSegmentsWidth(candidate) <= width);
  return {
    kind: "persistentFilterEditing",
    segments: selected ?? clipTextLineSegments(candidates.at(-1) ?? [], width),
  };
}

function persistentFilterFooterSegments(
  helpers: readonly (readonly [key: string, description: string])[],
): DashboardFilterFooterSegment[] {
  const segments: DashboardFilterFooterSegment[] = [{ text: " FILTER ", role: "badge" }];
  for (const [key, description] of helpers) {
    segments.push({ text: "  ", role: "spacer" });
    segments.push({ text: key, role: "key" });
    segments.push({ text: ` ${description}`, role: "description" });
  }
  return segments;
}
