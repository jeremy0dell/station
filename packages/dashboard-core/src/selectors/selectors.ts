import type {
  ProjectId,
  ProviderHealth,
  ProviderId,
  SessionGroupId,
  SessionId,
} from "@station/contracts";
import { pendingProjectDefaultHarnesses } from "../state/localRows.js";
import type { DashboardSnapshotView, DashboardViewState } from "../state/types.js";

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

/** One semantic picker item; shortcuts are accelerators, not list membership. */
export type SelectionChoice<T> = {
  key?: SelectionKey;
  value: T;
};

type DashboardProjectView = DashboardSnapshotView["projects"][number];
type DashboardProviderHealthView = DashboardSnapshotView["providerHealth"][ProviderId];
type DashboardSnapshotHarnessView = NonNullable<DashboardSnapshotView["harnesses"]>[number];
type DashboardLocalRowsView = DashboardViewState["localRows"];

export type NewSessionHarnessOption = {
  id: ProviderId;
  label: string;
  status: ProviderHealth["status"];
  createBlocked: boolean;
  health?: DashboardProviderHealthView;
  /** Set only when the snapshot knows both versions and they differ (M10 badge). */
  update?: { installed: string; latest: string };
};

export type NewSessionGroupOption = DashboardSnapshotView["sessionGroups"][number];
export type MoveToGroupSessionContext = {
  session: DashboardSnapshotView["sessions"][number];
  project: DashboardSnapshotView["projects"][number];
  currentGroup?: NewSessionGroupOption;
};

export function selectionChoices<T>(values: readonly T[]): Array<SelectionChoice<T>> {
  return values.map((value, index) => {
    const key = SELECTION_KEYS[index];
    return key === undefined ? { value } : { key, value };
  });
}

export function keyedSelectionChoices<T>(
  choices: readonly SelectionChoice<T>[],
): Array<KeyedChoice<T>> {
  return choices.flatMap((choice) =>
    choice.key === undefined ? [] : [{ key: choice.key, value: choice.value }],
  );
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

/**
 * The project choosers (collapse / settings) list every project in snapshot
 * order, unaffected by search or collapse — so the engine spec and the sheet
 * view can key off the snapshot alone and stay in exact agreement.
 */
export function selectProjectChooserChoices(
  snapshot: DashboardSnapshotView,
): Array<SelectionChoice<DashboardProjectView>> {
  return selectionChoices(snapshot.projects);
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
): Array<SelectionChoice<DashboardProjectView>> {
  return selectionChoices(snapshot.projects);
}

export function selectNewSessionGroupChoices(
  snapshot: DashboardSnapshotView,
  projectId: ProjectId,
): Array<SelectionChoice<NewSessionGroupOption>> {
  return selectionChoices(
    snapshot.sessionGroups.filter(
      (group) => group.projectId === projectId && group.parentGroupId === undefined,
    ),
  );
}

export function selectNewSessionRootGroup(
  snapshot: DashboardSnapshotView,
  projectId: ProjectId,
  groupId: SessionGroupId,
): NewSessionGroupOption | undefined {
  return snapshot.sessionGroups.find(
    (group) =>
      group.id === groupId && group.projectId === projectId && group.parentGroupId === undefined,
  );
}

/** Resolves the latest canonical session, Project, and exclusive Group membership. */
export function selectMoveToGroupSessionContext(
  snapshot: DashboardSnapshotView,
  sessionId: SessionId,
): MoveToGroupSessionContext | undefined {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) return undefined;
  const project = snapshot.projects.find((candidate) => candidate.id === session.projectId);
  if (project === undefined) return undefined;
  const currentGroup = snapshot.sessionGroups.find((group) => group.sessionIds.includes(sessionId));
  const context: MoveToGroupSessionContext = { session, project };
  if (currentGroup !== undefined) context.currentGroup = currentGroup;
  return context;
}

export function selectMoveToGroupChoices(
  snapshot: DashboardSnapshotView,
  sessionId: SessionId,
): Array<SelectionChoice<NewSessionGroupOption>> {
  const context = selectMoveToGroupSessionContext(snapshot, sessionId);
  return context === undefined ? [] : selectNewSessionGroupChoices(snapshot, context.project.id);
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
): Array<SelectionChoice<NewSessionHarnessOption>> {
  return selectionChoices(selectNewSessionHarnessOptions(snapshot, project));
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
