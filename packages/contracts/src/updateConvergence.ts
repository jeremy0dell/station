import { z } from "zod";
import { SafeErrorSchema } from "./errors.js";
import {
  comparePtyLifetimeIdentities,
  HostHandoffFidelitySchema,
  PtyHandoffReceiptSchema,
} from "./hostHandoff.js";
import { ProviderHookReconciliationResultSchema } from "./providerHooks.js";
import { compareCodeUnitStrings, nonEmptyStringSchema } from "./shared.js";
import { type UpdateArtifact, UpdateArtifactSchema } from "./updateArtifact.js";
import {
  deriveUpdateReapPreviewConsequences,
  updateConvergenceSemanticIssues,
  updateReapPreviewConsequencesMatch,
} from "./updateConvergenceSemantics.js";
import { UpdateInstallMutationSchema } from "./updateInstall.js";
import {
  UpdateReapRecoveryPreflightSchema,
  UpdateReapTerminalDispositionSchema,
} from "./updateRecoveryPreflight.js";

const buildIdentitySchema = z.string().regex(/^[0-9a-f]{64}$/u);

export { deriveUpdateReapPreviewConsequences, updateReapPreviewConsequencesMatch };

export const UpdateSelectedTargetSchema = z
  .object({
    artifact: UpdateArtifactSchema,
    buildIdentity: z.discriminatedUnion("status", [
      z.object({ status: z.literal("known"), value: buildIdentitySchema }).strict(),
      z.object({ status: z.literal("not-yet-provable") }).strict(),
    ]),
  })
  .strict();
export type UpdateSelectedTarget = z.infer<typeof UpdateSelectedTargetSchema>;

export const UpdateConvergenceDigestSchema = z
  .object({
    algorithm: z.literal("sha256"),
    canonicalizationVersion: z.literal(1),
    value: buildIdentitySchema,
  })
  .strict();
export type UpdateConvergenceDigest = z.infer<typeof UpdateConvergenceDigestSchema>;

export const UpdateConvergencePlanStatusSchema = z.enum([
  "converged",
  "actionable",
  "deferred",
  "reap-required",
  "intentionally-incomplete",
  "blocked",
]);
export type UpdateConvergencePlanStatus = z.infer<typeof UpdateConvergencePlanStatusSchema>;

export const UpdateConvergencePhaseIdSchema = z.enum([
  "artifact-application",
  "hook-reconciliation",
  "observer-convergence",
  "terminal-convergence",
  "host-convergence",
  "runtime-reconcile",
  "verification",
]);
export type UpdateConvergencePhaseId = z.infer<typeof UpdateConvergencePhaseIdSchema>;

const phaseActionSchema = z.enum([
  "no-op",
  "apply",
  "defer",
  "reconcile",
  "start",
  "restart",
  "preserve-via-handoff",
  "reap-required",
  "replace-idle",
  "handoff",
  "leave-in-place",
  "await-reap",
  "run",
  "satisfied",
  "reinspect",
  "blocked",
]);
export type UpdateConvergencePhaseAction = z.infer<typeof phaseActionSchema>;

export const UpdateConvergenceReasonSchema = z.enum([
  "already-selected",
  "channel-apply",
  "manager-deferred",
  "configured-disabled",
  "unsupported",
  "healthy",
  "missing",
  "owned-drift",
  "target-artifact-may-change",
  "ownership-conflict",
  "inspection-failed",
  "absent",
  "matching-healthy",
  "matching-unhealthy",
  "different-build",
  "restartable-executable-drift",
  "identity-incomplete",
  "singleton-refused",
  "no-terminals",
  "all-bridge-releasable",
  "non-releasable",
  "handoff-support-unknown",
  "recovery-incomplete",
  "matching-target",
  "idle-replacement",
  "busy-handoff",
  "protocol-refused",
  "inventory-incomplete",
  "handoff-disabled",
  "no-runtime-change",
  "runtime-change",
  "already-converged",
  "reinspect-after-actions",
]);
export type UpdateConvergenceReason = z.infer<typeof UpdateConvergenceReasonSchema>;

export const UpdateConvergencePhaseSchema = z
  .object({
    id: UpdateConvergencePhaseIdSchema,
    action: phaseActionSchema,
    reason: UpdateConvergenceReasonSchema,
  })
  .strict();
export type UpdateConvergencePhase = z.infer<typeof UpdateConvergencePhaseSchema>;

