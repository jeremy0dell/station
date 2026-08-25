import type { DashboardSessionOverflow } from "../../selectors/dashboardSlots.js";
import type {
  DashboardScreenView,
  DashboardSnapshotView,
  DashboardStateView,
} from "../../state/types.js";
import { cellWidth } from "../../text/cells.js";

type DashboardProjectView = DashboardSnapshotView["projects"][number];
type DashboardObserverConnectionStatusView = DashboardStateView["observerConnectionStatus"];

export type DashboardHeaderStatus = {
  full: string;
  compact?: string;
};

export type TopRowWidgetText = {
  text: string;
  /** Narrower form tried before the strip starts dropping widgets outright. */
  compact?: string;
};

/**
 * The frame's right-embedded strip: observer status (when present) then the
 * widget ladder, widest candidate that fits. Empty string when nothing fits.
 */
export function headerStrip({
  widgets,
  status,
  maxWidth,
}: {
  widgets: readonly TopRowWidgetText[];
  status?: DashboardHeaderStatus;
  maxWidth: number;
}): string {
  for (const statusText of status === undefined ? [""] : statusTextCandidates(status)) {
    for (const strip of [...widgetStripCandidates(widgets), ""]) {
      const joined = [statusText, strip].filter((part) => part.length > 0).join(" · ");
      if (joined.length === 0) {
        continue;
      }
      if (cellWidth(joined) <= maxWidth) {
        return joined;
      }
    }
  }
  return "";
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
  yield full.join(" · ");
  if (compact.some((text, i) => text !== full[i])) {
    yield compact.join(" · ");
  }
  for (let visibleCount = widgets.length - 1; visibleCount > 0; visibleCount -= 1) {
    yield compact.slice(0, visibleCount).join(" · ");
  }
}

/** Right side of the FLEET row; falls back to bare numbers, then to nothing. */
export function fleetCountsLabel(
  counts: { projects: number; sessions: number; agents: number },
  maxWidth: number,
): string {
  const full = `${counts.projects} ${plural(counts.projects, "project")} · ${counts.sessions} ${plural(
    counts.sessions,
    "session",
  )} · ${counts.agents} ${plural(counts.agents, "agent")}`;
  if (cellWidth(full) <= maxWidth) {
    return full;
  }
  const compact = `${counts.projects} · ${counts.sessions} · ${counts.agents}`;
  return cellWidth(compact) <= maxWidth ? compact : "";
}

export function projectHeaderLabelParts(
  project: DashboardProjectView,
  collapsed: boolean,
  groupCount: number,
): { title: string; counts: string } {
  const caret = collapsed ? "▶" : "▼";
  const sessions = `${project.counts.sessions} ${plural(project.counts.sessions, "session")}`;
  const groups = groupCount > 0 ? ` · ${groupCount} ${groupCount === 1 ? "Group" : "Groups"}` : "";
  const agents =
    project.counts.agents > 0
      ? ` · ${project.counts.agents} ${plural(project.counts.agents, "agent")}`
      : "";
  return { title: `${caret} ${project.label}`, counts: `  ${sessions}${groups}${agents}` };
}

export function emptyProjectLabel(): string {
  return " no sessions yet · ";
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

export const FIRST_RUN_BODY_LABEL = "Add your first project";

export function scrollIndicatorLabel(
  direction: "above" | "below",
  overflow: DashboardSessionOverflow,
): string {
  if (direction === "above") {
    return `▲ ${overflow.above} ${plural(overflow.above, "session")} above`;
  }
  return `▼ ${overflow.below} below · showing ${overflow.visible} of ${overflow.total}`;
}

export type SnapshotLoadingContent =
  | { kind: "loading"; title: string }
  | { kind: "unavailable"; title: string; hint: string }
  | { kind: "reconnecting"; title: string; detail: string; hint: string };

/** Semantic copy for the dashboard body while no Observer snapshot is available. */
export function snapshotLoadingContent(
  loading: boolean,
  observerConnectionStatus: DashboardObserverConnectionStatusView,
): SnapshotLoadingContent {
  if (observerConnectionStatus.state === "reconnecting") {
    return {
      kind: "reconnecting",
      title: "waiting for observer",
      detail: "retrying connection",
      hint: "The dashboard will appear when the observer is ready.",
    };
  }

  if (!loading) {
    return {
      kind: "unavailable",
      title: "observer snapshot unavailable",
      hint: "Check the error details and try refreshing when ready.",
    };
  }

  return { kind: "loading", title: "Loading observer snapshot..." };
}

export function observerHeaderStatusForConnection(
  status: DashboardObserverConnectionStatusView,
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

export type CommandPromptModel = { text: string; tone: "warning" | "danger" };

/** Semantic prompt content for screens that augment the dashboard controls. */
export function commandPromptForScreen(
  screen: DashboardScreenView,
): CommandPromptModel | undefined {
  if (screen.name === "renameSession" && screen.step === "chooseSlot") {
    return { text: "Rename: ↑↓ move · ↵ choose · 1-9/a-z or click", tone: "warning" };
  }
  return undefined;
}
