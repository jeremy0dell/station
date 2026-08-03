import {
  dashboardBindingHelp,
  QUIT_HINT_CLOSE,
  QUIT_HINT_DISMISS_ERROR,
  QUIT_HINT_FILTER_CLOSE,
  type TuiDashboardBindingId,
} from "../../state/keymap.js";
import type { DashboardPersistentFilter, TuiScreen } from "../../state/types.js";
import { cellWidth, truncateCells } from "../WorktreeRow/layout.js";
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
    return { kind: "loading", text: fitFooterCandidates(columns, [quitHint]) };
  }
  if (screen?.name === "persistentFilter") {
    return persistentFilterEditingFooter(columns);
  }
  if (persistentFilter !== undefined) {
    const appliedQuitHint = quitHint === QUIT_HINT_CLOSE ? QUIT_HINT_FILTER_CLOSE : quitHint;
    return {
      kind: "persistentFilterApplied",
      text: appliedFilterFooter(columns, appliedQuitHint),
    };
  }
  return {
    kind: "dashboard",
    text: dashboardFooter(columns, quitHint, firstRun),
  };
}

function dashboardFooter(columns: number, quitHint: string, firstRun: boolean): string {
  const full = firstRun
    ? footerLine(
        [
          ["tui.dashboard.focusActivate", "add first project"],
          ["tui.dashboard.addProject", "add project"],
        ],
        quitHint,
      )
    : footerLine(
        [
          ["tui.dashboard.focusActivate", "activate"],
          ["tui.dashboard.newSession", "new"],
          ["tui.dashboard.addProject", "add"],
          ["tui.dashboard.nextNeedsMe", "next-needs-me"],
          ["tui.dashboard.search", "search"],
          ["tui.dashboard.remove", "delete"],
          ["tui.dashboard.helpAlias", "help"],
        ],
        quitHint,
      );
  const compact = firstRun
    ? footerLine([["tui.dashboard.focusActivate", "add first project"]], quitHint)
    : footerLine(
        [
          ["tui.dashboard.focusActivate", "activate"],
          ["tui.dashboard.newSession", "new"],
          ["tui.dashboard.nextNeedsMe", "next"],
          ["tui.dashboard.search", "search"],
          ["tui.dashboard.remove", "delete"],
          ["tui.dashboard.helpAlias", "help"],
        ],
        quitHint,
      );
  const width = normalizeTextLineWidth(columns);
  if (cellWidth(full) <= width) {
    return full;
  }
  if (quitHint === QUIT_HINT_DISMISS_ERROR && cellWidth(compact) > width) {
    return quitHint;
  }
  return compact;
}

function appliedFilterFooter(columns: number, quitHint: string): string {
  const full = footerLine(
    [
      ["tui.dashboard.focusActivate", "activate"],
      ["tui.dashboard.newSession", "new"],
      ["tui.dashboard.addProject", "add"],
      ["tui.dashboard.nextNeedsMe", "next-needs-me"],
      ["tui.dashboard.search", "edit"],
      ["tui.dashboard.dismissEsc", "clear"],
      ["tui.dashboard.remove", "delete"],
      ["tui.dashboard.helpAlias", "help"],
    ],
    quitHint,
  );
  const essential = footerLine(
    [
      ["tui.dashboard.search", "edit"],
      ["tui.dashboard.dismissEsc", "clear"],
    ],
    quitHint,
  );
  return fitFooterCandidates(columns, [
    full,
    `${shortcut("tui.dashboard.search", "edit")}  ${shortcut("tui.dashboard.dismissEsc", "clear")}  ${shortcut("tui.dashboard.focusActivate", "activate")}  ${shortcut("tui.dashboard.newSession", "new")}  ${quitHint}`,
    essential,
    `${shortcut("tui.dashboard.search", "edit")} ${shortcut("tui.dashboard.dismissEsc", "clear")} Q`,
    "/ Esc Q",
    "Q",
  ]);
}

function footerLine(
  shortcuts: readonly (readonly [TuiDashboardBindingId, string])[],
  quitHint: string,
): string {
  return [...shortcuts.map(([id, label]) => shortcut(id, label)), quitHint].join("  ");
}

function shortcut(id: TuiDashboardBindingId, label: string): string {
  const help = dashboardBindingHelp(id);
  if (help === undefined) {
    throw new Error(`Dashboard binding ${id} has no help metadata.`);
  }
  return `${help.keys} ${label}`;
}

function fitFooterCandidates(columns: number, candidates: readonly string[]): string {
  const width = normalizeTextLineWidth(columns);
  const selected = candidates.find((candidate) => cellWidth(candidate) <= width);
  return selected ?? truncateCells(candidates.at(-1) ?? "", width);
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