const hookDecisionSchema = z
  .object({
    provider: nonEmptyStringSchema,
    action: z.enum(["no-op", "reconcile", "blocked"]),
    reason: UpdateConvergenceReasonSchema,
  })
  .strict();

const observerDecisionSchema = z
  .object({
    action: z.enum(["no-op", "start", "restart", "reinspect", "blocked"]),
    reason: UpdateConvergenceReasonSchema,
  })
  .strict();

const terminalDecisionSchema = z
  .object({
    action: z.enum(["no-op", "preserve-via-handoff", "reap-required", "blocked"]),
    reason: UpdateConvergenceReasonSchema,
    fidelity: HostHandoffFidelitySchema.optional(),
    liveCount: z.number().int().nonnegative(),
    recoverableCount: z.number().int().nonnegative(),
    nonResumableCount: z.number().int().nonnegative(),
    unknownRecoveryCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((decision, context) => {
    if ((decision.action === "preserve-via-handoff") !== (decision.fidelity !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["fidelity"],
        message: "Terminal handoff decisions require exactly one fidelity commitment.",
      });
    }
  });

const hostDecisionSchema = z
  .object({
    action: z.enum(["no-op", "replace-idle", "handoff", "leave-in-place", "await-reap", "blocked"]),
    reason: UpdateConvergenceReasonSchema,
    fidelity: HostHandoffFidelitySchema.optional(),
  })
  .strict()
  .superRefine((decision, context) => {
    if ((decision.action === "handoff") !== (decision.fidelity !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["fidelity"],
        message: "Host handoff decisions require exactly one fidelity commitment.",
      });
    }
  });

const recoveryDecisionSchema = z
  .object({
    relevance: z.enum(["not-required", "destructive-follow-up"]),
    status: z.enum(["not-required", "complete", "incomplete"]),
  })
  .strict();

const updateReapPreviewTerminalSchema = UpdateReapTerminalDispositionSchema.extend({
  ownership: z.literal("station"),
  requiredAction: z.enum(["preserve", "reap", "blocked"]),
}).strict();

export const UpdateReapPreviewConsequencesSchema = z
  .object({
    authorization: z.literal("none"),
    execution: z.literal("not-included"),
    recovery: recoveryDecisionSchema,
    terminals: z.array(updateReapPreviewTerminalSchema),
  })
  .strict()
  .superRefine((consequences, context) => {
    consequences.terminals.forEach((terminal, index) => {
      const previous = consequences.terminals[index - 1];
      if (previous !== undefined && comparePtyLifetimeIdentities(previous, terminal) >= 0) {
        context.addIssue({
          code: "custom",
          path: ["terminals", index],
          message: "Reap-preview terminals must be unique and canonically ordered.",
        });
      }
    });
  });
export type UpdateReapPreviewConsequences = z.infer<typeof UpdateReapPreviewConsequencesSchema>;

const reconcileDecisionSchema = z
  .object({
    action: z.enum(["no-op", "run", "blocked"]),
    reason: UpdateConvergenceReasonSchema,
  })
  .strict();

const verificationDecisionSchema = z
  .object({
    action: z.enum(["satisfied", "reinspect"]),
    reason: UpdateConvergenceReasonSchema,
  })
  .strict();

const phaseOrder = UpdateConvergencePhaseIdSchema.options;

export const UpdateConvergencePlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    selectedTarget: UpdateSelectedTargetSchema,
    installation: UpdateInstallMutationSchema,
    status: UpdateConvergencePlanStatusSchema,
    digest: UpdateConvergenceDigestSchema,
    components: z
      .object({
        hooks: z.array(hookDecisionSchema),
        observer: observerDecisionSchema,
        terminals: terminalDecisionSchema,
        host: hostDecisionSchema,
        recovery: recoveryDecisionSchema,
        reconcile: reconcileDecisionSchema,
        verification: verificationDecisionSchema,
      })
      .strict(),
    phases: z.array(UpdateConvergencePhaseSchema).length(phaseOrder.length),
  })
  .strict()
  .superRefine((plan, context) => {
    plan.phases.forEach((phase, index) => {
      if (phase.id !== phaseOrder[index]) {
        context.addIssue({
          code: "custom",
          path: ["phases", index, "id"],
          message: "Convergence phases must use the canonical order.",
        });
      }
    });
    const providers = plan.components.hooks.map((hook) => hook.provider);
    if (
      providers.some((provider, index) => {
        const previous = providers[index - 1];
        return previous !== undefined && compareCodeUnitStrings(previous, provider) >= 0;
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["components", "hooks"],
        message: "Hook decisions must be unique and sorted by code unit.",
      });
    }
    const hostFidelity = plan.components.host.fidelity;
    const terminalFidelity = plan.components.terminals.fidelity;
    if (hostFidelity !== terminalFidelity) {
      context.addIssue({
        code: "custom",
        path: ["components", "terminals", "fidelity"],
        message: "Host and terminal handoff decisions must commit to the same fidelity.",
      });
    }
  });
