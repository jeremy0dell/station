import type { AgentState, ProjectId, ProviderId, SessionGroupId } from "@station/contracts";
import type {
  DashboardFilterCondition,
  DashboardScreenView,
  DashboardViewState,
} from "../state/types.js";
import {
  type DashboardFilterSummarySegment,
  dashboardFilterConditionsWithSelection,
  dashboardPersistentFilterHasCriteria,
  dashboardPersistentFilterSummarySegments,
  normalizeDashboardFilterConditions,
} from "./dashboardFilterConditions.js";

type DashboardPersistentFilterView = NonNullable<DashboardViewState["persistentFilter"]>;

export type DashboardPersistentFilterMatchRange = {
  start: number;
  end: number;
};

export type DashboardPersistentFilterVisibleFields = {
  title: string;
  agent?: string;
  activity?: string;
};

export type DashboardPersistentFilterProjectCandidate = {
  projectId: ProjectId;
  projectLabel: string;
};

export type DashboardPersistentFilterGroupCandidate = {
  groupId: SessionGroupId;
  projectId: ProjectId;
  groupLabel: string;
};

export type DashboardPersistentFilterCandidate = {
  kind: "session" | "optimistic";
  id: string;
  projectId: ProjectId;
  groupId?: SessionGroupId;
  visibleFields: DashboardPersistentFilterVisibleFields;
  conditionValues: {
    status?: AgentState;
    agent?: ProviderId;
  };
};

export type DashboardPersistentFilterRowMatch = {
  matched: boolean;
  dimmed: boolean;
  ranges: {
    title: readonly DashboardPersistentFilterMatchRange[];
    agent: readonly DashboardPersistentFilterMatchRange[];
    activity: readonly DashboardPersistentFilterMatchRange[];
    projectLabel: readonly DashboardPersistentFilterMatchRange[];
    groupLabel: readonly DashboardPersistentFilterMatchRange[];
  };
};

export type DashboardPersistentFilterProjectMatch = {
  matched: boolean;
  labelRanges: readonly DashboardPersistentFilterMatchRange[];
};

export type DashboardPersistentFilterGroupMatch = {
  matched: boolean;
  labelRanges: readonly DashboardPersistentFilterMatchRange[];
};

/**
 * Draft state previews all rows softly; applied free text and conditions hard-project rows while
 * text highlighting stays visible-only and durable Project and Group headers remain as context.
 */
export type DashboardPersistentFilterProjection = {
  source: "draft" | "applied";
  query: string;
  conditions: readonly DashboardFilterCondition[];
  summarySegments: readonly DashboardFilterSummarySegment[];
  active: boolean;
  draft?: { value: string; cursor: number };
  matchCount: number;
  totalCount: number;
  zeroMatches: boolean;
  rows: ReadonlyMap<string, DashboardPersistentFilterRowMatch>;
  projects: ReadonlyMap<ProjectId, DashboardPersistentFilterProjectMatch>;
  groups: ReadonlyMap<SessionGroupId, DashboardPersistentFilterGroupMatch>;
};

