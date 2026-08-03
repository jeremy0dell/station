import type { AgentState, ProjectId, ProviderId, StationSnapshot } from "@station/contracts";
import type {
  DashboardFilterCondition,
  DashboardFilterConditionField,
  DashboardFilterConditionOption,
  DashboardFilterStatusConditionValue,
  TuiViewState,
} from "../state/types.js";
import { SELECTION_KEYS } from "./selectors.js";

export const DASHBOARD_FILTER_CONDITION_FIELDS = ["status", "project", "agent"] as const;

export const DASHBOARD_FILTER_STATUS_VALUES: readonly DashboardFilterStatusConditionValue[] = [
  { id: "needs_attention", label: "Needs attention" },
  { id: "stuck", label: "Stuck" },
  { id: "working", label: "Working" },
  { id: "starting", label: "Starting" },
  { id: "idle", label: "Idle" },
  { id: "exited", label: "Exited" },
  { id: "none", label: "No agent" },
  { id: "unknown", label: "Unknown" },
];

export type DashboardFilterConditionOptions = Readonly<{
  status: readonly DashboardFilterConditionOption[];
  project: readonly DashboardFilterConditionOption[];
  agent: readonly DashboardFilterConditionOption[];
}>;

export type DashboardFilterSummarySegment = {
  text: string;
  role: "text" | "separator" | "field" | "operator" | "value";
  field?: DashboardFilterConditionField;
  valueId?: string;
};

/** Derives stable visible choices from normalized snapshot and optimistic dashboard evidence. */
export function selectDashboardFilterConditionOptions(
  snapshot: StationSnapshot | undefined,
  state: Pick<TuiViewState, "localRows">,
  conditions: readonly DashboardFilterCondition[],
): DashboardFilterConditionOptions {
  const selected = conditionOptionsByField(conditions);
  const projects = new Map<ProjectId, string>();
  const agents = new Map<ProviderId, string>();

  for (const project of snapshot?.projects ?? []) {
    projects.set(project.id, project.label);
  }
  for (const harness of snapshot?.harnesses ?? []) {
    agents.set(harness.id, harness.label);
  }
  for (const session of snapshot?.sessions ?? []) {
    if (!agents.has(session.harness.provider)) {
      agents.set(session.harness.provider, session.harness.provider);
    }
  }
  for (const row of state.localRows.pendingCreate) {
    if (row.harnessProvider !== undefined && !agents.has(row.harnessProvider)) {
      agents.set(row.harnessProvider, row.harnessProvider);
    }
  }

  for (const option of selected.project) {
    if (!projects.has(option.id as ProjectId)) {
      projects.set(option.id as ProjectId, option.label);
    }
  }
  for (const option of selected.agent) {
    if (!agents.has(option.id as ProviderId)) {
      agents.set(option.id as ProviderId, option.label);
    }
  }

  return {
    status: DASHBOARD_FILTER_STATUS_VALUES,
    project: sortedOptions(projects),
    agent: sortedOptions(agents),
  };
}

export function dashboardFilterConditionFieldLabel(field: DashboardFilterConditionField): string {
  switch (field) {
    case "status":
      return "Status";
    case "project":
      return "Project";
    case "agent":
      return "Agent";
  }
}

/** Removes empty/duplicate values and returns Status, Project, Agent in canonical order. */
export function normalizeDashboardFilterConditions(
  conditions: readonly DashboardFilterCondition[],
): DashboardFilterCondition[] {
  const statuses = uniqueConditionValues(
    conditions.flatMap((condition) => (condition.field === "status" ? condition.values : [])),
  ).sort(compareStatusValues);
  const projects = uniqueConditionValues(
    conditions.flatMap((condition) => (condition.field === "project" ? condition.values : [])),
  ).sort(compareLabels);
  const agents = uniqueConditionValues(
    conditions.flatMap((condition) => (condition.field === "agent" ? condition.values : [])),
  ).sort(compareLabels);
  const normalized: DashboardFilterCondition[] = [];
  if (statuses.length > 0) normalized.push({ field: "status", values: statuses });
  if (projects.length > 0) normalized.push({ field: "project", values: projects });
  if (agents.length > 0) normalized.push({ field: "agent", values: agents });
  return normalized;
}

export function dashboardPersistentFilterSummarySegments(input: {
  query: string;
  conditions: readonly DashboardFilterCondition[];
}): DashboardFilterSummarySegment[] {
  const segments: DashboardFilterSummarySegment[] = [];
  const query = input.query.trim();
  if (query.length > 0) {
    segments.push({ text: query, role: "text" });
  }
  for (const condition of normalizeDashboardFilterConditions(input.conditions)) {
    if (segments.length > 0) {
      segments.push({ text: " · ", role: "separator" });
    }
    segments.push({
      text: dashboardFilterConditionFieldLabel(condition.field),
      role: "field",
      field: condition.field,
    });
    segments.push({ text: "=", role: "operator", field: condition.field });
    condition.values.forEach((value, index) => {
      if (index > 0) {
        segments.push({ text: "|", role: "operator", field: condition.field });
      }
      segments.push({
        text: value.label,
        role: "value",
        field: condition.field,
        valueId: value.id,
      });
    });
  }
  return segments;
}

export function dashboardPersistentFilterHasCriteria(input: {
  query: string;
  conditions: readonly DashboardFilterCondition[];
}): boolean {
  return (
    input.query.trim().length > 0 || normalizeDashboardFilterConditions(input.conditions).length > 0
  );
}

export function dashboardFilterConditionSlot(index: number): string | undefined {
  return SELECTION_KEYS[index];
}

function conditionOptionsByField(
  conditions: readonly DashboardFilterCondition[],
): Record<DashboardFilterConditionField, DashboardFilterConditionOption[]> {
  const result: Record<DashboardFilterConditionField, DashboardFilterConditionOption[]> = {
    status: [],
    project: [],
    agent: [],
  };
  for (const condition of conditions) {
    result[condition.field].push(...condition.values);
  }
  return result;
}

function sortedOptions<Id extends string>(
  values: ReadonlyMap<Id, string>,
): DashboardFilterConditionOption[] {
  return [...values].map(([id, label]) => ({ id, label })).sort(compareLabels);
}

function uniqueConditionValues<T extends { id: string; label: string }>(values: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    if (!unique.has(value.id)) unique.set(value.id, value);
  }
  return [...unique.values()];
}

function compareStatusValues(
  left: DashboardFilterStatusConditionValue,
  right: DashboardFilterStatusConditionValue,
): number {
  return statusIndex(left.id) - statusIndex(right.id);
}

function statusIndex(id: AgentState): number {
  const index = DASHBOARD_FILTER_STATUS_VALUES.findIndex((value) => value.id === id);
  return index < 0 ? DASHBOARD_FILTER_STATUS_VALUES.length : index;
}

function compareLabels(
  left: { id: string; label: string },
  right: { id: string; label: string },
): number {
  return left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
}
