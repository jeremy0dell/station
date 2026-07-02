import type { ProjectView, WorktreeId } from "@station/contracts";
import stringWidth from "string-width";
import type {
  DashboardSessionOverflow,
  DashboardViewportItem,
} from "../../selectors/dashboardViewport.js";

export { dashboardFooterLabel } from "../../state/keymap.js";

import type { TuiObserverConnectionStatus, TuiScreen } from "../../state/types.js";
import type { RowGridRowInput } from "../WorktreeRow/layout.js";
import { worktreeRowGridInput, worktreeStyleRowGridInput } from "../WorktreeRow/rowInput.js";

export type DashboardHeaderStatus = {
  full: string;
  compact?: string;
};

export type TopRowWidgetText = {
  text: string;
  /** Narrower form tried before the strip starts dropping widgets outright. */
  compact?: string;
};

export function dashboardHeaderLine({
  productLabel,
  columns,
  status,
  widgets,
}: {
  productLabel: string;
  columns: number;
  status?: DashboardHeaderStatus;
  widgets: readonly TopRowWidgetText[];
}): string {
  const safeColumns = Math.max(1, columns);
  const productWidth = stringWidth(productLabel);
  if (productWidth >= safeColumns) {
    return productLabel;
  }

  if (status !== undefined) {
    return dashboardHeaderLineWithStatus({
      productLabel,
      productWidth,
      safeColumns,
      status,
      widgets,
    });
  }

  if (widgets.length === 0) {
    return productLabel;
  }

  for (const strip of widgetStripCandidates(widgets)) {
    const stripWidth = stringWidth(strip);
    const gapWidth = safeColumns - productWidth - stripWidth;
    if (gapWidth >= 1) {
      return `${productLabel}${" ".repeat(gapWidth)}${strip}`;
    }
  }

  return productLabel;
}

function dashboardHeaderLineWithStatus(input: {
  productLabel: string;
  productWidth: number;
  safeColumns: number;
  status: DashboardHeaderStatus;
  widgets: readonly TopRowWidgetText[];
}): string {
  for (const statusText of statusTextCandidates(input.status)) {
    for (const widgets of [...widgetStripCandidates(input.widgets), ""]) {
      const strip = widgets.length === 0 ? statusText : `${statusText}  ${widgets}`;
      const stripWidth = stringWidth(strip);
      const gapWidth = input.safeColumns - input.productWidth - stripWidth;
      if (gapWidth >= 1) {
        return `${input.productLabel}${" ".repeat(gapWidth)}${strip}`;
      }
    }
  }
  return input.productLabel;
}

function statusTextCandidates(status: DashboardHeaderStatus): string[] {
  if (status.compact === undefined || status.compact === status.full) {
    return [status.full];
  }
  return [status.full, status.compact];
}

/**
 * Widest-first strip candidates: every widget full, then every widget in its
 * compact form, then dropping widgets from the right (still compact) — so the
 * strip narrows before it loses information.
 */
function* widgetStripCandidates(widgets: readonly TopRowWidgetText[]): Generator<string> {
  if (widgets.length === 0) {
    return;
  }
  const full = widgets.map((widget) => widget.text);
  const compact = widgets.map((widget) => widget.compact ?? widget.text);
  yield full.join("  ");
  if (compact.some((text, i) => text !== full[i])) {
    yield compact.join("  ");
  }
  for (let visibleCount = widgets.length - 1; visibleCount > 0; visibleCount -= 1) {
    yield compact.slice(0, visibleCount).join("  ");
  }
}

export function projectHeaderLabel(project: ProjectView, collapsed: boolean): string {
  const caret = collapsed ? "▶" : "▼";
  const sessions = `${project.counts.worktrees} ${plural(project.counts.worktrees, "session")}`;
  const agents =
    project.counts.agents > 0
      ? ` · ${project.counts.agents} ${plural(project.counts.agents, "agent")}`
      : "";
  return `${caret} ${project.label}  ${sessions}${agents}`;
}

