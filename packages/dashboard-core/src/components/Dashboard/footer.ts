import { DASHBOARD_FILTER_CONDITION_KEYS } from "../../selectors/dashboardFilterConditions.js";
import type { PersistentFilterActionId } from "../../state/actions.js";
import {
  dashboardBindingHelp,
  QUIT_HINT_CLOSE,
  QUIT_HINT_DISMISS_ERROR,
  QUIT_HINT_FILTER_CLOSE,
  type TuiDashboardBindingId,
} from "../../state/keymap.js";
import type { DashboardScreenView, DashboardViewState } from "../../state/types.js";
import { cellWidth, truncateCells } from "../WorktreeRow/layout.js";
import {
  clipTextLineSegments,
  normalizeTextLineWidth,
  textLineSegmentsWidth,
} from "./segmentLayout.js";

type DashboardPersistentFilterView = NonNullable<DashboardViewState["persistentFilter"]>;
type FooterShortcut = readonly [id: TuiDashboardBindingId, label: string];
type FooterHelper = readonly [key: string, description: string];
type PersistentFilterConditionStage = "field" | "values";

type AppliedFooterShortcut = readonly [
  id: TuiDashboardBindingId,
  label: string,
  action?: PersistentFilterActionId,
];

export type DashboardFilterFooterSegmentRole = "badge" | "key" | "description" | "spacer";

export type DashboardFilterFooterSegment = {
  text: string;
  role: DashboardFilterFooterSegmentRole;
  action?: PersistentFilterActionId;
};

export type DashboardFooterLoadingModel = {
  kind: "loading";
  text: string;
};

export type DashboardFooterDashboardModel = {
  kind: "dashboard";
  text: string;
};

export type DashboardFooterPersistentFilterAppliedModel = {
  kind: "persistentFilterApplied";
  segments: readonly DashboardFilterFooterSegment[];
};

export type DashboardFooterPersistentFilterEditingModel = {
  kind: "persistentFilterEditing";
  segments: readonly DashboardFilterFooterSegment[];
};

export type DashboardFooterPersistentFilterConditionModel = {
  kind: "persistentFilterCondition";
  segments: readonly DashboardFilterFooterSegment[];
};

export type DashboardFooterModel =
  | DashboardFooterLoadingModel
  | DashboardFooterDashboardModel
  | DashboardFooterPersistentFilterAppliedModel
  | DashboardFooterPersistentFilterEditingModel
  | DashboardFooterPersistentFilterConditionModel;

export type DashboardFooterModelOptions = {
  columns: number;
  quitHint: string;
  hasSnapshot: boolean;
  firstRun: boolean;
  screen?: DashboardScreenView;
  persistentFilter?: DashboardPersistentFilterView;
};

const FIRST_RUN_FULL_SHORTCUTS: readonly FooterShortcut[] = [
  ["tui.dashboard.focusActivate", "add first project"],
  ["tui.dashboard.addProject", "add project"],
];

const FIRST_RUN_COMPACT_SHORTCUTS: readonly FooterShortcut[] = [
  ["tui.dashboard.focusActivate", "add first project"],
];

const DASHBOARD_FULL_SHORTCUTS: readonly FooterShortcut[] = [
  ["tui.dashboard.focusActivate", "activate"],
  ["tui.dashboard.newSession", "new"],
  ["tui.dashboard.addProject", "add"],
  ["tui.dashboard.nextNeedsMe", "next-needs-me"],
  ["tui.dashboard.search", "search"],
  ["tui.dashboard.remove", "delete"],
  ["tui.dashboard.helpAlias", "help"],
];

const DASHBOARD_COMPACT_SHORTCUTS: readonly FooterShortcut[] = [
  ["tui.dashboard.focusActivate", "activate"],
  ["tui.dashboard.newSession", "new"],
  ["tui.dashboard.nextNeedsMe", "next"],
  ["tui.dashboard.search", "search"],
  ["tui.dashboard.remove", "delete"],
  ["tui.dashboard.helpAlias", "help"],
];

const APPLIED_FILTER_FULL_SHORTCUTS: readonly AppliedFooterShortcut[] = [
  ["tui.dashboard.focusActivate", "activate"],
  ["tui.dashboard.newSession", "new"],
  ["tui.dashboard.addProject", "add"],
  ["tui.dashboard.nextNeedsMe", "next-needs-me"],
  ["tui.dashboard.search", "edit", "persistentFilter.edit"],
  ["tui.dashboard.dismissEsc", "clear", "persistentFilter.clear"],
  ["tui.dashboard.remove", "delete"],
  ["tui.dashboard.helpAlias", "help"],
];

const APPLIED_FILTER_PRIORITIZED_SHORTCUTS: readonly AppliedFooterShortcut[] = [
  ["tui.dashboard.search", "edit", "persistentFilter.edit"],
  ["tui.dashboard.dismissEsc", "clear", "persistentFilter.clear"],
  ["tui.dashboard.focusActivate", "activate"],
  ["tui.dashboard.newSession", "new"],
];

