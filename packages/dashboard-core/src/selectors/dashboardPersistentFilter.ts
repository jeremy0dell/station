import type { ProjectId } from "@station/contracts";
import type { DashboardPersistentFilter, TuiScreen } from "../state/types.js";

export type DashboardPersistentFilterMatchRange = {
  start: number;
  end: number;
};

export type DashboardPersistentFilterVisibleFields = {
  title: string;
  agent?: string;
  status?: string;
};

export type DashboardPersistentFilterCandidate = {
  kind: "session" | "optimistic";
  id: string;
  projectId: ProjectId;
  projectLabel: string;
  visibleFields: DashboardPersistentFilterVisibleFields;
};

export type DashboardPersistentFilterRowMatch = {
  matched: boolean;
  dimmed: boolean;
  ranges: {
    title: readonly DashboardPersistentFilterMatchRange[];
    agent: readonly DashboardPersistentFilterMatchRange[];
    status: readonly DashboardPersistentFilterMatchRange[];
    projectLabel: readonly DashboardPersistentFilterMatchRange[];
  };
};

export type DashboardPersistentFilterProjectMatch = {
  matched: boolean;
  labelRanges: readonly DashboardPersistentFilterMatchRange[];
};

/**
 * Draft text overrides the applied query only while editing, while applied state remains
 * dashboard-local. The #395 projection preserves row order and visibility, and its match
 * metadata identifies every displayed highlight so renderers never infer matching behavior.
 */
export type DashboardPersistentFilterProjection = {
  source: "draft" | "applied";
  query: string;
  draft?: { value: string; cursor: number };
  matchCount: number;
  totalCount: number;
  zeroMatches: boolean;
  rows: ReadonlyMap<string, DashboardPersistentFilterRowMatch>;
  projects: ReadonlyMap<ProjectId, DashboardPersistentFilterProjectMatch>;
};

export function selectDashboardPersistentFilter({
  candidates,
  screen,
  applied,
}: {
  candidates: readonly DashboardPersistentFilterCandidate[];
  screen: TuiScreen;
  applied?: DashboardPersistentFilter;
}): DashboardPersistentFilterProjection | undefined {
  const selected = selectedPersistentFilterQuery(screen, applied);
  if (selected === undefined) {
    return undefined;
  }

  const query = selected.query.trim();
  const normalizedQuery = normalizePersistentFilterText(query);
  const projectLabelRanges = new Map<ProjectId, DashboardPersistentFilterMatchRange[]>();
  for (const candidate of candidates) {
    if (!projectLabelRanges.has(candidate.projectId)) {
      projectLabelRanges.set(
        candidate.projectId,
        matchRanges(candidate.projectLabel, normalizedQuery),
      );
    }
  }

  const rows = new Map<string, DashboardPersistentFilterRowMatch>();
  let matchCount = 0;
  for (const candidate of candidates) {
    const ranges = {
      title: matchRanges(candidate.visibleFields.title, normalizedQuery),
      agent: matchRanges(candidate.visibleFields.agent ?? "", normalizedQuery),
      status: matchRanges(candidate.visibleFields.status ?? "", normalizedQuery),
      projectLabel: projectLabelRanges.get(candidate.projectId) ?? [],
    };
    const matched =
      normalizedQuery.length === 0 ||
      ranges.title.length > 0 ||
      ranges.agent.length > 0 ||
      ranges.status.length > 0 ||
      ranges.projectLabel.length > 0;
    if (matched) {
      matchCount += 1;
    }
    rows.set(candidate.id, { matched, dimmed: !matched, ranges });
  }

  const projects = new Map<ProjectId, DashboardPersistentFilterProjectMatch>();
  for (const [projectId, labelRanges] of projectLabelRanges) {
    const matched =
      normalizedQuery.length === 0 ||
      labelRanges.length > 0 ||
      candidates.some(
        (candidate) =>
          candidate.projectId === projectId && rows.get(candidate.id)?.matched === true,
      );
    projects.set(projectId, { matched, labelRanges });
  }

  const projection: DashboardPersistentFilterProjection = {
    source: selected.source,
    query,
    matchCount,
    totalCount: candidates.length,
    zeroMatches: normalizedQuery.length > 0 && matchCount === 0,
    rows,
    projects,
  };
  if (screen.name === "persistentFilter") {
    projection.draft = screen.draft;
  }
  return projection;
}

function selectedPersistentFilterQuery(
  screen: TuiScreen,
  applied: DashboardPersistentFilter | undefined,
): { source: "draft" | "applied"; query: string } | undefined {
  if (screen.name === "persistentFilter") {
    return { source: "draft", query: screen.draft.value };
  }
  return applied === undefined ? undefined : { source: "applied", query: applied.query };
}

function matchRanges(
  value: string,
  normalizedQuery: string,
): DashboardPersistentFilterMatchRange[] {
  if (normalizedQuery.length === 0) {
    return [];
  }
  const normalizedValue = normalizePersistentFilterText(value);
  const ranges: DashboardPersistentFilterMatchRange[] = [];
  let from = 0;
  while (from <= normalizedValue.length - normalizedQuery.length) {
    const start = normalizedValue.indexOf(normalizedQuery, from);
    if (start < 0) {
      break;
    }
    const end = start + normalizedQuery.length;
    ranges.push({ start, end });
    from = end;
  }
  return ranges;
}

function normalizePersistentFilterText(value: string): string {
  return value.toLocaleLowerCase();
}
