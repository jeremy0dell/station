import { z } from "zod";
import { type SafeError, SafeErrorSchema } from "./errors.js";
import { nonEmptyStringSchema, safeTextSchema } from "./shared.js";

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

type UpdateArtifact = { version: string; revision?: string };
const UpdateArtifactSchema = z
  .object({
    version: nonEmptyStringSchema,
    revision: nonEmptyStringSchema.optional(),
  })
  .strict()
  .transform(
    (artifact): UpdateArtifact => ({
      version: artifact.version,
      ...(artifact.revision === undefined ? {} : { revision: artifact.revision }),
    }),
  );

/**
 * Strict machine-readable schema-version-1 contract emitted by `stn update --json`.
 * Consumers must parse this shared contract before interpreting update outcomes.
 */
export type UpdateCommandReport = {
  schemaVersion: 1;
  channel: UpdateChannelId;
  status: "current" | "planned" | "updated" | "deferred" | "failed";
  current: { version: string; revision?: string };
  target: { version: string; revision?: string };
  steps: UpdateCommandStep[];
  warnings: SafeError[];
  recoveryCommands: UpdateCommandArgv[];
  error?: SafeError;
};

export const UpdateCommandReportSchema: z.ZodType<UpdateCommandReport> = z
  .object({
    schemaVersion: z.literal(1),
    channel: UpdateChannelIdSchema,
    status: z.enum(["current", "planned", "updated", "deferred", "failed"]),
    current: UpdateArtifactSchema,
    target: UpdateArtifactSchema,
    steps: z.array(UpdateCommandStepSchema),
    warnings: z.array(SafeErrorSchema),
    recoveryCommands: z.array(UpdateCommandArgvSchema),
    error: SafeErrorSchema.optional(),
  })
  .strict()
  .transform(
    (report): UpdateCommandReport => ({
      schemaVersion: report.schemaVersion,
      channel: report.channel,
      status: report.status,
      current: report.current,
      target: report.target,
      steps: report.steps,
      warnings: report.warnings,
      recoveryCommands: report.recoveryCommands,
      ...(report.error === undefined ? {} : { error: report.error }),
    }),
  );
