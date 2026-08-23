import { z } from "zod";
import { type SafeError, SafeErrorSchema } from "./errors.js";
import { type ObserverStartupEvidence, ObserverStartupEvidenceSchema } from "./observer.js";
import {
  type ProviderHookReconciliationResult,
  ProviderHookReconciliationResultSchema,
} from "./providerHooks.js";
import { nonEmptyStringSchema, safeTextSchema } from "./shared.js";
import { type UpdateArtifact, UpdateArtifactSchema } from "./updateArtifact.js";
import {
  type UpdateReapRecoveryPreflight,
  UpdateReapRecoveryPreflightSchema,
} from "./updateRecoveryPreflight.js";

export const UpdateChannelIdSchema = z.enum([
  "installer-binary",
  "dev-checkout",
  "homebrew",
  "npm-global",
  "mise",
]);

export type UpdateChannelId = z.infer<typeof UpdateChannelIdSchema>;

export const UpdateCommandArgvSchema = z.tuple([nonEmptyStringSchema], z.string());

export type UpdateCommandArgv = readonly [command: string, ...args: string[]];

export const UpdateCommandStepIdSchema = z.enum([
  "detect",
  "plan",
  "apply",
  "hook-reconciliation",
  "observer-restart",
  "host-handoff",
]);

export const UpdateCommandStepStatusSchema = z.enum([
  "completed",
  "planned",
  "deferred",
  "skipped",
  "failed",
]);

export type UpdateCommandStepStatus = z.infer<typeof UpdateCommandStepStatusSchema>;

export type UpdateCommandStep = {
  id: z.infer<typeof UpdateCommandStepIdSchema>;
  status: UpdateCommandStepStatus;
  detail: string;
  command?: UpdateCommandArgv;
};

export const UpdateCommandStepSchema: z.ZodType<UpdateCommandStep> = z
  .object({
    id: UpdateCommandStepIdSchema,
    status: UpdateCommandStepStatusSchema,
    detail: safeTextSchema,
    command: UpdateCommandArgvSchema.optional(),
  })
  .strict()
  .transform(
    (step): UpdateCommandStep => ({
      id: step.id,
      status: step.status,
      detail: step.detail,
      ...(step.command === undefined ? {} : { command: step.command }),
    }),
  );

type UpdateCommandReportCore = {
  channel: UpdateChannelId;
  status: "current" | "planned" | "updated" | "deferred" | "failed";
  current: UpdateArtifact;
  target: UpdateArtifact;
  warnings: SafeError[];
  recoveryCommands: UpdateCommandArgv[];
  error?: SafeError;
  cause?: SafeError;
  startupEvidence?: ObserverStartupEvidence;
};

const UpdateCommandStepV1IdSchema = z.enum([
  "detect",
  "plan",
  "apply",
  "observer-restart",
  "host-handoff",
]);

const UpdateCommandStepV1Schema = z
  .object({
    id: UpdateCommandStepV1IdSchema,
    status: UpdateCommandStepStatusSchema,
    detail: safeTextSchema,
    command: UpdateCommandArgvSchema.optional(),
  })
  .strict()
  .transform((step) => ({
    id: step.id,
    status: step.status,
    detail: step.detail,
    ...(step.command === undefined ? {} : { command: step.command }),
  }));

const updateCommandReportCoreShape = {
  channel: UpdateChannelIdSchema,
  status: z.enum(["current", "planned", "updated", "deferred", "failed"]),
  current: UpdateArtifactSchema,
  target: UpdateArtifactSchema,
  warnings: z.array(SafeErrorSchema),
  recoveryCommands: z.array(UpdateCommandArgvSchema),
  error: SafeErrorSchema.optional(),
  cause: SafeErrorSchema.optional(),
  startupEvidence: ObserverStartupEvidenceSchema.optional(),
} as const;

export type UpdateCommandReportV1 = UpdateCommandReportCore & {
  schemaVersion: 1;
  steps: z.infer<typeof UpdateCommandStepV1Schema>[];
};

/** Strict parser for the original update report retained for compatible consumers. */
export const UpdateCommandReportV1Schema: z.ZodType<UpdateCommandReportV1> = z
  .object({
    schemaVersion: z.literal(1),
    ...updateCommandReportCoreShape,
    steps: z.array(UpdateCommandStepV1Schema),
  })
  .strict()
  .transform(
    (report): UpdateCommandReportV1 => ({
      schemaVersion: report.schemaVersion,
      ...updateCommandReportCore(report),
      steps: report.steps,
    }),
  );