const APPLIED_FILTER_ESSENTIAL_SHORTCUTS: readonly AppliedFooterShortcut[] = [
  ["tui.dashboard.search", "edit", "persistentFilter.edit"],
  ["tui.dashboard.dismissEsc", "clear", "persistentFilter.clear"],
];

const CONDITION_FIELD_KEY_HINT = DASHBOARD_FILTER_CONDITION_KEYS.join("/");

const CONDITION_FIELD_HELPERS: readonly FooterHelper[] = [
  [CONDITION_FIELD_KEY_HINT, "edit"],
  ["↑↓", "move"],
  ["Enter", "select"],
  ["F", "apply filter"],
  ["Esc", "text"],
];

const CONDITION_FIELD_COMPACT_HELPERS: readonly FooterHelper[] = [
  [CONDITION_FIELD_KEY_HINT, "edit"],
  ["F", "apply"],
  ["Esc", "text"],
];

const CONDITION_VALUE_HELPERS: readonly FooterHelper[] = [
  ["←", "fields"],
  ["↑↓", "move"],
  ["Space/slot", "toggle"],
  ["Enter", "done"],
  ["Esc", "close"],
];

const CONDITION_VALUE_COMPACT_HELPERS: readonly FooterHelper[] = [
  ["←", "fields"],
  ["Sp", "toggle"],
  ["Esc", "close"],
];

export function dashboardFooterModel(options: DashboardFooterModelOptions): DashboardFooterModel {
  const { columns, quitHint, hasSnapshot, firstRun, screen, persistentFilter } = options;

  if (!hasSnapshot) {
    const model: DashboardFooterLoadingModel = {
      kind: "loading",
      text: fitFooterCandidates(columns, [quitHint]),
    };
    return model;
  }

  if (screen?.name === "persistentFilter") {
    if (screen.conditionEditor === undefined) {
      return persistentFilterEditingFooter(columns);
    }
    return persistentFilterConditionFooter(columns, screen.conditionEditor.stage);
  }

  if (persistentFilter !== undefined) {
    const appliedQuitHint = quitHint === QUIT_HINT_CLOSE ? QUIT_HINT_FILTER_CLOSE : quitHint;
    const model: DashboardFooterPersistentFilterAppliedModel = {
      kind: "persistentFilterApplied",
      segments: appliedFilterFooter(columns, appliedQuitHint),
    };
    return model;
  }

  const model: DashboardFooterDashboardModel = {
    kind: "dashboard",
    text: dashboardFooter(columns, quitHint, firstRun),
  };
  return model;
}

function dashboardFooter(columns: number, quitHint: string, firstRun: boolean): string {
  let fullShortcuts = DASHBOARD_FULL_SHORTCUTS;
  let compactShortcuts = DASHBOARD_COMPACT_SHORTCUTS;
  if (firstRun) {
    fullShortcuts = FIRST_RUN_FULL_SHORTCUTS;
    compactShortcuts = FIRST_RUN_COMPACT_SHORTCUTS;
  }

  const full = footerLine(fullShortcuts, quitHint);
  const compact = footerLine(compactShortcuts, quitHint);
  const width = normalizeTextLineWidth(columns);
  if (cellWidth(full) <= width) {
    return full;
  }
  if (quitHint === QUIT_HINT_DISMISS_ERROR && cellWidth(compact) > width) {
    return quitHint;
  }
  return compact;
}

function appliedFilterFooter(
  columns: number,
  quitHint: string,
): readonly DashboardFilterFooterSegment[] {
  const full = appliedFooterSegments(APPLIED_FILTER_FULL_SHORTCUTS, quitHint);
  const prioritized = appliedFooterSegments(APPLIED_FILTER_PRIORITIZED_SHORTCUTS, quitHint);
  const essential = appliedFooterSegments(APPLIED_FILTER_ESSENTIAL_SHORTCUTS, quitHint);
  const labeledActions = labeledAppliedFilterActions();
  const keyOnlyActions = keyOnlyAppliedFilterActions();
  const quitOnly = [footerSegment("Q", "description")];
  const candidates = [full, prioritized, essential, labeledActions, keyOnlyActions, quitOnly];
  return fitFooterSegmentCandidates(columns, candidates);
}

function labeledAppliedFilterActions(): readonly DashboardFilterFooterSegment[] {
  const edit = footerActionSegment(
    shortcut("tui.dashboard.search", "edit"),
    "persistentFilter.edit",
  );
  const clear = footerActionSegment(
    shortcut("tui.dashboard.dismissEsc", "clear"),
    "persistentFilter.clear",
  );
  return [edit, footerSegment(" ", "spacer"), clear, footerSegment(" Q", "description")];
}

function keyOnlyAppliedFilterActions(): readonly DashboardFilterFooterSegment[] {
  return [
    footerActionSegment("/", "persistentFilter.edit"),
    footerSegment(" ", "spacer"),
    footerActionSegment("Esc", "persistentFilter.clear"),
    footerSegment(" Q", "description"),
  ];
}

