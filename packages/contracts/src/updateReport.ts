import { z } from "zod";
import { type SafeError, SafeErrorSchema } from "./errors.js";
import { ObserverStartupEvidenceSchema } from "./observer.js";
import { ProviderHookReconciliationResultSchema } from "./providerHooks.js";
import { compareCodeUnitStrings } from "./shared.js";
import {
  UpdateChannelIdSchema,
  UpdateCommandArgvSchema,
  UpdateCommandStepSchema,
} from "./update.js";
import { type UpdateArtifact, UpdateArtifactSchema } from "./updateArtifact.js";
import {
  type UpdateConvergencePlan,
  UpdateConvergencePlanSchema,
} from "./updateConvergencePlan.js";
import {
  type UpdateReapRecoveryResult,
  UpdateReapRecoveryResultSchema,
} from "./updateReapExecution.js";
import {
  type UpdateReapRecoveryPreflight,
  UpdateReapRecoveryPreflightSchema,
} from "./updateRecoveryPreflight.js";

const common = {
  schemaVersion: z.literal(6),
  channel: UpdateChannelIdSchema,
  current: UpdateArtifactSchema,
  target: UpdateArtifactSchema,
} as const;
const previewSchema = z
  .object({
    ...common,
    kind: z.literal("preview"),
    initial: UpdateReapRecoveryPreflightSchema,
    plan: UpdateConvergencePlanSchema,
  })
  .strict();
export const UpdateFinalInspectionSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      aggregate: UpdateReapRecoveryPreflightSchema,
      plan: UpdateConvergencePlanSchema,
    })
    .strict(),
  z.object({ status: z.literal("failed"), error: SafeErrorSchema }).strict(),
]);
const resultSchema = z
  .object({
    ...common,
    kind: z.literal("result"),
    status: z.enum([
      "current",
      "updated",
      "deferred",
      "blocked",
      "reap-required",
      "intentionally-incomplete",
      "failed",
    ]),
    initial: UpdateReapRecoveryPreflightSchema,
    plan: UpdateConvergencePlanSchema,
    finalInspection: UpdateFinalInspectionSchema.optional(),
    steps: z.array(UpdateCommandStepSchema),
    warnings: z.array(SafeErrorSchema),
    recoveryCommands: z.array(UpdateCommandArgvSchema),
    hookReconciliations: z.array(ProviderHookReconciliationResultSchema),
    reapRecovery: UpdateReapRecoveryResultSchema.optional(),
    error: SafeErrorSchema.optional(),
    cause: SafeErrorSchema.optional(),
    startupEvidence: ObserverStartupEvidenceSchema.optional(),
  })
  .strict();

type PreviewReport = z.output<typeof previewSchema>;
type ResultReport = z.output<typeof resultSchema>;
const parsedReportSchema = z.union([previewSchema, resultSchema]).superRefine((report, context) => {
  if (report.kind === "preview") {
    const artifact = report.plan.phases.artifactApplication;
    if (report.channel !== artifact.owner)
      issue(context, ["channel"], "Preview channel must match the artifact owner.");
    if (
      ![report.initial.installed, artifact.before].every((value) =>
        artifactsMatch(report.current, value),
      )
    )
      issue(context, ["current"], "Preview current artifact must match its evidence.");
    if (
      ![report.initial.target, report.plan.selectedTarget.artifact].every((value) =>
        artifactsMatch(report.target, value),
      )
    )
      issue(context, ["target"], "Preview target artifact must match its evidence.");
    validateTerminalCorrelation(report, context);
  } else {
    validateResult(report, context);
  }
  validatePublicAliases(report, context);
});
const strictReportSchema = z
  .unknown()
  .superRefine(rejectExplicitUndefined)
  .pipe(parsedReportSchema);

function validateResult(report: ResultReport, context: z.RefinementCtx): void {
  const initial = report.initial;
  if (
    report.channel !== report.plan.phases.artifactApplication.owner ||
    !artifactsMatch(report.current, initial.installed) ||
    !artifactsMatch(report.target, initial.target) ||
    !artifactsMatch(report.target, report.plan.selectedTarget.artifact)
  ) {
    issue(context, ["initial"], "Result initial evidence must match its enclosing artifacts.");
  }
  const providers = report.hookReconciliations.map((entry) => entry.provider);
  if (
    !strictlySorted(providers) ||
    providers.some((provider) => !initial.hookProviderIds.includes(provider))
  ) {
    issue(
      context,
      ["hookReconciliations"],
      "Hook reconciliations must be a unique canonical subset of the initial providers.",
    );
  }
  if (report.finalInspection?.status === "completed") {
    if (
      !artifactsMatch(report.target, report.finalInspection.aggregate.target) ||
      !artifactsMatch(
        report.finalInspection.aggregate.target,
        report.finalInspection.plan.selectedTarget.artifact,
      )
    ) {
      issue(
        context,
        ["finalInspection"],
        "Final evidence must retain the selected target artifact.",
      );
    }
  }
  if (report.status === "current" || report.status === "updated") {
    if (report.finalInspection?.status !== "completed") {
      issue(
        context,
        ["finalInspection"],
        "Successful results require completed final verification.",
      );
    } else if (report.finalInspection.plan.outcome !== "converged") {
      issue(
        context,
        ["finalInspection", "plan"],
        "Successful results require a converged final plan.",
      );
    }
    if (report.status === "current" && !artifactsMatch(report.current, report.target)) {
      issue(context, ["status"], "Current results must retain the selected target artifact.");
    }
    if (report.status === "updated" && artifactsMatch(report.current, report.target)) {
      issue(context, ["status"], "Updated results must represent an artifact change.");
    }
  }
}