export type UpdateCommandReportV2 = UpdateCommandReportCore & {
  schemaVersion: 2;
  steps: UpdateCommandStep[];
  hookReconciliation?: ProviderHookReconciliationResult;
};

/** Strict parser for #637's provider-hook reconciliation report. */
export const UpdateCommandReportV2Schema: z.ZodType<UpdateCommandReportV2> = z
  .object({
    schemaVersion: z.literal(2),
    ...updateCommandReportCoreShape,
    steps: z.array(UpdateCommandStepSchema),
    hookReconciliation: ProviderHookReconciliationResultSchema.optional(),
  })
  .strict()
  .transform(
    (report): UpdateCommandReportV2 => ({
      schemaVersion: report.schemaVersion,
      ...updateCommandReportCore(report),
      steps: report.steps,
      ...(report.hookReconciliation === undefined
        ? {}
        : { hookReconciliation: report.hookReconciliation }),
    }),
  );

export type UpdateCommandReport = UpdateCommandReportCore & {
  schemaVersion: 3;
  steps: UpdateCommandStep[];
  hookReconciliation?: ProviderHookReconciliationResult;
  recoveryPreflight?: UpdateReapRecoveryPreflight;
};

/**
 * Current strict machine-readable update report. Version 3 adds #639's non-authorizing recovery
 * facts while #640 remains the sole owner of executable actions and digests.
 */
export const UpdateCommandReportV3Schema: z.ZodType<UpdateCommandReport> = z
  .object({
    schemaVersion: z.literal(3),
    ...updateCommandReportCoreShape,
    steps: z.array(UpdateCommandStepSchema),
    hookReconciliation: ProviderHookReconciliationResultSchema.optional(),
    recoveryPreflight: UpdateReapRecoveryPreflightSchema.optional(),
  })
  .strict()
  .superRefine((report, context) => {
    if (
      report.recoveryPreflight !== undefined &&
      (!updateArtifactsMatch(report.current, report.recoveryPreflight.installed) ||
        !updateArtifactsMatch(report.target, report.recoveryPreflight.target))
    ) {
      context.addIssue({
        code: "custom",
        path: ["recoveryPreflight"],
        message: "Recovery preflight artifacts must match the enclosing update report.",
      });
    }
  })
  .transform(
    (report): UpdateCommandReport => ({
      schemaVersion: report.schemaVersion,
      ...updateCommandReportCore(report),
      steps: report.steps,
      ...(report.hookReconciliation === undefined
        ? {}
        : { hookReconciliation: report.hookReconciliation }),
      ...(report.recoveryPreflight === undefined
        ? {}
        : { recoveryPreflight: report.recoveryPreflight }),
    }),
  );

export const UpdateCommandReportSchema = UpdateCommandReportV3Schema;

export type CompatibleUpdateCommandReport =
  | UpdateCommandReportV1
  | UpdateCommandReportV2
  | UpdateCommandReport;

/** Explicit compatible parser for persisted or piped reports from versions 1, 2, and 3. */
export const CompatibleUpdateCommandReportSchema: z.ZodType<CompatibleUpdateCommandReport> =
  z.union([UpdateCommandReportV1Schema, UpdateCommandReportV2Schema, UpdateCommandReportV3Schema]);

function updateArtifactsMatch(left: UpdateArtifact, right: UpdateArtifact): boolean {
  return left.version === right.version && left.revision === right.revision;
}

function updateCommandReportCore(report: {
  channel: UpdateChannelId;
  status: UpdateCommandReportCore["status"];
  current: UpdateArtifact;
  target: UpdateArtifact;
  warnings: SafeError[];
  recoveryCommands: UpdateCommandArgv[];
  error?: SafeError | undefined;
  cause?: SafeError | undefined;
  startupEvidence?: ObserverStartupEvidence | undefined;
}): UpdateCommandReportCore {
  const core: UpdateCommandReportCore = {
    channel: report.channel,
    status: report.status,
    current: report.current,
    target: report.target,
    warnings: report.warnings,
    recoveryCommands: report.recoveryCommands,
  };
  if (report.error !== undefined) core.error = report.error;
  if (report.cause !== undefined) core.cause = report.cause;
  if (report.startupEvidence !== undefined) {
    core.startupEvidence = report.startupEvidence;
  }
  return core;
}
