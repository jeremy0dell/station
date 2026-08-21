import { z } from "zod";
import { ProjectIdSchema, ProviderIdSchema, SessionIdSchema, WorktreeIdSchema } from "./ids.js";
import { ObserverRecoveryInventorySchema } from "./recoveryInventory.js";
import { nonEmptyStringSchema } from "./shared.js";

export const SessionRecoveryAssessmentReasonSchema = z.enum([
  "project_mismatch",
  "worktree_mismatch",
  "station_session_missing",
  "station_session_mismatch",
  "station_session_legacy",
  "station_session_ended",
  "harness_mismatch",
  "harness_provider_missing",
  "harness_resume_unsupported",
  "cwd_missing",
  "cwd_outside_worktree",
  "worktree_evidence_missing",
  "global_resume_disabled",
  "provider_resume_disabled",
  "no_recovery_handles",
]);
export type SessionRecoveryAssessmentReason = z.infer<typeof SessionRecoveryAssessmentReasonSchema>;

const orderedReasonsSchema = z
  .array(SessionRecoveryAssessmentReasonSchema)
  .superRefine((reasons, context) => {
    if (
      reasons.some((reason, index) => {
        const previous = reasons[index - 1];
        return previous !== undefined && previous >= reason;
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Recovery assessment reasons must be unique and deterministically sorted.",
      });
    }
  });

export const SessionRecoveryHandleResolutionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("selected"),
      selectedHandleId: nonEmptyStringSchema,
      eligibleHandleCount: z.number().int().positive(),
      rejectedHandleCount: z.number().int().nonnegative(),
      rejectedReasons: orderedReasonsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("none"),
      eligibleHandleCount: z.literal(0),
      rejectedHandleCount: z.number().int().nonnegative(),
      reasons: orderedReasonsSchema.min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unknown"),
      reasons: orderedReasonsSchema.min(1),
    })
    .strict(),
]);
export type SessionRecoveryHandleResolution = z.infer<typeof SessionRecoveryHandleResolutionSchema>;

export const ObserverSessionRecoveryAssessmentSchema = z
  .object({
    sessionId: SessionIdSchema,
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    lifecycle: z.enum(["legacy", "open", "ended"]),
    harnessProvider: ProviderIdSchema.optional(),
    disposition: z.enum(["recoverable", "non-resumable", "not-applicable", "unknown"]),
    reasons: orderedReasonsSchema,
    handleResolution: SessionRecoveryHandleResolutionSchema,
  })
  .strict();
export type ObserverSessionRecoveryAssessment = z.infer<
  typeof ObserverSessionRecoveryAssessmentSchema
>;

/**
 * Redacted, read-only recovery assessment over one coherent persistence inventory and one
 * separately captured Observer graph snapshot. The contract does not claim cross-source
 * transactional coherence or expose provider-native recovery targets and local paths.
 */
export const ObserverRecoveryAssessmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    inventory: ObserverRecoveryInventorySchema,
    resumeEnabled: z.boolean(),
    sessions: z.array(ObserverSessionRecoveryAssessmentSchema),
  })
  .strict()
  .superRefine((assessment, context) => {
    const sessionIds = assessment.sessions.map((session) => session.sessionId);
    if (
      sessionIds.some((sessionId, index) => {
        const previous = sessionIds[index - 1];
        return previous !== undefined && previous >= sessionId;
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["sessions"],
        message: "Session assessments must be unique and deterministically sorted.",
      });
    }
    const inventorySessionIds = assessment.inventory.sessions.map((session) => session.id);
    if (
      inventorySessionIds.length !== sessionIds.length ||
      inventorySessionIds.some((sessionId, index) => sessionId !== sessionIds[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["sessions"],
        message: "Every inventory session must have exactly one assessment.",
      });
    }
    for (const [index, session] of assessment.sessions.entries()) {
      if (session.disposition === "recoverable" && session.reasons.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["sessions", index, "reasons"],
          message: "Recoverable sessions cannot contain blocking reasons.",
        });
      }
      if (session.disposition !== "recoverable" && session.reasons.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["sessions", index, "reasons"],
          message: "Blocked, unknown, and inapplicable sessions require a typed reason.",
        });
      }
    }
  });
export type ObserverRecoveryAssessment = z.infer<typeof ObserverRecoveryAssessmentSchema>;
