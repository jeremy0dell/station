import type { DashboardPersistentFilterRowMatch } from "../../selectors/dashboardPersistentFilter.js";
import type { DashboardTreeRow } from "../../selectors/dashboardTree.js";
import type { RowGridRowInput } from "../WorktreeRow/layout.js";
import {
  type WorktreeRowTextHighlights,
  worktreeRowGridInput,
  worktreeStyleRowGridInput,
} from "../WorktreeRow/rowInput.js";

/** Converts one session-like dashboard row into the existing shared row-grid input. */
export function dashboardRowGridInput(
  row: DashboardTreeRow,
  keyBySession: ReadonlyMap<string, string>,
  shortcutWidth = 1,
): RowGridRowInput | undefined {
  const payload = row.payload;
  if (payload.type !== "session" && payload.type !== "createLocalRow") {
    return undefined;
  }
  const decorations = rowDecorations(row);
  if (payload.type === "session") {
    if (payload.pendingRemove !== undefined) {
      return worktreeStyleRowGridInput({
        id: row.id,
        slot: undefined,
        slotWidth: shortcutWidth,
        marker: { kind: "throbber", variant: "braille" },
        title: payload.presentation.title,
        activity: payload.presentation.activity ?? "",
        activityImportance: "meaningful",
        activityOverflow: "rowSlack",
        ...decorations,
      });
    }
    if (payload.pendingStart !== undefined) {
      return worktreeStyleRowGridInput({
        id: row.id,
        slot: keyBySession.get(payload.row.id),
        slotWidth: shortcutWidth,
        marker: { kind: "throbber", variant: "braille" },
        title: payload.presentation.title,
        activity: payload.presentation.activity ?? "",
        activityImportance: "meaningful",
        activityOverflow: "rowSlack",
        ...decorations,
      });
    }
    return worktreeRowGridInput({
      id: row.id,
      row: payload.row.presentation,
      slot: keyBySession.get(payload.row.id),
      slotWidth: shortcutWidth,
      presentation: {
        title: payload.presentation.title,
        agent: payload.presentation.agent ?? "",
        activity: payload.presentation.activity ?? "",
      },
      ...decorations,
    });
  }
  if (payload.row.status === "failed") {
    return worktreeStyleRowGridInput({
      id: row.id,
      slot: undefined,
      slotWidth: shortcutWidth,
      marker: { kind: "text", text: "!" },
      title: payload.presentation.title,
      activity: payload.presentation.activity ?? "",
      activityImportance: "meaningful",
      activityOverflow: "rowSlack",
      color: "red",
      ...decorations,
    });
  }
  return worktreeStyleRowGridInput({
    id: row.id,
    slot: undefined,
    slotWidth: shortcutWidth,
    marker: { kind: "throbber", variant: "braille" },
    title: payload.presentation.title,
    agent: payload.presentation.agent ?? "",
    activity: payload.presentation.activity ?? "",
    activityImportance: "meaningful",
    activityOverflow: "rowSlack",
    ...decorations,
  });
}

type DashboardRowDecorations = {
  focused?: true;
  textHighlights?: WorktreeRowTextHighlights;
  dimmed?: true;
};

function rowDecorations(row: DashboardTreeRow): DashboardRowDecorations {
  const decorations: DashboardRowDecorations = {};
  if (row.focusedCellId === "identity") {
    decorations.focused = true;
  }
  const match =
    row.payload.type === "session" || row.payload.type === "createLocalRow"
      ? row.payload.persistentFilterMatch
      : undefined;
  if (match !== undefined) {
    decorations.textHighlights = persistentFilterRowHighlights(match);
    if (match.dimmed) {
      decorations.dimmed = true;
    }
  }
  return decorations;
}

function persistentFilterRowHighlights(
  match: DashboardPersistentFilterRowMatch,
): WorktreeRowTextHighlights {
  return {
    title: match.ranges.title,
    agent: match.ranges.agent,
    activity: match.ranges.activity,
  };
}