function appliedFooterSegments(
  shortcuts: readonly AppliedFooterShortcut[],
  quitHint: string,
): DashboardFilterFooterSegment[] {
  const segments: DashboardFilterFooterSegment[] = [];
  shortcuts.forEach(([id, label, action], index) => {
    if (index > 0) {
      segments.push(footerSegment("  ", "spacer"));
    }

    const text = shortcut(id, label);
    if (action === undefined) {
      segments.push(footerSegment(text, "description"));
    } else {
      segments.push(footerActionSegment(text, action));
    }
  });
  segments.push(footerSegment("  ", "spacer"));
  segments.push(footerSegment(quitHint, "description"));
  return segments;
}

function fitFooterSegmentCandidates(
  columns: number,
  candidates: readonly (readonly DashboardFilterFooterSegment[])[],
): readonly DashboardFilterFooterSegment[] {
  const width = normalizeTextLineWidth(columns);
  const selected = candidates.find((candidate) => textLineSegmentsWidth(candidate) <= width);
  return selected ?? clipTextLineSegments(candidates.at(-1) ?? [], width);
}

function footerLine(shortcuts: readonly FooterShortcut[], quitHint: string): string {
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
): DashboardFooterPersistentFilterEditingModel {
  const width = normalizeTextLineWidth(columns);
  const candidates: readonly (readonly DashboardFilterFooterSegment[])[] = [
    persistentFilterFooterSegments([
      ["←→", "cursor"],
      ["Enter", "apply"],
      ["Tab", "condition"],
      ["Ctrl-U", "clear"],
      ["Esc", "cancel"],
    ]),
    persistentFilterFooterSegments([
      ["Enter", "apply"],
      ["Tab", "condition"],
      ["^U", "clear"],
      ["Esc", "cancel"],
    ]),
    persistentFilterFooterSegments([
      ["↵", "apply"],
      ["Esc", "cancel"],
    ]),
  ];
  const selected = candidates.find((candidate) => textLineSegmentsWidth(candidate) <= width);
  const segments = selected ?? clipTextLineSegments(candidates.at(-1) ?? [], width);
  const model: DashboardFooterPersistentFilterEditingModel = {
    kind: "persistentFilterEditing",
    segments,
  };
  return model;
}

function persistentFilterConditionFooter(
  columns: number,
  stage: PersistentFilterConditionStage,
): DashboardFooterPersistentFilterConditionModel {
  let helpers = CONDITION_VALUE_HELPERS;
  let compactHelpers = CONDITION_VALUE_COMPACT_HELPERS;
  if (stage === "field") {
    helpers = CONDITION_FIELD_HELPERS;
    compactHelpers = CONDITION_FIELD_COMPACT_HELPERS;
  }

  const width = normalizeTextLineWidth(columns);
  const full = persistentFilterFooterSegments(helpers, " CONDITION ");
  const compact = compactConditionFooterSegments(compactHelpers);
  const segments = conditionFooterSegmentsForWidth(full, compact, width);
  const model: DashboardFooterPersistentFilterConditionModel = {
    kind: "persistentFilterCondition",
    segments,
  };
  return model;
}

function compactConditionFooterSegments(
  helpers: readonly FooterHelper[],
): DashboardFilterFooterSegment[] {
  const segments: DashboardFilterFooterSegment[] = [footerSegment(" CONDITION ", "badge")];
  for (const [key, description] of helpers) {
    segments.push(footerSegment(" ", "spacer"));
    segments.push(footerSegment(key, "key"));
    segments.push(footerSegment(` ${description}`, "description"));
  }
  return segments;
}

function conditionFooterSegmentsForWidth(
  full: readonly DashboardFilterFooterSegment[],
  compact: readonly DashboardFilterFooterSegment[],
  width: number,
): readonly DashboardFilterFooterSegment[] {
  if (textLineSegmentsWidth(full) <= width) return full;
  if (textLineSegmentsWidth(compact) <= width) return compact;
  return clipTextLineSegments(compact, width);
}

function persistentFilterFooterSegments(
  helpers: readonly FooterHelper[],
  badge = " FILTER ",
): DashboardFilterFooterSegment[] {
  const segments: DashboardFilterFooterSegment[] = [footerSegment(badge, "badge")];
  for (const [key, description] of helpers) {
    segments.push(footerSegment("  ", "spacer"));
    segments.push(footerSegment(key, "key"));
    segments.push(footerSegment(` ${description}`, "description"));
  }
  return segments;
}

function footerSegment(
  text: string,
  role: DashboardFilterFooterSegmentRole,
): DashboardFilterFooterSegment {
  const segment: DashboardFilterFooterSegment = { text, role };
  return segment;
}

function footerActionSegment(
  text: string,
  action: PersistentFilterActionId,
): DashboardFilterFooterSegment {
  const segment: DashboardFilterFooterSegment = {
    text,
    role: "key",
    action,
  };
  return segment;
}