export function selectDashboardPersistentFilter({
  candidates,
  projects,
  groups,
  screen,
  applied,
}: {
  candidates: readonly DashboardPersistentFilterCandidate[];
  projects: readonly DashboardPersistentFilterProjectCandidate[];
  groups: readonly DashboardPersistentFilterGroupCandidate[];
  screen: DashboardScreenView;
  applied?: DashboardPersistentFilterView;
}): DashboardPersistentFilterProjection | undefined {
  const selected = selectedPersistentFilter(screen, applied);
  if (selected === undefined) {
    return undefined;
  }

  const query = selected.filter.query.trim();
  const conditions = normalizeDashboardFilterConditions(selected.filter.conditions ?? []);
  const active = dashboardPersistentFilterHasCriteria({ query, conditions });
  const foldedQuery = foldPersistentFilterText(query).text;
  const selectedStatuses = conditionValueIds(conditions, "status");
  const selectedProjects = conditionValueIds(conditions, "project");
  const selectedAgents = conditionValueIds(conditions, "agent");
  const projectLabelRanges = new Map<ProjectId, DashboardPersistentFilterMatchRange[]>();
  for (const project of projects) {
    projectLabelRanges.set(project.projectId, matchRanges(project.projectLabel, foldedQuery));
  }
  const groupLabelRanges = new Map<SessionGroupId, DashboardPersistentFilterMatchRange[]>();
  for (const group of groups) {
    groupLabelRanges.set(group.groupId, matchRanges(group.groupLabel, foldedQuery));
  }

  const rows = new Map<string, DashboardPersistentFilterRowMatch>();
  const projectsWithMatchedRows = new Set<ProjectId>();
  const groupsWithMatchedRows = new Set<SessionGroupId>();
  let matchCount = 0;
  for (const candidate of candidates) {
    const ranges = {
      title: matchRanges(candidate.visibleFields.title, foldedQuery),
      agent: matchRanges(candidate.visibleFields.agent ?? "", foldedQuery),
      activity: matchRanges(candidate.visibleFields.activity ?? "", foldedQuery),
      projectLabel: projectLabelRanges.get(candidate.projectId) ?? [],
      groupLabel:
        candidate.groupId === undefined ? [] : (groupLabelRanges.get(candidate.groupId) ?? []),
    };
    const textMatched =
      foldedQuery.length === 0 ||
      ranges.title.length > 0 ||
      ranges.agent.length > 0 ||
      ranges.activity.length > 0 ||
      ranges.projectLabel.length > 0 ||
      ranges.groupLabel.length > 0;
    const statusMatched =
      selectedStatuses.size === 0 ||
      (candidate.conditionValues.status !== undefined &&
        selectedStatuses.has(candidate.conditionValues.status));
    const projectMatched = selectedProjects.size === 0 || selectedProjects.has(candidate.projectId);
    const agentMatched =
      selectedAgents.size === 0 ||
      (candidate.conditionValues.agent !== undefined &&
        selectedAgents.has(candidate.conditionValues.agent));
    const matched = textMatched && statusMatched && projectMatched && agentMatched;
    if (matched) {
      matchCount += 1;
      projectsWithMatchedRows.add(candidate.projectId);
      if (candidate.groupId !== undefined) {
        groupsWithMatchedRows.add(candidate.groupId);
      }
    }
    rows.set(candidate.id, { matched, dimmed: !matched, ranges });
  }

  const groupMatches = new Map<SessionGroupId, DashboardPersistentFilterGroupMatch>();
  const projectsWithMatchedGroups = new Set<ProjectId>();
  for (const group of groups) {
    const labelRanges = groupLabelRanges.get(group.groupId) ?? [];
    const projectAllowed = selectedProjects.size === 0 || selectedProjects.has(group.projectId);
    const textAllowsGroup = foldedQuery.length === 0 || labelRanges.length > 0;
    const rowConditionRequiresEvidence = selectedStatuses.size > 0 || selectedAgents.size > 0;
    const matched =
      groupsWithMatchedRows.has(group.groupId) ||
      (!rowConditionRequiresEvidence && projectAllowed && textAllowsGroup);
    if (matched) {
      projectsWithMatchedGroups.add(group.projectId);
    }
    groupMatches.set(group.groupId, { matched, labelRanges });
  }

  const projectMatches = new Map<ProjectId, DashboardPersistentFilterProjectMatch>();
  for (const [projectId, labelRanges] of projectLabelRanges) {
    const projectAllowed = selectedProjects.size === 0 || selectedProjects.has(projectId);
    const textAllowsProject = foldedQuery.length === 0 || labelRanges.length > 0;
    const rowConditionRequiresEvidence = selectedStatuses.size > 0 || selectedAgents.size > 0;
    const matched =
      projectsWithMatchedRows.has(projectId) ||
      projectsWithMatchedGroups.has(projectId) ||
      (!rowConditionRequiresEvidence && projectAllowed && textAllowsProject);
    projectMatches.set(projectId, { matched, labelRanges });
  }

  const projection: DashboardPersistentFilterProjection = {
    source: selected.source,
    query,
    conditions,
    summarySegments: dashboardPersistentFilterSummarySegments({ query, conditions }),
    active,
    matchCount,
    totalCount: candidates.length,
    zeroMatches: active && matchCount === 0,
    rows,
    projects: projectMatches,
    groups: groupMatches,
  };
  if (screen.name === "persistentFilter") {
    projection.draft = screen.draft;
  }
  return projection;
}

function selectedPersistentFilter(
  screen: DashboardScreenView,
  applied: DashboardPersistentFilterView | undefined,
): { source: "draft" | "applied"; filter: DashboardPersistentFilterView } | undefined {
  if (screen.name === "persistentFilter") {
    const editor = screen.conditionEditor;
    const conditions =
      editor?.stage === "values"
        ? dashboardFilterConditionsWithSelection(
            screen.draftConditions,
            editor.field,
            editor.options,
            editor.selectedIds,
          )
        : screen.draftConditions;
    return {
      source: "draft",
      filter: { query: screen.draft.value, conditions },
    };
  }
  return applied === undefined ? undefined : { source: "applied", filter: applied };
}

function conditionValueIds(
  conditions: readonly DashboardFilterCondition[],
  field: DashboardFilterCondition["field"],
): ReadonlySet<string> {
  return new Set(
    conditions.flatMap((condition) =>
      condition.field === field ? condition.values.map((value) => value.id) : [],
    ),
  );
}

type FoldedSourceOffset = {
  start: number;
  end: number;
};

type FoldedPersistentFilterText = {
  text: string;
  sourceOffsets: readonly FoldedSourceOffset[];
};

function matchRanges(value: string, foldedQuery: string): DashboardPersistentFilterMatchRange[] {
  if (foldedQuery.length === 0) {
    return [];
  }
  const foldedValue = foldPersistentFilterText(value);
  const ranges: DashboardPersistentFilterMatchRange[] = [];
  let from = 0;
  while (from <= foldedValue.text.length - foldedQuery.length) {
    const foldedStart = foldedValue.text.indexOf(foldedQuery, from);
    if (foldedStart < 0) {
      break;
    }
    const foldedEnd = foldedStart + foldedQuery.length;
    const firstOffset = foldedValue.sourceOffsets[foldedStart];
    const lastOffset = foldedValue.sourceOffsets[foldedEnd - 1];
    if (firstOffset !== undefined && lastOffset !== undefined) {
      ranges.push({ start: firstOffset.start, end: lastOffset.end });
    }
    from = foldedEnd;
  }
  return ranges;
}

/**
 * Folds each Unicode scalar independently so matching is locale-neutral and every folded code
 * unit retains the source span that must be highlighted.
 */
function foldPersistentFilterText(value: string): FoldedPersistentFilterText {
  let text = "";
  let sourceStart = 0;
  const sourceOffsets: FoldedSourceOffset[] = [];
  for (const sourceCharacter of value) {
    const sourceEnd = sourceStart + sourceCharacter.length;
    const foldedCharacter = sourceCharacter.toLowerCase();
    text += foldedCharacter;
    for (let index = 0; index < foldedCharacter.length; index += 1) {
      sourceOffsets.push({ start: sourceStart, end: sourceEnd });
    }
    sourceStart = sourceEnd;
  }
  return { text, sourceOffsets };
}
