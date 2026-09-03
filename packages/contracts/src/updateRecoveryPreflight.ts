import { z } from "zod";
import { SafeErrorSchema } from "./errors.js";
import {
  ProjectIdSchema,
  type ProviderId,
  ProviderIdSchema,
  SessionIdSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { ProviderHookHealthSchema } from "./providerHooks.js";
import {
  ObserverSessionRecoveryAssessmentSchema,
  ProviderResumeCapabilitySchema,
  SessionRecoveryAssessmentReasonsSchema,
} from "./recoveryAssessment.js";
import { compareCodeUnitStrings, nonEmptyStringSchema } from "./shared.js";
import { StationBuildIdentitySchema } from "./stationBuildIdentity.js";
import {
  compareStationHostTerminalLifetimeIdentity,
  StationHostProtocolVersionSchema,
  stationHostTerminalLifetimeIdentitiesAreCanonical,
} from "./stationHostInspection.js";
import { UpdateArtifactSchema } from "./updateArtifact.js";

export const UpdateRuntimeBuildRelationSchema = z.enum(["matching-target", "different", "unknown"]);
const unknownObserverSchema = z
  .object({
    status: z.literal("unknown"),
    reason: z.enum([
      "stale-socket",
      "unhealthy",
      "identity-missing",
      "identity-mismatch",
      "identity-unavailable",
      "process-without-socket",
      "inspection-failed",
    ]),
    error: SafeErrorSchema,
  })
  .strict();

export const UpdateReapRecoveryHandleResolutionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("selected"),
      eligibleHandleCount: z.number().int().positive(),
      rejectedHandleCount: z.number().int().nonnegative(),
      rejectedReasons: SessionRecoveryAssessmentReasonsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("none"),
      eligibleHandleCount: z.literal(0),
      rejectedHandleCount: z.number().int().nonnegative(),
      reasons: SessionRecoveryAssessmentReasonsSchema.min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unknown"),
      reasons: SessionRecoveryAssessmentReasonsSchema.min(1),
    })
    .strict(),
]);
export type UpdateReapRecoveryHandleResolution = z.infer<
  typeof UpdateReapRecoveryHandleResolutionSchema
>;

export const UpdateReapSessionRecoveryAssessmentSchema =
  ObserverSessionRecoveryAssessmentSchema.omit({ handleResolution: true })
    .extend({ handleResolution: UpdateReapRecoveryHandleResolutionSchema })
    .strict();
/** Public recovery projection: exact decisions and counts without execution-facing handle IDs. */
export const UpdateReapRecoveryAssessmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    resumeEnabled: z.boolean(),
    providerCapabilities: z.array(ProviderResumeCapabilitySchema),
    sessions: z.array(UpdateReapSessionRecoveryAssessmentSchema),
  })
  .strict()
  .superRefine((assessment, context) => {
    if (!strictlySortedStrings(assessment.providerCapabilities.map((entry) => entry.provider))) {
      context.addIssue({
        code: "custom",
        path: ["providerCapabilities"],
        message: "Provider capabilities must be unique and deterministically sorted.",
      });
    }
    if (!strictlySortedStrings(assessment.sessions.map((session) => session.sessionId))) {
      context.addIssue({
        code: "custom",
        path: ["sessions"],
        message: "Session assessments must be unique and deterministically sorted.",
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
      if (session.disposition === "recoverable" && session.handleResolution.kind !== "selected") {
        context.addIssue({
          code: "custom",
          path: ["sessions", index, "handleResolution"],
          message: "Recoverable sessions require a deterministically selected handle.",
        });
      }
    }
  });
export type UpdateReapRecoveryAssessment = z.infer<typeof UpdateReapRecoveryAssessmentSchema>;

const observerRecoveryEvidenceSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("assessed"),
      assessment: UpdateReapRecoveryAssessmentSchema,
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
      buildVersion: nonEmptyStringSchema,
      buildIdentity: StationBuildIdentitySchema,
      protocolVersion: StationHostProtocolVersionSchema,
      relation: UpdateRuntimeBuildRelationSchema,
      compatibility: z.enum(["reuse", "replace"]),
      terminals: z
        .array(UpdateReapTerminalEvidenceSchema)
        .refine(stationHostTerminalLifetimeIdentitiesAreCanonical),
    })
    .strict(),
]);
export type UpdateReapHostEvidence = z.infer<typeof UpdateReapHostEvidenceSchema>;

