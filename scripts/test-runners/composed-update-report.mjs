import { z } from "zod";
import {
  HostHandoffFidelitySchema,
  ObserverStartupEvidenceSchema,
  ProviderHookHealthSchema,
  ProviderHookReconciliationResultSchema,
  ProviderIdSchema,
  SafeErrorSchema,
  UpdateArtifactSchema,
  UpdateChannelIdSchema,
  UpdateCommandArgvSchema,
  UpdateCommandReportSchema,
  UpdateCommandStepSchema,
  UpdateConvergencePlanSchema,
  UpdateReapHostEvidenceSchema,
  UpdateReapObserverEvidenceSchema,
  UpdateReapTerminalDispositionSchema,
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

const predecessorV4PreflightSchema = z
  .object({
    schemaVersion: z.literal(1),
    boundary: z
      .object({
        authorization: z.literal("none"),
        actions: z.literal("not-included"),
        digest: z.literal("not-included"),
      })
      .strict(),
    installed: UpdateArtifactSchema,
    target: UpdateArtifactSchema,
    observer: UpdateReapObserverEvidenceSchema,
    host: UpdateReapHostEvidenceSchema,
    hookProviderIds: z.array(ProviderIdSchema),
    hooks: z.array(ProviderHookHealthSchema),
    terminalDispositions: z.array(UpdateReapTerminalDispositionSchema),
    evidenceComplete: z.boolean(),
  })
  .strict();
const predecessorV4ConvergencePlanSchema = UpdateConvergencePlanSchema.superRefine(
  (plan, context) => {
    if (plan.phases.hostConvergence.action === "recover-parked") {
      context.addIssue({
        code: "custom",
        path: ["phases", "hostConvergence", "action"],
        message: "The schema-v4 predecessor cannot report parked-bridge recovery.",
      });
    }
  },
);
const predecessorV4FailureSummarySchema = z
  .object({
    status: z.literal("failed"),
    action: z.enum(["replace-idle", "handoff"]),
    phase: z.enum([
      "admission",
      "incumbent-validation",
      "incumbent-release",
      "target-start",
      "target-validation",
      "adoption",
      "final-verification",
    ]),
    incumbentDisposition: z.enum(["none", "preserved", "released", "unknown"]),
    terminalDisposition: z.enum(["none", "incumbent", "parked", "successor", "mixed", "unknown"]),
    recoveryAuthority: z.literal("none"),
    terminalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    terminalRecoveryCounts: z
      .object({
        incumbent: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        parked: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        successor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        unknown: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    handoffReceipt: z
      .object({
        retained: z.boolean(),
        terminalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        fidelity: HostHandoffFidelitySchema.optional(),
      })
      .strict(),
    error: z
      .object({
        tag: z.string().min(1).max(128),
        code: z.string().min(1).max(128),
        message: z.string().min(1).max(4_096),
        hint: z.string().min(1).max(4_096).optional(),
      })
      .strict(),
  })
  .strict();
const predecessorV4Common = {
  schemaVersion: z.literal(4),
  channel: UpdateChannelIdSchema,
  current: UpdateArtifactSchema,
  target: UpdateArtifactSchema,
};
const predecessorV4PreviewSchema = z
  .object({
    ...predecessorV4Common,
    kind: z.literal("preview"),
    initial: predecessorV4PreflightSchema,
    plan: predecessorV4ConvergencePlanSchema,
  })
  .strict();
const predecessorV4ResultSchema = z
  .object({
    ...predecessorV4Common,
    kind: z.literal("result"),
    status: z.enum(["current", "updated", "deferred", "failed"]),
    steps: z.array(UpdateCommandStepSchema),
    warnings: z.array(SafeErrorSchema),
    recoveryCommands: z.array(UpdateCommandArgvSchema),
    hookReconciliation: ProviderHookReconciliationResultSchema.optional(),
    error: SafeErrorSchema.optional(),
    cause: SafeErrorSchema.optional(),
    startupEvidence: ObserverStartupEvidenceSchema.optional(),
    hostConvergenceFailure: predecessorV4FailureSummarySchema.optional(),
  })
  .strict();
const predecessorV4UpdateCommandReportSchema = z.union([
  predecessorV4PreviewSchema,
  predecessorV4ResultSchema,
]);
const legacyV1IncumbentVersion = "0.0.0-pre-alpha.5.16";
const predecessorV4EmitterVersion = "0.0.0-pre-alpha.14.3";

export function updateReportSchemaVersionForEmitter(version) {
  if (version === legacyV1IncumbentVersion) return 1;
  if (version === predecessorV4EmitterVersion) return 4;
  return 5;
}

export function parseComposedUpdateReport(value, emitterVersion) {
  const schemaVersion = updateReportSchemaVersionForEmitter(emitterVersion);
  const schema =
    schemaVersion === 1
      ? legacyV1UpdateCommandReportSchema
      : schemaVersion === 4
        ? predecessorV4UpdateCommandReportSchema
        : UpdateCommandReportSchema;
  return parseExpectedReport(schema, value, emitterVersion, schemaVersion);
}

function parseExpectedReport(schema, value, incumbentVersion, expectedSchemaVersion) {
  const actualSchemaVersion = z
    .object({ schemaVersion: z.number().int() })
    .passthrough()
    .parse(value).schemaVersion;
  if (actualSchemaVersion !== expectedSchemaVersion) {
    throw new Error(
      `Expected update report schema ${expectedSchemaVersion} from incumbent ${incumbentVersion}, received ${actualSchemaVersion}.`,
    );
  }
  return schema.parse(value);
}