export function emptyProjectLabel(): string {
  return " no sessions yet · ";
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

export const FIRST_RUN_BODY_LABEL = "No projects configured yet.";

export function scrollIndicatorLabel(
  direction: "above" | "below",
  overflow: DashboardSessionOverflow,
): string {
  if (direction === "above") {
    return `▲ ${overflow.above} ${plural(overflow.above, "session")} above`;
  }
  return `▼ ${overflow.below} below · showing ${overflow.visible} of ${overflow.total}`;
}

export function rowGridInputForViewportItem(
  item: DashboardViewportItem,
  keyByRow: ReadonlyMap<string, string>,
  focusedRowId?: WorktreeId,
): RowGridRowInput | undefined {
  if (item.type === "worktree") {
    const focused = focusedRowId !== undefined && item.row.id === focusedRowId;
    if (item.pendingRemove !== undefined) {
      return worktreeStyleRowGridInput({
        id: item.id,
        slot: undefined,
        marker: { kind: "throbber", variant: "braille" },
        title: item.displayTitle,
        activity: "removing session...",
        activityImportance: "meaningful",
        activityOverflow: "rowSlack",
        ...(focused ? { focused: true } : {}),
      });
    }
    if (item.pendingStart !== undefined) {
      const activity =
        item.pendingStart.operation === "resumeAgent" ? "resuming..." : "starting...";
      return worktreeStyleRowGridInput({
        id: item.id,
        slot: keyByRow.get(item.row.id),
        marker: { kind: "throbber", variant: "braille" },
        title: item.displayTitle,
        activity,
        activityImportance: "meaningful",
        activityOverflow: "rowSlack",
        ...(focused ? { focused: true } : {}),
      });
    }
    return worktreeRowGridInput({
      id: item.id,
      row: item.row,
      slot: keyByRow.get(item.row.id),
      title: item.displayTitle,
      focused,
    });
  }
  if (item.type !== "createLocalRow") {
    return undefined;
  }
  if (item.row.status === "failed") {
    return worktreeStyleRowGridInput({
      id: item.id,
      slot: undefined,
      marker: { kind: "text", text: "!" },
      title: item.row.branch,
      activity: item.row.error.message,
      activityImportance: "meaningful",
      activityOverflow: "rowSlack",
      color: "red",
    });
  }
  return worktreeStyleRowGridInput({
    id: item.id,
    slot: undefined,
    marker: { kind: "throbber", variant: "braille" },
    title: item.row.branch,
    agent: item.row.harnessProvider ?? "",
    activity: "starting session...",
    activityImportance: "meaningful",
    activityOverflow: "rowSlack",
  });
}

export type SnapshotLoadingLine = {
  id: string;
  text: string;
  color?: "gray";
};

export function snapshotLoadingLines(
  loading: boolean,
  observerConnectionStatus: TuiObserverConnectionStatus,
): SnapshotLoadingLine[] {
  if (observerConnectionStatus.state === "reconnecting") {
    return [
      { id: "top-spacer", text: " " },
      { id: "title", text: "waiting for observer" },
      { id: "status", text: "retrying connection", color: "gray" },
      { id: "bottom-spacer", text: " " },
      {
        id: "hint",
        text: "The dashboard will appear when the observer is ready.",
        color: "gray",
      },
    ];
  }

  if (!loading) {
    return [
      { id: "top-spacer", text: " " },
      { id: "title", text: "observer snapshot unavailable" },
      {
        id: "hint",
        text: "Check the error details and try refreshing when ready.",
        color: "gray",
      },
    ];
  }

  return [{ id: "loading", text: "Loading observer snapshot...", color: "gray" }];
}

export function observerHeaderStatusForConnection(
  status: TuiObserverConnectionStatus,
  hasSnapshot: boolean,
): DashboardHeaderStatus | undefined {
  if (hasSnapshot && status.state === "displayOnly") {
    return {
      full: "observer reconnecting · display-only snapshot",
      compact: "observer reconnecting",
    };
  }
  return undefined;
}

export type CommandPromptLine = { text: string; color: "yellow" | "red" };

/**
 * The prompt line per screen (the special-cased rename-slot and
 * remove-confirm lines plus textPromptForScreen below), flattened to
 * text+color so render adapters only render. Lives beside
 * commandPromptRows, which guards the same screens.
 */
export function commandPromptLineForScreen(screen: TuiScreen): CommandPromptLine | undefined {
  if (screen.name === "renameSession" && screen.step === "chooseSlot") {
    return { text: "Choose the slot to rename: 1-9/a-z", color: "yellow" };
  }
  const prompt = textPromptForScreen(screen);
  if (prompt === undefined) {
    return undefined;
  }
  return { text: `${prompt.label}: ${prompt.value}`, color: "yellow" };
}

function textPromptForScreen(screen: TuiScreen): { label: string; value: string } | undefined {
  if (screen.name === "search") {
    return { label: "search", value: screen.value };
  }
  if (screen.name === "projectCollapse") {
    return { label: "collapse project", value: screen.value };
  }
  if (screen.name === "projectSettingsPicker") {
    return { label: "settings for project", value: screen.value };
  }
  return undefined;
}

export function commandPromptRows(screen: TuiScreen): number {
  if (
    screen.name === "search" ||
    screen.name === "projectCollapse" ||
    screen.name === "projectSettingsPicker"
  ) {
    return 2;
  }
  if (screen.name === "renameSession" && screen.step === "chooseSlot") {
    return 2;
  }
  return 0;
}

export function isModalOverlayActive(screen: TuiScreen): boolean {
  return (
    screen.name === "help" ||
    screen.name === "newSession" ||
    screen.name === "projectDefaultAgent" ||
    screen.name === "removeWorktree" ||
    (screen.name === "renameSession" && screen.step === "editName")
  );
}
