import type { ProviderId, SessionView } from "@station/contracts";

export type DashboardSessionSearchProjection = {
  displayTitle: string;
  branch: string;
  projectLabel: string;
  statusValue: SessionView["status"]["value"];
  statusReason: SessionView["status"]["reason"];
  harnessProvider: SessionView["harness"]["provider"];
  terminalProvider: NonNullable<SessionView["terminal"]>["provider"] | undefined;
};

export type DashboardOptimisticSearchProjection = {
  title: string;
  branch: string;
  projectLabel: string;
  pendingHarnessProvider: ProviderId | undefined;
};

export function matchesDashboardSessionSearch(
  projection: DashboardSessionSearchProjection,
  searchQuery: string,
): boolean {
  return matchesDashboardSearch(searchQuery, [
    projection.displayTitle,
    projection.branch,
    projection.statusValue,
    projection.statusReason,
    projection.harnessProvider,
    projection.terminalProvider,
    projection.projectLabel,
  ]);
}

export function matchesDashboardOptimisticSearch(
  projection: DashboardOptimisticSearchProjection,
  searchQuery: string,
): boolean {
  return matchesDashboardSearch(searchQuery, [
    projection.title,
    projection.branch,
    projection.projectLabel,
    projection.pendingHarnessProvider,
  ]);
}

function matchesDashboardSearch(
  searchQuery: string,
  values: readonly (string | undefined)[],
): boolean {
  const query = normalizeDashboardSearch(searchQuery);
  return (
    query.length === 0 ||
    values.some((value) => normalizeDashboardSearch(value ?? "").includes(query))
  );
}

function normalizeDashboardSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}
