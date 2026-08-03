import type { ProjectId } from "@station/contracts";
import type { DashboardPersistentFilter, TuiScreen } from "../state/types.js";

export type DashboardPersistentFilterMatchRange = {
  start: number;
  end: number;
};

export type DashboardPersistentFilterVisibleFields = {
  title: string;
  agent?: string;
  activity?: string;
};

export type DashboardPersistentFilterHiddenField = "branch" | "status" | "reason" | "terminal";

/** Normalized searchable fields that are not guaranteed to appear in the rendered session row. */
export type DashboardPersistentFilterHiddenFields = {
  branch?: string;
  status?: string;
  reason?: string;
  terminal?: string;
};

/** The first hidden-only match in branch → status → reason → terminal order. */
export type DashboardPersistentFilterMatchReason = {
  field: DashboardPersistentFilterHiddenField;
  value: string;
  ranges: readonly DashboardPersistentFilterMatchRange[];
};

export type DashboardPersistentFilterProjectCandidate = {
  projectId: ProjectId;
  projectLabel: string;
};

export type DashboardPersistentFilterCandidate = {
  kind: "session" | "optimistic";
  id: string;
  projectId: ProjectId;
  visibleFields: DashboardPersistentFilterVisibleFields;
  hiddenFields?: DashboardPersistentFilterHiddenFields;
};

export type DashboardPersistentFilterRowMatch = {
  matched: boolean;
  dimmed: boolean;
  ranges: {
    title: readonly DashboardPersistentFilterMatchRange[];
    agent: readonly DashboardPersistentFilterMatchRange[];
    activity: readonly DashboardPersistentFilterMatchRange[];
    projectLabel: readonly DashboardPersistentFilterMatchRange[];
  };
  reason?: DashboardPersistentFilterMatchReason;
};

export type DashboardPersistentFilterProjectMatch = {
  matched: boolean;
  labelRanges: readonly DashboardPersistentFilterMatchRange[];
};

/**
 * Draft state is a soft all-row preview, while a nonblank applied query drives hard viewport
 * projection. Every hard-projected hidden-only row carries at most one deterministic explanation.
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
  projects,
  screen,
  applied,
}: {
  candidates: readonly DashboardPersistentFilterCandidate[];
  projects: readonly DashboardPersistentFilterProjectCandidate[];
  screen: TuiScreen;
  applied?: DashboardPersistentFilter;
}): DashboardPersistentFilterProjection | undefined {
  const selected = selectedPersistentFilterQuery(screen, applied);
  if (selected === undefined) {
    return undefined;
  }

  const query = selected.query.trim();
  const foldedQuery = foldPersistentFilterText(query).text;
  const projectLabelRanges = new Map<ProjectId, DashboardPersistentFilterMatchRange[]>();
  for (const project of projects) {
    projectLabelRanges.set(project.projectId, matchRanges(project.projectLabel, foldedQuery));
  }

  const rows = new Map<string, DashboardPersistentFilterRowMatch>();
  const projectsWithMatchedRows = new Set<ProjectId>();
  let matchCount = 0;
  for (const candidate of candidates) {
    const ranges = {
      title: matchRanges(candidate.visibleFields.title, foldedQuery),
      agent: matchRanges(candidate.visibleFields.agent ?? "", foldedQuery),
      activity: matchRanges(candidate.visibleFields.activity ?? "", foldedQuery),
      projectLabel: projectLabelRanges.get(candidate.projectId) ?? [],
    };
    const visibleMatched =
      ranges.title.length > 0 ||
      ranges.agent.length > 0 ||
      ranges.activity.length > 0 ||
      ranges.projectLabel.length > 0;
    const reason =
      foldedQuery.length === 0 || visibleMatched
        ? undefined
        : hiddenMatchReason(candidate.hiddenFields, foldedQuery);
    const matched = foldedQuery.length === 0 || visibleMatched || reason !== undefined;
    if (matched) {
      matchCount += 1;
      projectsWithMatchedRows.add(candidate.projectId);
    }
    const rowMatch: DashboardPersistentFilterRowMatch = { matched, dimmed: !matched, ranges };
    if (reason !== undefined) {
      rowMatch.reason = reason;
    }
    rows.set(candidate.id, rowMatch);
  }

  const projectMatches = new Map<ProjectId, DashboardPersistentFilterProjectMatch>();
  for (const [projectId, labelRanges] of projectLabelRanges) {
    const matched =
      foldedQuery.length === 0 || labelRanges.length > 0 || projectsWithMatchedRows.has(projectId);
    projectMatches.set(projectId, { matched, labelRanges });
  }

  const projection: DashboardPersistentFilterProjection = {
    source: selected.source,
    query,
    matchCount,
    totalCount: candidates.length,
    zeroMatches: foldedQuery.length > 0 && matchCount === 0,
    rows,
    projects: projectMatches,
  };
  if (screen.name === "persistentFilter") {
    projection.draft = screen.draft;
  }
  return projection;
}

const HIDDEN_FIELD_ORDER: readonly DashboardPersistentFilterHiddenField[] = [
  "branch",
  "status",
  "reason",
  "terminal",
];

function hiddenMatchReason(
  fields: DashboardPersistentFilterHiddenFields | undefined,
  foldedQuery: string,
): DashboardPersistentFilterMatchReason | undefined {
  if (fields === undefined) {
    return undefined;
  }
  for (const field of HIDDEN_FIELD_ORDER) {
    const value = fields[field];
    if (value === undefined) {
      continue;
    }
    const ranges = matchRanges(value, foldedQuery);
    if (ranges.length > 0) {
      return { field, value, ranges };
    }
  }
  return undefined;
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
