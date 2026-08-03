import type { StationSnapshot } from "@station/contracts";
import type {
  DashboardFilterCondition,
  DashboardFilterConditionField,
  DashboardFilterConditionOption,
  DashboardFilterStatusConditionValue,
  TuiViewState,
} from "../state/types.js";
import { SELECTION_KEYS } from "./selectors.js";

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

type DashboardFilterConditionOptionContext = {
  snapshot: StationSnapshot | undefined;
  state: Pick<TuiViewState, "localRows">;
};

type DashboardFilterConditionFieldConfig = {
  field: DashboardFilterConditionField;
  key: string;
  label: string;
  retainSelectedOptions: boolean;
  selectOptions: (
    context: DashboardFilterConditionOptionContext,
  ) => readonly DashboardFilterConditionOption[];
  compareValues: (
    left: DashboardFilterConditionOption,
    right: DashboardFilterConditionOption,
  ) => number;
};

const DASHBOARD_FILTER_CONDITION_CONFIG = [
  {
    field: "status",
    key: "S",
    label: "Status",
    retainSelectedOptions: false,
    selectOptions: selectStatusOptions,
    compareValues: compareStatusValues,
  },
  {
    field: "project",
    key: "P",
    label: "Project",
    retainSelectedOptions: true,
    selectOptions: selectProjectOptions,
    compareValues: compareLabels,
  },
  {
    field: "agent",
    key: "A",
    label: "Agent",
    retainSelectedOptions: true,
    selectOptions: selectAgentOptions,
    compareValues: compareLabels,
  },
] as const satisfies readonly DashboardFilterConditionFieldConfig[];

export const DASHBOARD_FILTER_CONDITION_FIELDS: readonly DashboardFilterConditionField[] =
  DASHBOARD_FILTER_CONDITION_CONFIG.map((config) => config.field);

export const DASHBOARD_FILTER_CONDITION_KEYS: readonly string[] =
  DASHBOARD_FILTER_CONDITION_CONFIG.map((config) => config.key);

export type DashboardFilterConditionOptions = Readonly<
  Record<DashboardFilterConditionField, readonly DashboardFilterConditionOption[]>
>;

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
  const context: DashboardFilterConditionOptionContext = { snapshot, state };
  const optionsByField: Partial<
    Record<DashboardFilterConditionField, readonly DashboardFilterConditionOption[]>
  > = {};
  for (const config of DASHBOARD_FILTER_CONDITION_CONFIG) {
    const candidates = [...config.selectOptions(context)];
    if (config.retainSelectedOptions) {
      candidates.push(...conditionValuesForField(conditions, config.field));
    }
    optionsByField[config.field] = uniqueConditionValues(candidates).sort(config.compareValues);
  }

  return optionsByField as DashboardFilterConditionOptions;
}

export function dashboardFilterConditionFieldLabel(field: DashboardFilterConditionField): string {
  return dashboardFilterConditionConfig(field).label;
}

export function dashboardFilterConditionFieldKey(field: DashboardFilterConditionField): string {
  return dashboardFilterConditionConfig(field).key;
}

export function dashboardFilterConditionFieldForKey(
  input: string,
): DashboardFilterConditionField | undefined {
  const key = input.toUpperCase();
  return DASHBOARD_FILTER_CONDITION_CONFIG.find((config) => config.key === key)?.field;
}

/** Removes empty/duplicate values and returns Status, Project, Agent in canonical order. */
export function normalizeDashboardFilterConditions(
  conditions: readonly DashboardFilterCondition[],
): DashboardFilterCondition[] {
  const normalized: DashboardFilterCondition[] = [];
  for (const config of DASHBOARD_FILTER_CONDITION_CONFIG) {
    const values = uniqueConditionValues(conditionValuesForField(conditions, config.field)).sort(
      config.compareValues,
    );
    if (values.length > 0) {
      normalized.push(dashboardFilterConditionFromValues(config.field, values));
    }
  }
  return normalized;
}