export type UpdateCommandReport = z.output<typeof parsedReportSchema>;
export type UpdateFinalInspection = z.output<typeof UpdateFinalInspectionSchema>;
export type UpdateCommandResultReport = z.output<typeof resultSchema>;

/** Current strict update-report boundary for one preview plan or one completed command result. */
export const UpdateCommandReportSchema = strictReportSchema;

/** Parses only the current update report discriminator. */
export const parseUpdateCommandReport = (value: unknown): UpdateCommandReport =>
  UpdateCommandReportSchema.parse(value);

export const UpdateReportIdentityAliasLabels = {
  projectId: "project",
  worktreeId: "worktree",
  sessionId: "session",
  terminalTargetId: "terminal-target",
  ptyId: "pty",
  ptyInstanceId: "pty-instance",
} as const;
type IdentityField = keyof typeof UpdateReportIdentityAliasLabels;
type IdentityMap = (field: IdentityField, value: string) => string;
type IdentityPass = {
  map: IdentityMap;
  seen: WeakMap<object, Set<IdentityField>>;
};
type IdentityRecord = Partial<Record<IdentityField, string | undefined>>;
type BoundaryPath = { key: PropertyKey; parent: BoundaryPath | undefined };
type TerminalIdentity = Pick<
  PreviewReport["initial"]["terminalDispositions"][number],
  "terminalTargetId" | "ptyId" | "ptyInstanceId" | "sessionId"
>;
const identityFields = Object.keys(UpdateReportIdentityAliasLabels) as IdentityField[];

/**
 * POLICY
 *
 * Projects the six structural local identities into one ephemeral update-report namespace.
 */
export function projectPublicUpdateReport(input: PreviewReport): PreviewReport;
export function projectPublicUpdateReport(input: ResultReport): ResultReport;
export function projectPublicUpdateReport(input: UpdateCommandReport): UpdateCommandReport;
export function projectPublicUpdateReport(input: UpdateCommandReport): UpdateCommandReport {
  const report = structuredClone(input);
  const values = identitySets();
  mapReportIdentities(report, (field, value) => {
    values[field].add(value);
    return value;
  });
  const ordered = Object.fromEntries(
    identityFields.map((field) => [field, [...values[field]].sort(compareCodeUnitStrings)]),
  ) as Record<IdentityField, string[]>;
  mapReportIdentities(report, (field, value) => {
    const index = ordered[field].indexOf(value);
    if (index < 0) throw new Error(`Missing public alias for ${field}.`);
    return alias(field, index);
  });
  return report;
}

function validatePublicAliases(report: UpdateCommandReport, context: z.RefinementCtx): void {
  const values = identitySets();
  mapReportIdentities(report, (field, value) => {
    values[field].add(value);
    return value;
  });
  for (const field of identityFields) {
    const actual = [...values[field]].sort(compareCodeUnitStrings);
    if (actual.some((value, index) => value !== alias(field, index)))
      issue(context, [report.kind], `${field} values must use report-wide aliases.`);
  }
}

function strictlySorted(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || compareCodeUnitStrings(values[index - 1] ?? "", value) < 0,
  );
}

function mapReportIdentities(report: PreviewReport | ResultReport, map: IdentityMap): void {
  const pass: IdentityPass = { map, seen: new WeakMap() };
  if (report.kind === "result") {
    for (const error of report.warnings) mapSafeError(error, pass);
    if (report.error !== undefined) mapSafeError(report.error, pass);
    if (report.cause !== undefined) mapSafeError(report.cause, pass);
    for (const hook of report.hookReconciliations) {
      if (
        hook.status === "write-failed" ||
        hook.status === "post-write-doctor-failed" ||
        hook.status === "inspection-failed"
      ) {
        mapSafeError(hook.error, pass);
      }
    }
    if (report.reapRecovery !== undefined) mapReapRecovery(report.reapRecovery, pass);
    mapAggregateIdentities(report.initial, report.plan, pass);
    if (report.finalInspection?.status === "completed") {
      mapAggregateIdentities(report.finalInspection.aggregate, report.finalInspection.plan, pass);
    } else if (report.finalInspection?.status === "failed") {
      mapSafeError(report.finalInspection.error, pass);
    }
    return;
  }
  mapAggregateIdentities(report.initial, report.plan, pass);
}

