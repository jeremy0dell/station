import type { ProjectId, ProviderHealth, ProviderId, SessionId } from "@station/contracts";
import { pendingProjectDefaultHarnesses, pendingRenameTitles } from "../state/localRows.js";
import type { DashboardSnapshotView, DashboardViewState } from "../state/types.js";
import { matchesDashboardSessionSearch } from "./dashboardSearchProjection.js";

export const SELECTION_KEYS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
] as const;

export type SelectionKey = (typeof SELECTION_KEYS)[number];

export type KeyedChoice<T> = {
  key: SelectionKey;
  value: T;
};

type DashboardProjectView = DashboardSnapshotView["projects"][number];
type DashboardWorktreeRowView = DashboardSnapshotView["rows"][number];
type DashboardSessionView = DashboardSnapshotView["sessions"][number];
type DashboardProviderHealthView = DashboardSnapshotView["providerHealth"][ProviderId];
type DashboardSnapshotHarnessView = NonNullable<DashboardSnapshotView["harnesses"]>[number];
type DashboardLocalRowsView = DashboardViewState["localRows"];
type Mutable<T> = { -readonly [TKey in keyof T]: T[TKey] };

export type DashboardSessionRow = {
  /** Dashboard identity is the canonical session id, never the checkout id. */
  id: SessionId;
  session: DashboardSessionView;
  worktree: DashboardWorktreeRowView;
  presentation: DashboardWorktreeRowView;
};

export type NewSessionHarnessOption = {
  id: ProviderId;
  label: string;
  status: ProviderHealth["status"];
  createBlocked: boolean;
  health?: DashboardProviderHealthView;
  /** Set only when the snapshot knows both versions and they differ (M10 badge). */
  update?: { installed: string; latest: string };
};

export function keyChoices<T>(values: readonly T[]): Array<KeyedChoice<T>> {
  return values.slice(0, SELECTION_KEYS.length).map((value, index) => {
    const key = SELECTION_KEYS[index];
    if (key === undefined) {
      throw new Error("Selection key index exceeded configured key range.");
    }
    return { key, value };
  });
}

export function choiceValueByKey<T>(
  choices: readonly KeyedChoice<T>[],
  input: string,
): T | undefined {
  return choices.find((choice) => choice.key === input)?.value;
}

export function isSelectionKey(input: string): input is SelectionKey {
  return SELECTION_KEYS.includes(input as SelectionKey);
}

export function selectProjectGroups(snapshot: DashboardSnapshotView, state: DashboardViewState) {
  const sessionRows = selectDashboardSessionRows(snapshot);
  return snapshot.projects.map((project) => {
    const collapsed = state.collapsedProjectIds.has(project.id);
    const matchingRows = sessionRows
      .filter((row) => row.worktree.projectId === project.id)
      .filter((row) =>
        matchesDashboardSessionSearch(
          {
            displayTitle: sessionRowDisplayTitle(row, state.localRows),
            branch: row.worktree.branch,
            projectLabel: project.label,
            statusValue: row.session.status.value,
            statusReason: row.session.status.reason,
            harnessProvider: row.session.harness.provider,
            terminalProvider: row.session.terminal?.provider,
          },
          state.searchQuery,
        ),
      )
      .sort((left, right) => compareRows(left, right, state.localRows));
    return {
      project,
      rows: collapsed ? [] : matchingRows,
      collapsed,
    };
  });
}

export function selectDashboardSessionRows(snapshot: DashboardSnapshotView): DashboardSessionRow[] {
  const worktreesById = new Map(snapshot.rows.map((row) => [row.id, row]));
  return snapshot.sessions.flatMap((session) => {
    const source = worktreesById.get(session.worktreeId);
    if (source === undefined || source.projectId !== session.projectId) {
      return [];
    }
    return [dashboardSessionRow(session, source)];
  });
}

