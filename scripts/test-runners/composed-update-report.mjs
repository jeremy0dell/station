import { z } from "zod";
import {
  SafeErrorSchema,
  UpdateArtifactSchema,
  UpdateChannelIdSchema,
  UpdateCommandArgvSchema,
  UpdateCommandReportSchema,
} from "../../packages/contracts/dist/index.js";

const legacySafeTextSchema = z
  .string()
  .min(1)
  .refine((value) => !/\n\s*at\s+\S+/u.test(value), "must not contain stack trace frames");
const legacyUpdateStepSchema = z
  .object({
    id: z.enum(["detect", "plan", "apply", "observer-restart", "host-handoff"]),
    status: z.enum(["completed", "planned", "deferred", "skipped", "failed"]),
    detail: legacySafeTextSchema,
    command: UpdateCommandArgvSchema.optional(),
  })
  .strict();

// The release smoke composes the current target with the newest complete immutable predecessor.
const legacyV1UpdateCommandReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: UpdateChannelIdSchema,
    status: z.enum(["current", "planned", "updated", "deferred", "failed"]),
    current: UpdateArtifactSchema,
    target: UpdateArtifactSchema,
    steps: z.array(legacyUpdateStepSchema),
    warnings: z.array(SafeErrorSchema),
    recoveryCommands: z.array(UpdateCommandArgvSchema),
    error: SafeErrorSchema.optional(),
  })
  .strict();

const composedUpdateReportSchema = z.union([
  legacyV1UpdateCommandReportSchema,
  UpdateCommandReportSchema,
]);
const legacyV1IncumbentVersion = "0.0.0-pre-alpha.5.16";

export function parseComposedUpdateReport(value, incumbentVersion) {
  const report = composedUpdateReportSchema.parse(value);
  const expectedSchemaVersion = incumbentVersion === legacyV1IncumbentVersion ? 1 : 5;
  if (report.schemaVersion !== expectedSchemaVersion) {
    throw new Error(
      `Expected update report schema ${expectedSchemaVersion} from incumbent ${incumbentVersion}, received ${report.schemaVersion}.`,
    );
  }
  return report;
}