function mapReapRecovery(result: UpdateReapRecoveryResult, pass: IdentityPass): void {
  for (const terminal of result.terminals) mapTerminal(terminal, pass);
}

function mapAggregateIdentities(
  initial: UpdateReapRecoveryPreflight,
  plan: UpdateConvergencePlan,
  pass: IdentityPass,
): void {
  if (initial.observer.status === "unknown") mapSafeError(initial.observer.error, pass);
  if (initial.observer.status === "exact") {
    if (initial.observer.recovery.status === "unknown") {
      mapSafeError(initial.observer.recovery.error, pass);
    } else {
      for (const session of initial.observer.recovery.assessment.sessions) {
        for (const field of ["sessionId", "projectId", "worktreeId"] as const)
          mapField(session, field, pass);
      }
    }
  }
  if (initial.host.status === "unknown") mapSafeError(initial.host.error, pass);
  if (initial.host.status === "inspected") {
    for (const terminal of initial.host.terminals) {
      mapTerminal(terminal, pass);
      mapField(terminal, "projectId", pass);
      mapField(terminal, "worktreeId", pass);
    }
  }
  for (const hook of initial.hooks) {
    if (hook.status === "inspection-failed") mapSafeError(hook.error, pass);
  }
  for (const terminal of initial.terminalDispositions) mapTerminal(terminal, pass);
  const plannedTerminals = plan.phases.terminalConvergence.terminals;
  for (const terminal of plannedTerminals) mapTerminal(terminal, pass);
}

function mapSafeError(error: SafeError, pass: IdentityPass): void {
  for (const field of ["projectId", "worktreeId", "sessionId"] as const)
    mapField(error, field, pass);
}

function mapTerminal(terminal: TerminalIdentity, pass: IdentityPass): void {
  for (const field of ["terminalTargetId", "ptyId", "ptyInstanceId", "sessionId"] as const)
    mapField(terminal, field, pass);
}

function mapField(record: IdentityRecord, field: IdentityField, pass: IdentityPass): void {
  const mapped = pass.seen.get(record) ?? new Set<IdentityField>();
  if (mapped.has(field)) return;
  pass.seen.set(record, mapped);
  mapped.add(field);
  const value = record[field];
  if (value !== undefined) record[field] = pass.map(field, value);
}

function identitySets(): Record<IdentityField, Set<string>> {
  return Object.fromEntries(identityFields.map((field) => [field, new Set<string>()])) as Record<
    IdentityField,
    Set<string>
  >;
}

function validateTerminalCorrelation(report: PreviewReport, context: z.RefinementCtx): void {
  const initial = report.initial.terminalDispositions;
  const planned = report.plan.phases.terminalConvergence.terminals;
  if (
    initial.length === planned.length &&
    initial.every((terminal, index) => terminalMatches(terminal, planned[index]))
  )
    return;
  issue(
    context,
    ["plan", "phases", "terminalConvergence", "terminals"],
    "Plan terminals must reference the corresponding initial terminal identities.",
  );
}

function terminalMatches(left: TerminalIdentity, right: TerminalIdentity | undefined): boolean {
  return (
    right !== undefined &&
    left.terminalTargetId === right.terminalTargetId &&
    left.ptyId === right.ptyId &&
    left.ptyInstanceId === right.ptyInstanceId &&
    left.sessionId === right.sessionId
  );
}

function alias(field: IdentityField, index: number): string {
  return `public-${UpdateReportIdentityAliasLabels[field]}-${String(index + 1).padStart(8, "0")}`;
}

function artifactsMatch(left: UpdateArtifact, right: UpdateArtifact): boolean {
  return left.version === right.version && left.revision === right.revision;
}
function rejectExplicitUndefined(value: unknown, context: z.RefinementCtx): void {
  const seen = new WeakSet<object>();
  const pending: Array<[unknown, BoundaryPath | undefined]> = [[value, undefined]];
  while (pending.length > 0) {
    const [candidate, path] = pending.pop() as [unknown, BoundaryPath | undefined];
    if (candidate === null || (typeof candidate !== "object" && typeof candidate !== "function"))
      continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(candidate))) {
      const nestedPath = { key, parent: path };
      if (!("value" in descriptor)) {
        issue(context, boundaryPath(nestedPath), "Accessor properties are not allowed.");
        continue;
      }
      if (!descriptor.enumerable) continue;
      if (descriptor.value === undefined)
        issue(context, boundaryPath(nestedPath), "Optional fields must be absent.");
      else pending.push([descriptor.value, nestedPath]);
    }
  }
}
function boundaryPath(tail: BoundaryPath): PropertyKey[] {
  const path: PropertyKey[] = [];
  for (let current: BoundaryPath | undefined = tail; current; current = current.parent)
    path.push(current.key);
  return path.reverse();
}
function issue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: "custom", path, message });
}