export function dashboardFilterConditionsWithSelection(
  conditions: readonly DashboardFilterCondition[],
  field: DashboardFilterConditionField,
  options: readonly DashboardFilterConditionOption[],
  selectedIds: readonly string[],
): DashboardFilterCondition[] {
  const retained = conditions.filter((condition) => condition.field !== field);
  const condition = dashboardFilterConditionFromSelection(field, options, selectedIds);
  return normalizeDashboardFilterConditions(
    condition === undefined ? retained : [...retained, condition],
  );
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

function dashboardFilterConditionFromSelection(
  field: DashboardFilterConditionField,
  options: readonly DashboardFilterConditionOption[],
  selectedIds: readonly string[],
): DashboardFilterCondition | undefined {
  const selected = new Set(selectedIds);
  const values = options.filter((option) => selected.has(option.id));
  if (values.length === 0) return undefined;
  return dashboardFilterConditionFromValues(field, values);
}

function dashboardFilterConditionFromValues(
  field: DashboardFilterConditionField,
  values: readonly DashboardFilterConditionOption[],
): DashboardFilterCondition {
  const conditionValues = values.map((value) => ({ id: value.id, label: value.label }));
  // The field config is the source of each option set, so this restores that field/value correlation.
  const condition = { field, values: conditionValues } as DashboardFilterCondition;
  return condition;
}

function dashboardFilterConditionConfig(
  field: DashboardFilterConditionField,
): DashboardFilterConditionFieldConfig {
  const config = DASHBOARD_FILTER_CONDITION_CONFIG.find((candidate) => candidate.field === field);
  if (config === undefined) {
    throw new Error(`Unhandled dashboard filter condition field: ${field}`);
  }
  return config;
}

function conditionValuesForField(
  conditions: readonly DashboardFilterCondition[],
  field: DashboardFilterConditionField,
): DashboardFilterConditionOption[] {
  const values: DashboardFilterConditionOption[] = [];
  for (const condition of conditions) {
    if (condition.field === field) {
      values.push(...condition.values);
    }
  }
  return values;
}

function selectStatusOptions(): readonly DashboardFilterConditionOption[] {
  return DASHBOARD_FILTER_STATUS_VALUES;
}

function selectProjectOptions(
  context: DashboardFilterConditionOptionContext,
): DashboardFilterConditionOption[] {
  const options: DashboardFilterConditionOption[] = [];
  for (const project of context.snapshot?.projects ?? []) {
    options.push({ id: project.id, label: project.label });
  }
  return options;
}

function selectAgentOptions(
  context: DashboardFilterConditionOptionContext,
): DashboardFilterConditionOption[] {
  const options: DashboardFilterConditionOption[] = [];
  for (const harness of context.snapshot?.harnesses ?? []) {
    options.push({ id: harness.id, label: harness.label });
  }
  for (const session of context.snapshot?.sessions ?? []) {
    options.push({ id: session.harness.provider, label: session.harness.provider });
  }
  for (const row of context.state.localRows.pendingCreate) {
    if (row.harnessProvider !== undefined) {
      options.push({ id: row.harnessProvider, label: row.harnessProvider });
    }
  }
  return options;
}

function uniqueConditionValues<T extends { id: string; label: string }>(values: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    if (!unique.has(value.id)) unique.set(value.id, value);
  }
  return [...unique.values()];
}

function compareStatusValues(
  left: DashboardFilterConditionOption,
  right: DashboardFilterConditionOption,
): number {
  return statusIndex(left.id) - statusIndex(right.id);
}

function statusIndex(id: string): number {
  const index = DASHBOARD_FILTER_STATUS_VALUES.findIndex((value) => value.id === id);
  return index < 0 ? DASHBOARD_FILTER_STATUS_VALUES.length : index;
}

function compareLabels(
  left: { id: string; label: string },
  right: { id: string; label: string },
): number {
  return left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
}
