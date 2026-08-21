import { DASHBOARD_FILTER_CONDITION_KEYS } from "../../selectors/dashboardFilterConditions.js";
import type { PersistentFilterActionId } from "../../state/actions.js";
import {
  dashboardBindingHelp,
  dashboardFooterShortcuts,
  QUIT_HINT_CLOSE,
  QUIT_HINT_DISMISS_ERROR,
  QUIT_HINT_FILTER_CLOSE,
  type TuiDashboardBindingId,
} from "../../state/keymap.js";
import { dashboardShortcutInvocation } from "../../state/shortcutInvocation.js";
import type { DashboardScreenView, DashboardViewState } from "../../state/types.js";
import { cellWidth, truncateCells } from "../WorktreeRow/layout.js";
import {
  clipTextLineSegments,
  normalizeTextLineWidth,
  textLineSegmentsWidth,
} from "./segmentLayout.js";

type DashboardPersistentFilterView = NonNullable<DashboardViewState["persistentFilter"]>;
type FooterShortcut = {
  id: TuiDashboardBindingId;
  keys: string;
  label: string;
};
type FooterHelper = readonly [key: string, description: string];
type PersistentFilterConditionStage = "field" | "values";

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

export type DashboardFooterShortcutInputModel = {
  kind: "shortcutInput";
  segments: readonly DashboardFilterFooterSegment[];
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
  | DashboardFooterShortcutInputModel
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

  if (screen?.name === "dashboard" && screen.shortcutCodeInput !== undefined) {
    return shortcutInputFooter(columns, screen.shortcutCodeInput);
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

function shortcutInputFooter(columns: number, input: string): DashboardFooterShortcutInputModel {
  const descriptions = dashboardShortcutDescriptions(input);
  const candidates = descriptions.map((description) =>
    shortcutFooterSegments(description.badge, input, description.text),
  );
  return {
    kind: "shortcutInput",
    segments: fitFooterSegmentCandidates(columns, candidates),
  };
}

function dashboardShortcutDescriptions(input: string): readonly { badge: string; text: string }[] {
  if (input.length === 0) {
    return [
      {
        badge: " COMMAND ",
        text: "Type 1-zzz for a session or an uppercase command  Esc close",
      },
      { badge: " COMMAND ", text: "1-zzz session · uppercase command · Esc close" },
      { badge: " COMMAND ", text: "1-zzz · uppercase · Esc" },
    ];
  }

  const invocation = dashboardShortcutInvocation(input);
  if (invocation.kind === "session") {
    return shortcutActionDescriptions(" SESSION ", `open session ${invocation.code}`, "run");
  }
  if (invocation.kind === "command") {
    return shortcutActionDescriptions(" COMMAND ", invocation.command.label, "run");
  }
  return [
    {
      badge: " NO MATCH ",
      text: "Use lowercase 1-zzz or one uppercase command  Backspace edit  Esc close",
    },
    { badge: " NO MATCH ", text: "1-zzz or uppercase  ⌫ edit  Esc close" },
    { badge: " NO MATCH ", text: "⌫ edit · Esc" },
  ];
}

function shortcutActionDescriptions(
  badge: string,
  action: string,
  enterLabel: string,
): readonly { badge: string; text: string }[] {
  return [
    {
      badge,
      text: `${action}  Enter ${enterLabel}  Backspace edit  Esc close`,
    },
    { badge, text: `${action}  ↵ ${enterLabel}  ⌫ edit  Esc close` },
    { badge, text: `↵ ${enterLabel} · Esc` },
  ];
}

function shortcutFooterSegments(
  badge: string,
  input: string,
  description: string,
): DashboardFilterFooterSegment[] {
  return [
    footerSegment(badge, "badge"),
    footerSegment("  ", "spacer"),
    footerSegment(`${input}▌`, "key"),
    footerSegment("  ", "spacer"),
    footerSegment(description, "description"),
  ];
}

function dashboardFooter(columns: number, quitHint: string, firstRun: boolean): string {
  const fullShortcuts = firstRun ? firstRunShortcuts(false) : dashboardFooterShortcuts("full");
  const compactShortcuts = firstRun
    ? firstRunShortcuts(true)
    : dashboardFooterShortcuts("compact").map((shortcut) =>
        shortcut.id === "tui.dashboard.nextNeedsMe" ? { ...shortcut, label: "next" } : shortcut,
      );
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
  const fullShortcuts = filteredFooterShortcuts();
  const essentialShortcuts = fullShortcuts.filter(
    (shortcut) => persistentFilterActionForBinding(shortcut.id) !== undefined,
  );
  const prioritizedShortcuts = [
    ...essentialShortcuts,
    ...fullShortcuts
      .filter((shortcut) => persistentFilterActionForBinding(shortcut.id) === undefined)
      .slice(0, 2),
  ];
  const full = appliedFooterSegments(fullShortcuts, quitHint);
  const prioritized = appliedFooterSegments(prioritizedShortcuts, quitHint);
  const essential = appliedFooterSegments(essentialShortcuts, quitHint);
  const labeledActions = compactAppliedFilterActions(essentialShortcuts, true);
  const keyOnlyActions = compactAppliedFilterActions(essentialShortcuts, false);
  const quitOnly = [footerSegment(bindingKeys("tui.dashboard.quit"), "description")];
  const candidates = [full, prioritized, essential, labeledActions, keyOnlyActions, quitOnly];
  return fitFooterSegmentCandidates(columns, candidates);
}

function compactAppliedFilterActions(
  shortcuts: readonly FooterShortcut[],
  labeled: boolean,
): readonly DashboardFilterFooterSegment[] {
  const [edit, clear] = shortcuts;
  if (edit === undefined || clear === undefined) {
    throw new Error("Persistent-filter footer bindings are incomplete.");
  }
  const text = (shortcut: FooterShortcut) => (labeled ? shortcutText(shortcut) : shortcut.keys);
  return [
    footerActionSegment(text(edit), persistentFilterAction(edit.id)),
    footerSegment(" ", "spacer"),
    footerActionSegment(text(clear), persistentFilterAction(clear.id)),
    footerSegment(` ${bindingKeys("tui.dashboard.quit")}`, "description"),
  ];
}

function appliedFooterSegments(
  shortcuts: readonly FooterShortcut[],
  quitHint: string,
): DashboardFilterFooterSegment[] {
  const segments: DashboardFilterFooterSegment[] = [];
  shortcuts.forEach((shortcut, index) => {
    if (index > 0) {
      segments.push(footerSegment("  ", "spacer"));
    }

    const action = persistentFilterActionForBinding(shortcut.id);
    const text = shortcutText(shortcut);
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

function firstRunShortcuts(compact: boolean): readonly FooterShortcut[] {
  const activate = contextualFooterShortcut("tui.dashboard.focusActivate", "add first project");
  if (compact) return [activate];
  return [activate, contextualFooterShortcut("tui.dashboard.addProject", "add project")];
}

function filteredFooterShortcuts(): readonly FooterShortcut[] {
  const clear = contextualFooterShortcut("tui.dashboard.dismissEsc", "clear");
  return dashboardFooterShortcuts("full").flatMap((shortcut) =>
    shortcut.id === "tui.dashboard.filter" ? [{ ...shortcut, label: "edit" }, clear] : [shortcut],
  );
}

function contextualFooterShortcut(id: TuiDashboardBindingId, label: string): FooterShortcut {
  return { id, keys: bindingKeys(id), label };
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
  return [...shortcuts.map(shortcutText), quitHint].join("  ");
}

function shortcutText(shortcut: FooterShortcut): string {
  return `${shortcut.keys} ${shortcut.label}`;
}

function bindingKeys(id: TuiDashboardBindingId): string {
  const help = dashboardBindingHelp(id);
  if (help === undefined) {
    throw new Error(`Dashboard binding ${id} has no help metadata.`);
  }
  return help.keys;
}

function persistentFilterActionForBinding(
  id: TuiDashboardBindingId,
): PersistentFilterActionId | undefined {
  if (id === "tui.dashboard.filter") return "persistentFilter.edit";
  if (id === "tui.dashboard.dismissEsc") return "persistentFilter.clear";
  return undefined;
}

function persistentFilterAction(id: TuiDashboardBindingId): PersistentFilterActionId {
  const action = persistentFilterActionForBinding(id);
  if (action === undefined) throw new Error(`Dashboard binding ${id} has no filter action.`);
  return action;
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