export function selectDashboardSessionRow(
  snapshot: DashboardSnapshotView,
  sessionId: SessionId,
): DashboardSessionRow | undefined {
  return selectDashboardSessionRows(snapshot).find((row) => row.id === sessionId);
}

/**
 * The project choosers (collapse / settings) list every project in snapshot
 * order, unaffected by search or collapse — so the engine spec and the sheet
 * view can key off the snapshot alone and stay in exact agreement.
 */
export function selectProjectChooserChoices(
  snapshot: DashboardSnapshotView,
): Array<KeyedChoice<DashboardProjectView>> {
  return keyChoices(snapshot.projects);
}

export function selectNewSessionProject(
  snapshot: DashboardSnapshotView,
  selectedProjectId: ProjectId,
): DashboardProjectView | undefined {
  return (
    snapshot.projects.find((project) => project.id === selectedProjectId) ?? snapshot.projects[0]
  );
}

export function selectNewSessionProjectChoices(
  snapshot: DashboardSnapshotView,
): Array<KeyedChoice<DashboardProjectView>> {
  return keyChoices(snapshot.projects);
}

export function selectNewSessionHarnessOptions(
  snapshot: DashboardSnapshotView,
  _project: DashboardProjectView,
): NewSessionHarnessOption[] {
  const configured = configuredHarnesses(snapshot);
  const labels = new Map(configured.map((harness) => [harness.id, harness.label]));
  const byId = new Map(configured.map((harness) => [harness.id, harness]));
  const orderedIds = configured.map((harness) => harness.id);
  const seen = new Set<string>();
  const options: NewSessionHarnessOption[] = [];

  for (const id of orderedIds) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const health = snapshot.providerHealth[id];
    const option: NewSessionHarnessOption = {
      id,
      label: labels.get(id) ?? id,
      status: health?.status ?? "unknown",
      createBlocked: health?.status === "unavailable",
    };
    if (health !== undefined) {
      option.health = health;
    }
    const harness = byId.get(id);
    if (
      harness?.updateAvailable === true &&
      harness.installedVersion !== undefined &&
      harness.latestVersion !== undefined
    ) {
      option.update = { installed: harness.installedVersion, latest: harness.latestVersion };
    }
    options.push(option);
  }

  return options;
}

export function selectNewSessionHarnessChoices(
  snapshot: DashboardSnapshotView,
  project: DashboardProjectView,
): Array<KeyedChoice<NewSessionHarnessOption>> {
  return keyChoices(selectNewSessionHarnessOptions(snapshot, project));
}

export function sessionForWorktreeRow(
  row: DashboardWorktreeRowView,
  sessions: readonly DashboardSessionView[],
): DashboardSessionView | undefined {
  const sessionId = row.agent?.sessionId;
  if (sessionId !== undefined) {
    const direct = sessions.find(
      (session) => session.origin === "station" && session.id === sessionId,
    );
    if (direct !== undefined) {
      return direct;
    }
  }
  const runId = row.agent?.runId;
  if (runId !== undefined) {
    const external = sessions.find(
      (session) => session.origin === "external" && session.harness.runId === runId,
    );
    if (external !== undefined) return external;
  }
  return sessions.find((session) => session.worktreeId === row.id);
}

export function sessionRowDisplayTitle(
  row: Pick<DashboardSessionRow, "session" | "worktree">,
  localRows: DashboardLocalRowsView,
): string {
  return pendingRenameTitles(localRows)[row.session.id]?.title ?? row.worktree.title;
}

/**
 * The default harness to render as a project's current selection: the optimistic
 * pending value (set the moment a new agent is picked) until the snapshot
 * confirms it, otherwise the snapshot value. `pending` drives the "updating…"
 * cue while the change is in flight.
 */
export function selectProjectDefaultHarness(
  localRows: DashboardLocalRowsView,
  project: DashboardProjectView,
): { harness: ProviderId; pending: boolean } {
  const pending = pendingProjectDefaultHarnesses(localRows)[project.id];
  if (pending === undefined) {
    return { harness: project.defaults.harness, pending: false };
  }
  return { harness: pending.harness, pending: true };
}

