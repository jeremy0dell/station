import { z } from "zod";
import { SafeErrorSchema } from "./errors.js";
import { ProjectIdSchema, ProviderIdSchema, SessionIdSchema, WorktreeIdSchema } from "./ids.js";
import { ProviderHookHealthSchema } from "./providerHooks.js";
import { ObserverRecoveryAssessmentSchema } from "./recoveryAssessment.js";
import { nonEmptyStringSchema } from "./shared.js";
import { UpdateArtifactSchema } from "./updateArtifact.js";

export const UpdateRuntimeBuildRelationSchema = z.enum(["matching-target", "different", "unknown"]);
export type UpdateRuntimeBuildRelation = z.infer<typeof UpdateRuntimeBuildRelationSchema>;

const unknownObserverSchema = z
  .object({
    status: z.literal("unknown"),
    reason: z.enum([
      "stale-socket",
      "unhealthy",
      "identity-missing",
      "identity-mismatch",
      "identity-unavailable",
      "inspection-failed",
    ]),
    error: SafeErrorSchema,
  })
  .strict();

const observerRecoveryEvidenceSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("assessed"),
      assessment: ObserverRecoveryAssessmentSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unknown"),
      reason: z.enum(["api-unavailable", "identity-drift", "inspection-failed"]),
      error: SafeErrorSchema,
    })
    .strict(),
]);

export const UpdateReapObserverEvidenceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }).strict(),
  unknownObserverSchema,
  z
    .object({
      status: z.literal("exact"),
      buildVersion: nonEmptyStringSchema,
      relation: UpdateRuntimeBuildRelationSchema,
      health: z.enum(["healthy", "degraded", "unavailable"]),
      recovery: observerRecoveryEvidenceSchema,
    })
    .strict(),
]);
export type UpdateReapObserverEvidence = z.infer<typeof UpdateReapObserverEvidenceSchema>;

export const UpdateReapTerminalEvidenceSchema = z
  .object({
    kind: z.enum(["agent", "aux"]),
    terminalTargetId: nonEmptyStringSchema,
    ptyId: nonEmptyStringSchema,
    ptyInstanceId: nonEmptyStringSchema,
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    sessionId: SessionIdSchema,
    harnessProvider: ProviderIdSchema,
    alive: z.boolean(),
    handoffSupport: z.enum(["bridge-releasable", "non-releasable", "unknown"]),
  })
  .strict();
export type UpdateReapTerminalEvidence = z.infer<typeof UpdateReapTerminalEvidenceSchema>;

const unknownHostSchema = z
  .object({
    status: z.literal("unknown"),
    reason: z.enum(["stale-socket", "inaccessible", "health-failed", "inventory-failed"]),
    error: SafeErrorSchema,
  })
  .strict();

export const UpdateReapHostEvidenceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }).strict(),
  unknownHostSchema,
  z
    .object({
      status: z.literal("inspected"),
      buildVersion: nonEmptyStringSchema.optional(),
      protocolVersion: z.number().int(),
      relation: UpdateRuntimeBuildRelationSchema,
      compatibility: z.enum(["reuse", "replace", "refuse"]),
      terminals: z.array(UpdateReapTerminalEvidenceSchema),
    })
    .strict(),
]);
export type UpdateReapHostEvidence = z.infer<typeof UpdateReapHostEvidenceSchema>;

export const UpdateReapTerminalDispositionReasonSchema = z.enum([
  "handoff_support_unknown",
  "retained_session_missing",
  "session_non_resumable",
  "session_recovery_unknown",
]);
export type UpdateReapTerminalDispositionReason = z.infer<
  typeof UpdateReapTerminalDispositionReasonSchema
>;

const orderedTerminalReasonsSchema = z
  .array(UpdateReapTerminalDispositionReasonSchema)
  .superRefine((reasons, context) => {
    if (
      reasons.some((reason, index) => {
        const previous = reasons[index - 1];
        return previous !== undefined && previous >= reason;
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Terminal disposition reasons must be unique and deterministically sorted.",
      });
    }
  });

