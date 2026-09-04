import { z } from "zod";
import { SafeErrorSchema } from "./errors.js";
import {
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TerminalTargetIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { ObserverRecoveryAssessmentSchema } from "./recoveryAssessment.js";
import { nonEmptyStringSchema, safeTextSchema } from "./shared.js";
import { UpdateCommandArgvSchema } from "./update.js";
import { UpdateReapJournalTargetSchema } from "./updateReapExecution.js";
import { UpdateReapRecoveryPreflightSchema } from "./updateRecoveryPreflight.js";

export const RepairSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export const RepairIdSchema = z.string().uuid();

export const RepairActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("terminal-reap"),
      terminalTargetId: TerminalTargetIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("observer-cleanup") }).strict(),
  z
    .object({
      kind: z.literal("recovery-resume"),
      recoveryHandleId: nonEmptyStringSchema,
      projectId: ProjectIdSchema,
      worktreeId: WorktreeIdSchema,
      sessionId: SessionIdSchema,
      provider: ProviderIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("recovery-prune"),
      recoveryHandleId: nonEmptyStringSchema,
      projectId: ProjectIdSchema,
      worktreeId: WorktreeIdSchema,
      sessionId: SessionIdSchema,
      provider: ProviderIdSchema,
    })
    .strict(),
]);
export type RepairAction = z.infer<typeof RepairActionSchema>;

const unavailableSectionSchema = z
  .object({ status: z.literal("unavailable"), error: SafeErrorSchema })
  .strict();

export const RepairInventorySchema = z
  .object({
    schemaVersion: z.literal(1),
    configuredStateScopeDigest: RepairSha256Schema,
    runtime: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("available"),
          preflight: UpdateReapRecoveryPreflightSchema,
        })
        .strict(),
      unavailableSectionSchema,
    ]),
    recovery: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("available"),
          assessment: ObserverRecoveryAssessmentSchema,
          recoveryInventoryDigest: RepairSha256Schema,
        })
        .strict(),
      unavailableSectionSchema,
    ]),
    repairInventoryDigest: RepairSha256Schema,
  })
  .strict();
export type RepairInventory = z.infer<typeof RepairInventorySchema>;

export const RepairPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    authorization: z.literal("none"),
    action: RepairActionSchema,
    inventoryDigest: RepairSha256Schema,
    configuredStateScopeDigest: RepairSha256Schema,
    status: z.enum(["ready", "refused"]),
    reason: z.enum([
      "ready",
      "runtime-unavailable",
      "observer-not-stale",
      "terminal-not-found",
      "terminal-not-live",
      "terminal-recovery-unknown",
      "recovery-unavailable",
      "recovery-handle-not-found",
      "recovery-handle-unbound",
      "recovery-identity-mismatch",
      "recovery-handle-ineligible",
    ]),
    detail: safeTextSchema,
    recoveryCommands: z.array(UpdateCommandArgvSchema),
    repairPlanDigest: RepairSha256Schema,
  })
  .strict()
  .superRefine((plan, context) => {
    if ((plan.status === "ready") !== (plan.reason === "ready")) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Ready repair plans require the ready reason.",
      });
    }
  });
export type RepairPlan = z.infer<typeof RepairPlanSchema>;

export const RepairBackupSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: RepairIdSchema,
    contentDigest: RepairSha256Schema,
    recoveryInventoryDigest: RepairSha256Schema,
  })
  .strict();
export type RepairBackup = z.infer<typeof RepairBackupSchema>;

export const RepairRecoveryMutationProofSchema = z
  .object({
    journalId: RepairIdSchema,
    auditId: RepairIdSchema,
    planDigest: RepairSha256Schema,
    inventoryDigest: RepairSha256Schema,
    expectedRecoveryInventoryDigest: RepairSha256Schema,
    backup: RepairBackupSchema,
  })
  .strict();
export type RepairRecoveryMutationProof = z.infer<typeof RepairRecoveryMutationProofSchema>;

export const RepairJournalPhaseSchema = z.enum([
  "authorized",
  "backup-verified",
  "mutation-started",
  "mutation-completed",
  "verified",
  "completed",
]);
export type RepairJournalPhase = z.infer<typeof RepairJournalPhaseSchema>;

/** Strict private restart journal. Its filesystem adapter stores this payload with mode 0600. */
export const RepairJournalSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: RepairIdSchema,
    auditId: RepairIdSchema,
    planDigest: RepairSha256Schema,
    inventoryDigest: RepairSha256Schema,
    configuredStateScopeDigest: RepairSha256Schema,
    action: RepairActionSchema,
    phase: RepairJournalPhaseSchema,
    backup: RepairBackupSchema.optional(),
    terminalTarget: UpdateReapJournalTargetSchema.optional(),
    terminalAuthorizationDigest: RepairSha256Schema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((journal, context) => {
    if ((journal.action.kind === "terminal-reap") !== (journal.terminalTarget !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["terminalTarget"],
        message: "Only terminal reap journals contain private process authority.",
      });
    }
    if (
      (journal.action.kind === "terminal-reap") !==
      (journal.terminalAuthorizationDigest !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["terminalAuthorizationDigest"],
        message: "Only terminal reap journals contain private signal authorization.",
      });
    }
    if (
      journal.action.kind !== "observer-cleanup" &&
      journal.phase !== "authorized" &&
      journal.backup === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["backup"],
        message: "Persistence-affecting repair requires a verified backup before mutation.",
      });
    }
  });
export type RepairJournal = z.infer<typeof RepairJournalSchema>;

export const RepairAuditStatusSchema = z.enum([
  "in-progress",
  "completed",
  "refused",
  "partial",
  "recovery-required",
]);
export const RepairAuditSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: RepairIdSchema,
    action: RepairActionSchema,
    planDigest: RepairSha256Schema,
    inventoryDigest: RepairSha256Schema,
    backup: RepairBackupSchema.optional(),
    status: RepairAuditStatusSchema,
    errorCodes: z.array(nonEmptyStringSchema),
    recoveryCommands: z.array(UpdateCommandArgvSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type RepairAudit = z.infer<typeof RepairAuditSchema>;

export const RepairResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("result"),
    status: z.enum(["completed", "refused", "partial", "recovery-required"]),
    action: RepairActionSchema,
    planDigest: RepairSha256Schema,
    inventoryDigest: RepairSha256Schema,
    journalId: RepairIdSchema.optional(),
    auditId: RepairIdSchema.optional(),
    backup: RepairBackupSchema.optional(),
    termination: z
      .object({
        outcome: z.enum(["already-exited", "terminated", "killed", "unresolved"]),
        escalationUsed: z.boolean(),
        unresolved: z.boolean(),
      })
      .strict()
      .optional(),
    error: SafeErrorSchema.optional(),
    recoveryCommands: z.array(UpdateCommandArgvSchema),
  })
  .strict();
export type RepairResult = z.infer<typeof RepairResultSchema>;

export const RepairPreviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("preview"),
    inventory: RepairInventorySchema,
    plan: RepairPlanSchema,
  })
  .strict();
export type RepairPreview = z.infer<typeof RepairPreviewSchema>;

export const RepairInventoryReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("inventory"),
    inventory: RepairInventorySchema,
  })
  .strict();
export type RepairInventoryReport = z.infer<typeof RepairInventoryReportSchema>;
