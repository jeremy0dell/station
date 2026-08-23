import { z } from "zod";
import { SafeErrorSchema } from "./errors.js";
import { comparePtyLifetimeIdentities, PtyLifetimeIdentitySchema } from "./hostHandoff.js";
import { ProjectIdSchema, type ProviderId, ProviderIdSchema, WorktreeIdSchema } from "./ids.js";
import { ProviderHookHealthSchema } from "./providerHooks.js";
import {
  ObserverSessionRecoveryAssessmentSchema,
  ProviderResumeCapabilitySchema,
  SessionRecoveryAssessmentReasonsSchema,
} from "./recoveryAssessment.js";
import { compareCodeUnitStrings, nonEmptyStringSchema } from "./shared.js";
import { type UpdateArtifact, UpdateArtifactSchema } from "./updateArtifact.js";

export const UpdateRuntimeBuildRelationSchema = z.enum(["matching-target", "different", "unknown"]);
export type UpdateRuntimeBuildRelation = z.infer<typeof UpdateRuntimeBuildRelationSchema>;

export const UpdateObserverReplacementAdmissionSchema = z.enum([
  "exact-build",
  "candidate-wins",
  "incumbent-wins",
  "refused",
  "not-yet-provable",
  "unknown",
]);
export type UpdateObserverReplacementAdmission = z.infer<
  typeof UpdateObserverReplacementAdmissionSchema
>;

const unknownObserverSchema = z
  .object({
    status: z.literal("unknown"),
    reason: z.enum([
      "stale-socket",
      "unhealthy",
      "identity-missing",
      "identity-mismatch",
      "identity-unavailable",
      "restartable-executable-drift",
      "process-without-socket",
      "inspection-failed",
    ]),
    buildVersion: nonEmptyStringSchema.optional(),
    error: SafeErrorSchema,
  })
  .strict()
  .superRefine((observer, context) => {
    const restartable = observer.reason === "restartable-executable-drift";
    if (restartable !== (observer.buildVersion !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["buildVersion"],
        message:
          "Only restartable installed-path replacement evidence carries the exact Observer build selector.",
      });
    }
  });

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
export type UpdateReapSessionRecoveryAssessment = z.infer<
  typeof UpdateReapSessionRecoveryAssessmentSchema
>;

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

const absentObserverSchema = z.object({ status: z.literal("absent") }).strict();
export const UpdateReapObserverEvidenceSchema = z.discriminatedUnion("status", [
  absentObserverSchema,
  unknownObserverSchema,
  z
    .object({
      status: z.literal("exact"),
      buildVersion: nonEmptyStringSchema,
      relation: UpdateRuntimeBuildRelationSchema,
      replacementAdmission: UpdateObserverReplacementAdmissionSchema,
      health: z.enum(["healthy", "degraded", "unavailable"]),
      recovery: observerRecoveryEvidenceSchema,
    })
    .strict()
    .superRefine((observer, context) => {
      const valid =
        (observer.relation === "matching-target" &&
          observer.replacementAdmission === "exact-build") ||
        (observer.relation === "different" &&
          (observer.replacementAdmission === "candidate-wins" ||
            observer.replacementAdmission === "incumbent-wins" ||
            observer.replacementAdmission === "refused" ||
            observer.replacementAdmission === "not-yet-provable")) ||
        (observer.relation === "unknown" && observer.replacementAdmission === "unknown");
      if (!valid) {
        context.addIssue({
          code: "custom",
          path: ["replacementAdmission"],
          message: "Observer replacement admission must agree with its immutable build relation.",
        });
      }
    }),
]);
export type UpdateReapObserverEvidence = z.infer<typeof UpdateReapObserverEvidenceSchema>;

export const UpdateReapTerminalEvidenceSchema = PtyLifetimeIdentitySchema.extend({
  kind: z.enum(["agent", "aux"]),
  projectId: ProjectIdSchema,
  worktreeId: WorktreeIdSchema,
  harnessProvider: ProviderIdSchema,
  alive: z.boolean(),
  handoffSupport: z.enum(["bridge-releasable", "non-releasable", "unknown"]),
}).strict();
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
      buildIdentity: nonEmptyStringSchema.optional(),
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

export const UpdateReapTerminalDispositionSchema = PtyLifetimeIdentitySchema.extend({
  handoff: z.enum(["preservable", "non-preservable", "unknown"]),
  reapRecovery: z.enum(["recoverable", "non-resumable", "unknown"]),
  reasons: orderedTerminalReasonsSchema,
}).strict();
export type UpdateReapTerminalDisposition = z.infer<typeof UpdateReapTerminalDispositionSchema>;

type UpdateReapEvidenceSet = {
  observer: UpdateReapObserverEvidence;
  host: UpdateReapHostEvidence;
  hookProviderIds: ProviderId[];
  hooks: z.infer<typeof ProviderHookHealthSchema>[];
  terminalDispositions: UpdateReapTerminalDisposition[];
};

const updateReapBoundarySchema = z
  .object({
    authorization: z.literal("none"),
    actions: z.literal("not-included"),
    digest: z.literal("not-included"),
  })
  .strict();