export type UpdateConvergencePlan = z.infer<typeof UpdateConvergencePlanSchema>;

export const UpdateEvidencePlanSchema = z
  .object({
    evaluator: z.enum(["incumbent-cli", "successor-cli"]),
    preflight: UpdateReapRecoveryPreflightSchema,
    plan: UpdateConvergencePlanSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (!artifactsMatch(evidence.preflight.target, evidence.plan.selectedTarget.artifact)) {
      context.addIssue({
        code: "custom",
        path: ["plan", "selectedTarget", "artifact"],
        message: "The convergence target must match the aggregate target.",
      });
    }
    for (const issue of updateConvergenceSemanticIssues(evidence)) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  });
export type UpdateEvidencePlan = z.infer<typeof UpdateEvidencePlanSchema>;

const executedActionSchema = z
  .object({
    phase: UpdateConvergencePhaseIdSchema,
    action: phaseActionSchema,
    status: z.enum(["completed", "failed", "skipped"]),
    provider: nonEmptyStringSchema.optional(),
    hookResult: ProviderHookReconciliationResultSchema.optional(),
    installation: UpdateInstallMutationSchema.optional(),
    fidelity: HostHandoffFidelitySchema.optional(),
    handoffReceipt: PtyHandoffReceiptSchema.optional(),
  })
  .strict()
  .superRefine((action, context) => {
    const hookAction = action.phase === "hook-reconciliation" && action.action === "reconcile";
    if (hookAction !== (action.provider !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["provider"],
        message: "Hook reconciliation audits require exactly one provider identity.",
      });
    }
    if (action.hookResult !== undefined && action.hookResult.provider !== action.provider) {
      context.addIssue({
        code: "custom",
        path: ["hookResult", "provider"],
        message: "Hook reconciliation result must match the audited provider.",
      });
    }
    if (!hookAction && action.hookResult !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["hookResult"],
        message: "Only hook reconciliation actions may carry hook results.",
      });
    }
    const artifactApplication =
      action.phase === "artifact-application" && action.action === "apply";
    if (
      artifactApplication !== (action.installation !== undefined) ||
      (action.installation !== undefined && action.installation.action !== action.action)
    ) {
      context.addIssue({
        code: "custom",
        path: ["installation"],
        message: "Artifact application audits require the exact selected install mutation.",
      });
    }
    const handoffAction =
      (action.phase === "terminal-convergence" && action.action === "preserve-via-handoff") ||
      (action.phase === "host-convergence" && action.action === "handoff");
    if (handoffAction !== (action.fidelity !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["fidelity"],
        message: "Handoff action audits require exactly one fidelity commitment.",
      });
    }
    const terminalHandoff =
      action.phase === "terminal-convergence" &&
      action.action === "preserve-via-handoff" &&
      action.status === "completed";
    if (terminalHandoff !== (action.handoffReceipt !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["handoffReceipt"],
        message: "Only a completed terminal handoff audit carries its exact receipt.",
      });
    }
  });
export type UpdateExecutedAction = z.infer<typeof executedActionSchema>;

export const UpdateActionAuditSchema = z
  .object({
    executor: z.enum(["incumbent-cli", "successor-cli"]),
    planDigest: buildIdentitySchema,
    actions: z.array(executedActionSchema).min(1),
  })
  .strict()
  .superRefine((audit, context) => {
    const order = new Map(phaseOrder.map((phase, index) => [phase, index]));
    audit.actions.forEach((action, index) => {
      const previous = audit.actions[index - 1];
      if (
        previous !== undefined &&
        (order.get(previous.phase) ?? -1) > (order.get(action.phase) ?? -1)
      ) {
        context.addIssue({
          code: "custom",
          path: ["actions", index, "phase"],
          message: "Executed actions must retain canonical phase order.",
        });
      }
      if (
        previous?.status === "failed" &&
        !(previous.phase === "hook-reconciliation" && action.phase === "hook-reconciliation")
      ) {
        context.addIssue({
          code: "custom",
          path: ["actions", index],
          message: "No action may follow a failed action in one audit.",
        });
      }
      if (
        previous?.phase === "hook-reconciliation" &&
        action.phase === "hook-reconciliation" &&
        previous.provider !== undefined &&
        action.provider !== undefined &&
        compareCodeUnitStrings(previous.provider, action.provider) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["actions", index, "provider"],
          message: "Hook action audits must be unique and sorted by provider code unit.",
        });
      }
    });
  });
