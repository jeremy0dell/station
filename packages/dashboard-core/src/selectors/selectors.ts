import type {
  ProjectId,
  ProjectView,
  ProviderHealth,
  ProviderId,
  SessionView,
  StationSnapshot,
  WorktreeRow,
} from "@station/contracts";
import {
  pendingProjectDefaultHarnesses,
  pendingRenameTitles,
  type TuiLocalRows,
} from "../state/localRows.js";
import type { TuiViewState } from "../state/types.js";

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

export type ProjectGroup = {
  project: ProjectView;
  rows: WorktreeRow[];
  collapsed: boolean;
};

export type NewSessionHarnessOption = {
  id: ProviderId;
  label: string;
  status: ProviderHealth["status"];
  createBlocked: boolean;
  health?: ProviderHealth;
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

export function selectProjectGroups(
  snapshot: StationSnapshot,
  state: TuiViewState,
): ProjectGroup[] {
  const query = normalizeSearch(state.searchQuery);
  return snapshot.projects.map((project) => {
    const collapsed = state.collapsedProjectIds.has(project.id);
    const matchingRows = snapshot.rows
      .filter((row) => row.projectId === project.id)
      .filter((row) =>
        rowMatchesSearch(
          row,
          project,
          query,
          worktreeRowDisplayTitle(row, snapshot.sessions, state.localRows),
        ),
      )
      .sort((left, right) => compareRows(left, right, snapshot.sessions, state.localRows));
    return {
      project,
      rows: collapsed ? [] : matchingRows,
      collapsed,
    };
  });
}

export function selectVisibleRows(snapshot: StationSnapshot, state: TuiViewState): WorktreeRow[] {
  return selectProjectGroups(snapshot, state).flatMap((group) => group.rows);
}

export function selectDashboardRowChoices(
  snapshot: StationSnapshot,
  state: TuiViewState,
): Array<KeyedChoice<WorktreeRow>> {
  return keyChoices(selectVisibleRows(snapshot, state));
}

export function selectProjectChoices(
  snapshot: StationSnapshot,
  state: TuiViewState,
): Array<KeyedChoice<ProjectView>> {
  return keyChoices(selectProjectGroups(snapshot, state).map((group) => group.project));
}

export function selectNewSessionProject(
  snapshot: StationSnapshot,
  selectedProjectId: ProjectId,
): ProjectView | undefined {
  return (
    snapshot.projects.find((project) => project.id === selectedProjectId) ?? snapshot.projects[0]
  );
}

export function selectNewSessionProjectChoices(
  snapshot: StationSnapshot,
): Array<KeyedChoice<ProjectView>> {
  return keyChoices(snapshot.projects);
}

export function selectNewSessionHarnessOptions(
  snapshot: StationSnapshot,
  _project: ProjectView,
): NewSessionHarnessOption[] {
  const configured = configuredHarnesses(snapshot);
  const labels = new Map(configured.map((harness) => [harness.id, harness.label]));
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
    options.push(option);
  }

  return options;
}

export function selectNewSessionHarnessChoices(
  snapshot: StationSnapshot,
  project: ProjectView,
): Array<KeyedChoice<NewSessionHarnessOption>> {
  return keyChoices(selectNewSessionHarnessOptions(snapshot, project));
}

export function sessionForWorktreeRow(
  row: WorktreeRow,
  sessions: readonly SessionView[],
): SessionView | undefined {
  const sessionId = row.agent?.sessionId;
  if (sessionId !== undefined) {
    const direct = sessions.find((session) => session.id === sessionId);
    if (direct !== undefined) {
      return direct;
    }
  }
  return sessions.find((session) => session.worktreeId === row.id);
}

export function worktreeRowDisplayTitle(
  row: WorktreeRow,
  sessions: readonly SessionView[],
  localRows: TuiLocalRows,
): string {
  const session = sessionForWorktreeRow(row, sessions);
  if (session === undefined) {
    return row.branch;
  }
  return pendingRenameTitles(localRows)[session.id]?.title ?? session.title;
}

/**
 * The default harness to render as a project's current selection: the optimistic
 * pending value (set the moment a new agent is picked) until the snapshot
 * confirms it, otherwise the snapshot value. `pending` drives the "updating…"
 * cue while the change is in flight.
 */
export function selectProjectDefaultHarness(
  localRows: TuiLocalRows,
  project: ProjectView,
): { harness: ProviderId; pending: boolean } {
  const pending = pendingProjectDefaultHarnesses(localRows)[project.id];
  if (pending === undefined) {
    return { harness: project.defaults.harness, pending: false };
  }
  return { harness: pending.harness, pending: true };
}

function compareRows(
  left: WorktreeRow,
  right: WorktreeRow,
  sessions: readonly SessionView[],
  localRows: TuiLocalRows,
): number {
  return (
    worktreeRowDisplayTitle(left, sessions, localRows).localeCompare(
      worktreeRowDisplayTitle(right, sessions, localRows),
    ) ||
    left.branch.localeCompare(right.branch) ||
    left.path.localeCompare(right.path) ||
    left.id.localeCompare(right.id)
  );
}

function rowMatchesSearch(
  row: WorktreeRow,
  project: ProjectView,
  query: string,
  displayTitle: string,
): boolean {
  if (query.length === 0) {
    return true;
  }
  return [
    displayTitle,
    row.branch,
    row.display.statusLabel,
    row.display.reason,
    row.agent?.harness,
    row.terminal?.provider,
    project.label,
  ].some((value) => normalizeSearch(value ?? "").includes(query));
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function configuredHarnesses(snapshot: StationSnapshot) {
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
