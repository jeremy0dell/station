import type { ProviderHealth, ProviderId } from "@station/contracts";
import { pendingProjectDefaultHarnesses } from "../state/localRows.js";
import type { DashboardSnapshotView, DashboardViewState } from "../state/types.js";
import { type SelectionChoice, selectionChoices } from "./keyedChoices.js";

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

  return Object.values(snapshot.providerHealth)
    .filter((health) => health.providerType === "harness")
    .map((health) => ({
      id: health.provider,
      label: health.provider,
    }));
}