export type UpdateActionAudit = z.infer<typeof UpdateActionAuditSchema>;

export const UpdateVerificationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("converged"),
      source: z.enum(["initial", "successor", "post-action"]),
      planDigest: buildIdentitySchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("not-converged"),
      source: z.enum(["successor", "post-action"]),
      planDigest: buildIdentitySchema,
      disposition: z.enum(["actionable", "reap-required", "intentionally-incomplete", "blocked"]),
    })
    .strict(),
]);
export type UpdateVerification = z.infer<typeof UpdateVerificationSchema>;

export const UpdateFinalInspectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), evidence: UpdateEvidencePlanSchema }).strict(),
  z.object({ status: z.literal("failed"), error: SafeErrorSchema }).strict(),
  z
    .object({
      status: z.literal("not-attempted"),
      reason: z.enum(["artifact-application-failed", "successor-unavailable"]),
    })
    .strict(),
]);
export type UpdateFinalInspection = z.infer<typeof UpdateFinalInspectionSchema>;

const phaseNotExecutedSchema = z
  .object({ id: UpdateConvergencePhaseIdSchema, status: z.literal("not-executed") })
  .strict();
const phaseDeferredSchema = z
  .object({ id: UpdateConvergencePhaseIdSchema, status: z.enum(["deferred", "not-executed"]) })
  .strict();
const nonExecutedPhasesSchema = orderedResultPhases(phaseNotExecutedSchema);
const deferredPhasesSchema = orderedResultPhases(phaseDeferredSchema).superRefine(
  (phases, context) => {
    phases.forEach((phase, index) => {
      const expected = index === 0 ? "deferred" : "not-executed";
      if (phase.status !== expected) {
        context.addIssue({
          code: "custom",
          path: [index, "status"],
          message: "Only artifact application may be deferred; later phases are not executed.",
        });
      }
    });
  },
);

export const UpdateConvergenceResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("already-converged"),
      verification: UpdateVerificationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("preview"),
      planDigest: buildIdentitySchema,
      phases: nonExecutedPhasesSchema,
      verification: UpdateVerificationSchema.optional(),
      reapConsequences: UpdateReapPreviewConsequencesSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("deferred"),
      planDigest: buildIdentitySchema,
      phases: deferredPhasesSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("non-mutating-stop"),
      disposition: z.enum(["blocked", "reap-required", "intentionally-incomplete"]),
      planDigest: buildIdentitySchema,
      phases: nonExecutedPhasesSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("current-runtime-execution"),
      actionAudits: z.tuple([UpdateActionAuditSchema]),
      postAction: UpdateEvidencePlanSchema,
      verification: UpdateVerificationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("successor-runtime-execution"),
      actionAudits: z.array(UpdateActionAuditSchema).min(1).max(2),
      successor: UpdateEvidencePlanSchema,
      postAction: UpdateEvidencePlanSchema,
      verification: UpdateVerificationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("execution-failed"),
      stage: z.union([
        z.literal("artifact-application"),
        z.literal("successor-boundary"),
        UpdateConvergencePhaseIdSchema,
      ]),
      actionAudits: z.array(UpdateActionAuditSchema),
      successor: UpdateEvidencePlanSchema.optional(),
      finalInspection: UpdateFinalInspectionSchema,
    })
    .strict(),
]);
export type UpdateConvergenceResult = z.infer<typeof UpdateConvergenceResultSchema>;

function artifactsMatch(left: UpdateArtifact, right: UpdateArtifact): boolean {
  return left.version === right.version && left.revision === right.revision;
}

function orderedResultPhases<T extends z.ZodType<{ id: UpdateConvergencePhaseId }>>(
  phaseSchema: T,
) {
  return z
    .array(phaseSchema)
    .length(phaseOrder.length)
    .superRefine((phases, context) => {
      phases.forEach((phase, index) => {
        if (phase.id !== phaseOrder[index]) {
          context.addIssue({
            code: "custom",
            path: [index, "id"],
            message: "Result phases must use the canonical convergence order.",
          });
        }
      });
    });
}