export const UpdateReapTerminalDispositionReasonSchema = z.enum([
  "handoff_support_unknown",
  "aux_terminal_not_resumable",
  "retained_session_missing",
  "retained_session_identity_mismatch",
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
        return previous !== undefined && compareCodeUnitStrings(previous, reason) >= 0;
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

/** Strict, redaction-safe viability facts for durable parked PTY bridges. */
export const UpdateReapParkedBridgeEvidenceSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("assessed"),
      totalParkedCount: z.number().int().nonnegative(),
      unownedParkedCount: z.number().int().nonnegative(),
      adoptionRequiredCount: z.number().int().nonnegative(),
    })
    .strict()
    .superRefine((evidence, context) => {
      if (evidence.unownedParkedCount > evidence.totalParkedCount) {
        context.addIssue({
          code: "custom",
          path: ["unownedParkedCount"],
          message: "Unowned parked bridges cannot exceed the total parked bridges.",
        });
      }
      if (evidence.adoptionRequiredCount > evidence.unownedParkedCount) {
        context.addIssue({
          code: "custom",
          path: ["adoptionRequiredCount"],
          message: "Required adoption cannot exceed unowned parked bridges.",
        });
      }
    }),
  z
    .object({
      status: z.literal("unknown"),
      reason: z.literal("inspection-failed"),
      error: SafeErrorSchema,
    })
    .strict(),
]);
export type UpdateReapParkedBridgeEvidence = z.infer<typeof UpdateReapParkedBridgeEvidenceSchema>;
type UpdateReapEvidenceSet = {
  observer: UpdateReapObserverEvidence;
  host: UpdateReapHostEvidence;
  hookProviderIds: ProviderId[];
  hooks: z.infer<typeof ProviderHookHealthSchema>[];
  terminalDispositions: UpdateReapTerminalDisposition[];
  parkedBridges: UpdateReapParkedBridgeEvidence;
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
    hookProviderIds: z.array(ProviderIdSchema),
    hooks: z.array(ProviderHookHealthSchema),
    terminalDispositions: z.array(UpdateReapTerminalDispositionSchema),
    parkedBridges: UpdateReapParkedBridgeEvidenceSchema,
    evidenceComplete: z.boolean(),
  })
  .strict()
  .superRefine((preflight, context) => {
    if (!strictlySortedStrings(preflight.hookProviderIds)) {
      context.addIssue({
        code: "custom",
        path: ["hookProviderIds"],
        message: "Hook provider ids must be unique and deterministically sorted.",
      });
    }
    const hookProviders = preflight.hooks.map((hook) => hook.provider);
    if (!strictlySortedStrings(hookProviders)) {
      context.addIssue({
        code: "custom",
        path: ["hooks"],
        message: "Hook evidence must be unique and deterministically sorted.",
      });
    }
    if (
      hookProviders.length !== preflight.hookProviderIds.length ||
      hookProviders.some((provider, index) => provider !== preflight.hookProviderIds[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["hooks"],
        message: "Every requested hook provider must have exactly one matching evidence result.",
      });
    }
    if (
      preflight.observer.status === "exact" &&
      preflight.observer.recovery.status === "assessed" &&
      preflight.observer.recovery.assessment.providerCapabilities.some(
        (capability) => !preflight.hookProviderIds.includes(capability.provider),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["hookProviderIds"],
        message: "Every assessed recovery provider must have hook evidence.",
      });
    }

    if (!stationHostTerminalLifetimeIdentitiesAreCanonical(preflight.terminalDispositions)) {
      context.addIssue({
        code: "custom",
        path: ["terminalDispositions"],
        message: "Terminal dispositions must be unique and deterministically sorted.",
      });
    }

    if (preflight.host.status === "inspected") {
      if (
        preflight.host.terminals.length !== preflight.terminalDispositions.length ||
        preflight.host.terminals.some((terminal, index) => {
          const disposition = preflight.terminalDispositions[index];
          return (
            disposition === undefined ||
            compareStationHostTerminalLifetimeIdentity(terminal, disposition) !== 0 ||
            terminal.sessionId !== disposition.sessionId
          );
        })
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

function strictlySortedStrings(values: readonly string[]): boolean {
  return values.every((value, index) => {
    const previous = values[index - 1];
    return previous === undefined || compareCodeUnitStrings(previous, value) < 0;
  });
}

export function updateReapEvidenceIsComplete(preflight: UpdateReapEvidenceSet): boolean {
  if (
    preflight.hookProviderIds.length !== preflight.hooks.length ||
    preflight.hookProviderIds.some(
      (provider, index) => provider !== preflight.hooks[index]?.provider,
    )
  ) {
    return false;
  }
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
  if (preflight.parkedBridges.status === "unknown") return false;
  return !preflight.terminalDispositions.some(
    (terminal) => terminal.handoff === "unknown" || terminal.reapRecovery === "unknown",
  );
}