function compareRows(
  left: DashboardSessionRow,
  right: DashboardSessionRow,
  localRows: DashboardLocalRowsView,
): number {
  return (
    sessionRowDisplayTitle(left, localRows).localeCompare(
      sessionRowDisplayTitle(right, localRows),
    ) ||
    left.worktree.branch.localeCompare(right.worktree.branch) ||
    left.worktree.path.localeCompare(right.worktree.path) ||
    left.id.localeCompare(right.id)
  );
}

function dashboardSessionRow(
  session: DashboardSessionView,
  source: DashboardWorktreeRowView,
): DashboardSessionRow {
  return {
    id: session.id,
    session,
    worktree: source,
    presentation: sessionPresentation(session, source),
  };
}

function sessionPresentation(
  session: DashboardSessionView,
  source: DashboardWorktreeRowView,
): DashboardWorktreeRowView {
  const row: Mutable<DashboardWorktreeRowView> = {
    ...source,
    display: sessionDisplay(session),
  };
  row.agent = sessionAgent(session, source);
  if (session.terminal === undefined) {
    delete row.terminal;
  } else {
    row.terminal = session.terminal;
  }
  if (session.origin === "external") {
    delete row.recovery;
  }
  return row;
}

function sessionAgent(
  session: DashboardSessionView,
  source: DashboardWorktreeRowView,
): NonNullable<DashboardWorktreeRowView["agent"]> {
  const agent: Mutable<NonNullable<DashboardWorktreeRowView["agent"]>> = {
    harness: session.harness.provider,
    state: session.status.value,
    confidence: session.status.confidence,
    reason: session.status.reason,
    updatedAt: session.status.updatedAt,
  };
  if (session.harness.pid !== undefined) agent.pid = session.harness.pid;
  if (session.harness.runId !== undefined) agent.runId = session.harness.runId;
  if (session.origin === "station") agent.sessionId = session.id;
  if (session.status.attention !== undefined) agent.attention = session.status.attention;
  if (sourceAgentMatchesSession(source, session) && source.agent?.turnReadiness !== undefined) {
    agent.turnReadiness = source.agent.turnReadiness;
  }
  return agent;
}

function sourceAgentMatchesSession(
  source: DashboardWorktreeRowView,
  session: DashboardSessionView,
): boolean {
  if (session.origin === "station") {
    return source.agent?.sessionId === session.id;
  }
  return session.harness.runId !== undefined && source.agent?.runId === session.harness.runId;
}

function sessionDisplay(session: DashboardSessionView): DashboardWorktreeRowView["display"] {
  const value = session.status.value;
  const display: Mutable<DashboardWorktreeRowView["display"]> = {
    statusLabel:
      value === "needs_attention" ? "needs attention" : value === "none" ? "no agent" : value,
    sortPriority: sessionStatusPriority(value),
    alert: value === "needs_attention" || value === "stuck",
    reason: session.status.reason,
  };
  if (value === "stuck") display.warning = true;
  return display;
}

function sessionStatusPriority(value: DashboardSessionView["status"]["value"]): number {
  switch (value) {
    case "needs_attention":
      return 10;
    case "stuck":
      return 20;
    case "working":
      return 30;
    case "starting":
      return 35;
    case "idle":
      return 40;
    case "unknown":
      return 50;
    case "exited":
      return 60;
    case "none":
      return 70;
  }
}

function configuredHarnesses(
  snapshot: DashboardSnapshotView,
): readonly DashboardSnapshotHarnessView[] {
  if (snapshot.harnesses !== undefined) {
    return snapshot.harnesses;
  }

  const healthHarnesses = Object.values(snapshot.providerHealth)
    .filter((health) => health.providerType === "harness")
    .map((health) => ({
      id: health.providerId,
      label: health.providerId,
    }));

  return healthHarnesses;
}