const updateReapPreflightCommonShape = {
  boundary: updateReapBoundarySchema,
  installed: UpdateArtifactSchema,
  target: UpdateArtifactSchema,
  host: UpdateReapHostEvidenceSchema,
  hookProviderIds: z.array(ProviderIdSchema),
  hooks: z.array(ProviderHookHealthSchema),
  terminalDispositions: z.array(UpdateReapTerminalDispositionSchema),
  evidenceComplete: z.boolean(),
} as const;

const updateReapRecoveryPreflightBaseSchema = z
  .object({
    schemaVersion: z.literal(2),
    ...updateReapPreflightCommonShape,
    observer: UpdateReapObserverEvidenceSchema,
  })
  .strict();

/**
 * Strict, redaction-safe recovery facts and dispositions for one update target. This payload is
 * non-authorizing: #640 owns executable actions and digests, and #641 owns destructive execution.
 */
export const UpdateReapRecoveryPreflightSchema = updateReapRecoveryPreflightBaseSchema.superRefine(
  (preflight, context) => {
    refineUpdateReapRecoveryPreflight(preflight, context);
    if (preflight.observer.status === "exact" && preflight.observer.relation === "different") {
      const targetInstalled = updateArtifactsMatch(preflight.installed, preflight.target);
      if ((preflight.observer.replacementAdmission === "not-yet-provable") !== !targetInstalled) {
        context.addIssue({
          code: "custom",
          path: ["observer", "replacementAdmission"],
          message:
            "Observer replacement admission is not yet provable exactly when the selected artifact is not installed.",
        });
      }
    }
  },
);
export type UpdateReapRecoveryPreflight = z.infer<typeof UpdateReapRecoveryPreflightSchema>;

function refineUpdateReapRecoveryPreflight(
  preflight: z.infer<typeof updateReapRecoveryPreflightBaseSchema>,
  context: z.RefinementCtx,
): void {
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
  if (preflight.host.status === "inspected" && !strictlySortedTerminals(preflight.host.terminals)) {
    context.addIssue({
      code: "custom",
      path: ["host", "terminals"],
      message: "Host terminals must be unique and deterministically sorted.",
    });
  }
  if (!strictlySortedTerminals(preflight.terminalDispositions)) {
    context.addIssue({
      code: "custom",
      path: ["terminalDispositions"],
      message: "Terminal dispositions must be unique and deterministically sorted.",
    });
  }
  if (!updateTerminalEvidenceSetsMatch(preflight.host, preflight.terminalDispositions)) {
    context.addIssue({
      code: "custom",
      path: ["terminalDispositions"],
      message:
        "Every inspected Host terminal must have exactly one identity- and handoff-matched disposition.",
    });
  }
  if (preflight.evidenceComplete !== updateReapEvidenceIsComplete(preflight)) {
    context.addIssue({
      code: "custom",
      path: ["evidenceComplete"],
      message: "Evidence completeness must match the typed preflight facts.",
    });
  }
}

function updateArtifactsMatch(left: UpdateArtifact, right: UpdateArtifact): boolean {
  return left.version === right.version && left.revision === right.revision;
}

function strictlySortedTerminals(
  terminals: readonly {
    terminalTargetId: string;
    ptyId: string;
    ptyInstanceId: string;
    sessionId: string;
  }[],
): boolean {
  return terminals.every((terminal, index) => {
    const previous = terminals[index - 1];
    return previous === undefined || comparePtyLifetimeIdentities(previous, terminal) < 0;
  });
}

function strictlySortedStrings(values: readonly string[]): boolean {
  return values.every((value, index) => {
    const previous = values[index - 1];
    return previous === undefined || compareCodeUnitStrings(previous, value) < 0;
  });
}

/**
 * Proves that Host terminals and recovery dispositions form one deterministic, exact-identity set.
 * The canonical PTY lifetime identity includes its Station session and is correlated with its
 * handoff class.
 */
export function updateTerminalEvidenceSetsMatch(
  host: UpdateReapHostEvidence,
  dispositions: readonly UpdateReapTerminalDisposition[],
): boolean {
  if (host.status !== "inspected") return dispositions.length === 0;
  if (
    host.terminals.length !== dispositions.length ||
    !strictlySortedTerminals(host.terminals) ||
    !strictlySortedTerminals(dispositions)
  ) {
    return false;
  }
  return host.terminals.every((terminal, index) => {
    const disposition = dispositions[index];
    return (
      disposition !== undefined &&
      comparePtyLifetimeIdentities(terminal, disposition) === 0 &&
      disposition.handoff === handoffDispositionFor(terminal.handoffSupport)
    );
  });
}

function handoffDispositionFor(
  support: UpdateReapTerminalEvidence["handoffSupport"],
): UpdateReapTerminalDisposition["handoff"] {
  switch (support) {
    case "bridge-releasable":
      return "preservable";
    case "non-releasable":
      return "non-preservable";
    case "unknown":
      return "unknown";
  }
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
  if (!updateTerminalEvidenceSetsMatch(preflight.host, preflight.terminalDispositions)) {
    return false;
  }
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