export const UpdateReapTerminalDispositionSchema = z
  .object({
    terminalTargetId: nonEmptyStringSchema,
    ptyId: nonEmptyStringSchema,
    ptyInstanceId: nonEmptyStringSchema,
    sessionId: SessionIdSchema,
    handoff: z.enum(["preservable", "non-preservable", "unknown"]),
    reapRecovery: z.enum(["recoverable", "non-resumable", "unknown"]),
    reasons: orderedTerminalReasonsSchema,
  })
  .strict();
export type UpdateReapTerminalDisposition = z.infer<typeof UpdateReapTerminalDispositionSchema>;

type UpdateReapEvidenceSet = {
  observer: UpdateReapObserverEvidence;
  host: UpdateReapHostEvidence;
  hooks: z.infer<typeof ProviderHookHealthSchema>[];
  terminalDispositions: UpdateReapTerminalDisposition[];
};

/**
 * Strict, redaction-safe recovery facts and dispositions for one update target. This payload is
 * non-authorizing: #640 owns executable actions and digests, and #641 owns destructive execution.
 */
export const UpdateReapRecoveryPreflightSchema = z
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
    hooks: z.array(ProviderHookHealthSchema),
    terminalDispositions: z.array(UpdateReapTerminalDispositionSchema),
    evidenceComplete: z.boolean(),
  })
  .strict()
  .superRefine((preflight, context) => {
    const hookProviders = preflight.hooks.map((hook) => hook.provider);
    if (
      hookProviders.some((provider, index) => {
        const previous = hookProviders[index - 1];
        return previous !== undefined && previous >= provider;
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["hooks"],
        message: "Hook evidence must be unique and deterministically sorted.",
      });
    }

    const terminalKeys = preflight.terminalDispositions.map(terminalKey);
    if (
      terminalKeys.some((key, index) => {
        const previous = terminalKeys[index - 1];
        return previous !== undefined && previous >= key;
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["terminalDispositions"],
        message: "Terminal dispositions must be unique and deterministically sorted.",
      });
    }

    if (preflight.host.status === "inspected") {
      const hostKeys = preflight.host.terminals.map(terminalKey);
      if (
        hostKeys.length !== terminalKeys.length ||
        hostKeys.some((key, index) => key !== terminalKeys[index])
      ) {
        context.addIssue({
          code: "custom",
          path: ["terminalDispositions"],
          message: "Every inspected Host terminal must have exactly one disposition.",
        });
      }
    } else if (preflight.terminalDispositions.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["terminalDispositions"],
        message: "Terminal dispositions require an inspected Host inventory.",
      });
    }
    if (preflight.evidenceComplete !== updateReapEvidenceIsComplete(preflight)) {
      context.addIssue({
        code: "custom",
        path: ["evidenceComplete"],
        message: "Evidence completeness must match the typed preflight facts.",
      });
    }
  });
export type UpdateReapRecoveryPreflight = z.infer<typeof UpdateReapRecoveryPreflightSchema>;

function terminalKey(terminal: {
  terminalTargetId: string;
  ptyId: string;
  ptyInstanceId: string;
}): string {
  return `${terminal.terminalTargetId}\u0000${terminal.ptyId}\u0000${terminal.ptyInstanceId}`;
}

export function updateReapEvidenceIsComplete(preflight: UpdateReapEvidenceSet): boolean {
  if (preflight.observer.status !== "exact" || preflight.observer.recovery.status !== "assessed") {
    return false;
  }
  if (
    preflight.observer.recovery.assessment.sessions.some(
      (session) => session.disposition === "unknown",
    )
  ) {
    return false;
  }
  if (preflight.host.status === "unknown") return false;
  if (
    preflight.host.status === "inspected" &&
    preflight.host.terminals.some((terminal) => terminal.handoffSupport === "unknown")
  ) {
    return false;
  }
  if (preflight.hooks.some((hook) => hook.status === "inspection-failed")) return false;
  return !preflight.terminalDispositions.some(
    (terminal) => terminal.handoff === "unknown" || terminal.reapRecovery === "unknown",
  );
}
