import { z } from "zod";
import { HostHandoffFidelitySchema, PtyHandoffKindSchema } from "./hostHandoff.js";
import { ProviderIdSchema } from "./ids.js";
import { compareCodeUnitStrings } from "./shared.js";
import { StationBuildIdentitySchema } from "./stationBuildIdentity.js";
import { stationHostTerminalLifetimeIdentitiesAreCanonical } from "./stationHostInspection.js";
import { UpdateChannelIdSchema, UpdateCommandArgvSchema } from "./update.js";
import { UpdateArtifactSchema } from "./updateArtifact.js";
import {
  UpdateReapRecoveryPreflightSchema,
  UpdateReapTerminalDispositionSchema,
} from "./updateRecoveryPreflight.js";

const targetRuntimeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("known"),
      buildIdentity: StationBuildIdentitySchema,
      observerSelector: z.string().regex(/^.+[+.]station\.[0-9a-f]{64}$/u),
    })
    .strict(),
  z.object({ status: z.literal("not-yet-provable") }).strict(),
]);
const managerCommandSchema = z
  .object({
    kind: z.literal("manager"),
    argv: UpdateCommandArgvSchema,
  })
  .strict();
const installCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  managerCommandSchema,
]);
const installationSchema = z.discriminatedUnion("whenRequired", [
  z
    .object({
      whenRequired: z.literal("apply"),
      owner: UpdateChannelIdSchema,
      command: installCommandSchema,
    })
    .strict(),
  z
    .object({
      whenRequired: z.literal("defer"),
      owner: UpdateChannelIdSchema,
      command: managerCommandSchema,
    })
    .strict(),
]);
const handoffSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preserve"), fidelity: HostHandoffFidelitySchema }).strict(),
  z.object({ action: z.literal("leave-in-place") }).strict(),
]);

/**
 * Strict input to live-convergence planning. `preflight.target` is the sole selected artifact;
 * the other fields add only resolved runtime knowledge and non-executing operator intent.
 */
export const UpdateConvergencePlanningInputSchema = z
  .object({
    preflight: UpdateReapRecoveryPreflightSchema,
    targetRuntime: targetRuntimeSchema,
    installation: installationSchema,
    handoff: handoffSchema,
  })
  .strict()
  .superRefine((input, context) => {
    // A future build cannot be compared to live immutable runtime identity until it is installed.
    const installed = artifactsMatch(input.preflight.installed, input.preflight.target);
    if (installed !== (input.targetRuntime.status === "known")) {
      context.addIssue({
        code: "custom",
        path: ["targetRuntime", "status"],
        message:
          "Target runtime identity is known exactly when the selected artifact is installed.",
      });
    }
  });
export type UpdateConvergencePlanningInput = z.infer<typeof UpdateConvergencePlanningInputSchema>;

const hookDecisionSchema = z.discriminatedUnion("action", [
  phaseVariant("no-op", z.enum(["healthy", "configured-disabled", "unsupported"]), {
    provider: ProviderIdSchema,
  }),
  phaseVariant("reconcile", z.enum(["missing", "owned-drift", "selected-artifact-change"]), {
    provider: ProviderIdSchema,
  }),
  phaseVariant("blocked", z.enum(["ownership-conflict", "inspection-failed"]), {
    provider: ProviderIdSchema,
  }),
]);
const artifactFields = {
  before: UpdateArtifactSchema,
  owner: UpdateChannelIdSchema,
  command: installCommandSchema,
};
const artifactPhaseSchema = z.discriminatedUnion("action", [
  phaseVariant("no-op", z.literal("selected-artifact-current"), artifactFields),
  phaseVariant("apply", z.literal("selected-artifact-different"), artifactFields),
  phaseVariant("defer", z.literal("package-manager-deferred"), {
    ...artifactFields,
    command: managerCommandSchema,
  }),
]);
const hookFields = { providers: z.array(hookDecisionSchema) };
const hookPhaseSchema = z.discriminatedUnion("action", [
  phaseVariant("no-op", z.literal("healthy"), hookFields),
  phaseVariant("reconcile", z.literal("runtime-change"), hookFields),
  phaseVariant("blocked", z.literal("hook-evidence-blocked"), hookFields),
]);
const observerPhaseSchema = z.union([
  phaseVariant("start", z.literal("absent"), {}),
  phaseVariant("reinspect", z.literal("target-build-not-yet-provable"), {}),
  phaseVariant("no-op", z.literal("matching-healthy"), { precedence: z.literal("exact-build") }),
  phaseVariant("restart", z.literal("matching-unhealthy"), {
    precedence: z.literal("exact-build"),
  }),
  phaseVariant("restart", z.literal("target-precedes"), {
    precedence: z.literal("candidate-precedes"),
  }),
  phaseVariant(
    "blocked",
    z.enum(["evidence-unknown", "selected-target-identity-invalid", "evidence-contradictory"]),
    {},
  ),
  phaseVariant("blocked", z.literal("singleton-refused"), {
    precedence: z.enum(["incumbent-precedes", "refused"]),
  }),
]);

/** Exact Station-owned terminal facts needed to explain preservation or destructive consequences. */
export const UpdateConvergenceTerminalFactSchema = UpdateReapTerminalDispositionSchema.safeExtend({
  kind: PtyHandoffKindSchema,
  alive: z.boolean(),
})
  .strict()
  .superRefine((terminal, context) => {
    const handoffReason = terminal.reasons.includes("handoff_support_unknown");
    if ((terminal.handoff === "unknown") !== handoffReason) {
      context.addIssue({
        code: "custom",
        path: ["handoff"],
        message: "Terminal handoff and its unknown-support reason must agree.",
      });
    }

    const recoveryReasons = terminal.reasons.filter(
      (reason) => reason !== "handoff_support_unknown",
    );
    const recoveryIsCoherent =
      terminal.reapRecovery === "recoverable"
        ? recoveryReasons.length === 0
        : terminal.reapRecovery === "non-resumable"
          ? recoveryReasons.length === 1 &&
            [
              "aux_terminal_not_resumable",
              "retained_session_missing",
              "session_non_resumable",
            ].includes(recoveryReasons[0] ?? "")
          : recoveryReasons.length === 1 &&
            ["retained_session_identity_mismatch", "session_recovery_unknown"].includes(
              recoveryReasons[0] ?? "",
            );
    if (!recoveryIsCoherent) {
      context.addIssue({
        code: "custom",
        path: ["reapRecovery"],
        message: "Terminal recovery and its single typed consequence reason must agree.",
      });
    }

    const auxiliaryReason = terminal.reasons.includes("aux_terminal_not_resumable");
    const auxiliaryIsCoherent =
      terminal.kind === "aux"
        ? terminal.reapRecovery === "non-resumable" && auxiliaryReason
        : !auxiliaryReason;
    if (!auxiliaryIsCoherent) {
      context.addIssue({
        code: "custom",
        path: ["reapRecovery"],
        message: "Terminal kind and auxiliary recovery facts must agree.",
      });
    }
  });
export type UpdateConvergenceTerminalFact = z.infer<typeof UpdateConvergenceTerminalFactSchema>;

const terminalFields = { terminals: z.array(UpdateConvergenceTerminalFactSchema) };
const terminalPhaseSchema = z.discriminatedUnion("action", [
  phaseVariant("no-op", z.enum(["no-terminals", "matching-host"]), terminalFields),
  phaseVariant("preserve-via-handoff", z.literal("bridge-preservation"), {
    ...terminalFields,
    fidelity: HostHandoffFidelitySchema,
  }),
  phaseVariant("reap-required", z.literal("non-preservable-terminals"), terminalFields),
  phaseVariant("leave-in-place", z.literal("handoff-disabled"), terminalFields),
  phaseVariant("reinspect", z.literal("target-build-not-yet-provable"), terminalFields),
  phaseVariant(
    "blocked",
    z.enum([
      "inventory-incomplete",
      "handoff-support-unknown",
      "recovery-incomplete",
      "evidence-contradictory",
    ]),
    terminalFields,
  ),
]);
const hostPhaseSchema = z.discriminatedUnion("action", [
  phaseVariant("no-op", z.enum(["absent", "matching-target"]), {}),
  phaseVariant("recover-parked", z.literal("unowned-parked-bridges"), {
    parkedCount: z.number().int().positive(),
  }),
  phaseVariant("replace-idle", z.literal("different-idle-host"), {}),
  phaseVariant("handoff", z.literal("busy-different-host"), {
    fidelity: HostHandoffFidelitySchema,
  }),
  phaseVariant("await-reap", z.literal("non-preservable-terminals"), {}),
  phaseVariant("leave-in-place", z.literal("handoff-disabled"), {}),
  phaseVariant("reinspect", z.literal("target-build-not-yet-provable"), {}),
  phaseVariant(
    "blocked",
    z.enum([
      "identity-incomplete",
      "inventory-incomplete",
      "evidence-contradictory",
      "recovery-incomplete",
    ]),
    {},
  ),
]);
const reconcilePhaseSchema = z.discriminatedUnion("action", [
  phaseVariant("no-op", z.literal("no-runtime-change"), {}),
  phaseVariant("run", z.literal("runtime-change"), {}),
  phaseVariant(
    "await-artifact",
    z.enum(["package-manager-deferred", "target-build-not-yet-provable"]),
    {},
  ),
  phaseVariant("await-reap", z.literal("reap-required"), {}),
  phaseVariant("not-planned", z.literal("intentionally-incomplete"), {}),
  phaseVariant("blocked", z.literal("convergence-blocked"), {}),
]);
const verificationPhaseSchema = z.discriminatedUnion("action", [
  phaseVariant("satisfied", z.literal("initial-inspection-converged"), {}),
  phaseVariant("inspect", z.literal("after-actions"), {}),
  phaseVariant("await-artifact", z.literal("package-manager-deferred"), {}),
  phaseVariant("await-reap", z.literal("reap-required"), {}),
  phaseVariant("not-planned", z.literal("intentionally-incomplete"), {}),
  phaseVariant("blocked", z.literal("convergence-blocked"), {}),
]);

/**
 * Strict, provider-neutral live-convergence plan. It describes evidence and ordered work only;
 * `authorization: "none"` excludes process, lifecycle, and destructive authority.
 */
export const UpdateConvergencePlanSchema = z
  .object({
    authorization: z.literal("none"),
    selectedTarget: z
      .object({ artifact: UpdateArtifactSchema, runtimeBuild: targetRuntimeSchema })
      .strict(),
    outcome: z.enum([
      "converged",
      "actionable",
      "deferred",
      "reap-required",
      "intentionally-incomplete",
      "blocked",
    ]),
    phases: z
      .object({
        artifactApplication: artifactPhaseSchema,
        hookReconciliation: hookPhaseSchema,
        observerConvergence: observerPhaseSchema,
        terminalConvergence: terminalPhaseSchema,
        hostConvergence: hostPhaseSchema,
        persistedStateReconcile: reconcilePhaseSchema,
        finalVerification: verificationPhaseSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, context) => {
    const providers = plan.phases.hookReconciliation.providers.map((entry) => entry.provider);
    if (!strictlySorted(providers))
      addOrderIssue(context, ["phases", "hookReconciliation", "providers"], "Hook decisions");
    const terminals = plan.phases.terminalConvergence.terminals;
    if (!stationHostTerminalLifetimeIdentitiesAreCanonical(terminals))
      addOrderIssue(context, ["phases", "terminalConvergence", "terminals"], "Terminal facts");
    const terminalFidelity =
      plan.phases.terminalConvergence.action === "preserve-via-handoff"
        ? plan.phases.terminalConvergence.fidelity
        : undefined;
    const hostFidelity =
      plan.phases.hostConvergence.action === "handoff"
        ? plan.phases.hostConvergence.fidelity
        : undefined;
    if (terminalFidelity !== hostFidelity) {
      context.addIssue({
        code: "custom",
        path: ["phases", "hostConvergence", "fidelity"],
        message: "Host and terminal handoff decisions require one matching fidelity.",
      });
    }
  });
export type UpdateConvergencePlan = z.infer<typeof UpdateConvergencePlanSchema>;

function phaseVariant<
  const Action extends string,
  Reason extends z.ZodType,
  Shape extends z.ZodRawShape,
>(action: Action, reason: Reason, shape: Shape) {
  return z.object({ action: z.literal(action), reason, ...shape }).strict();
}
function artifactsMatch(
  left: { version: string; revision?: string },
  right: { version: string; revision?: string },
): boolean {
  return left.version === right.version && left.revision === right.revision;
}
function strictlySorted(values: readonly string[]): boolean {
  return values.every(
    (value, index) =>
      values[index - 1] === undefined || compareCodeUnitStrings(values[index - 1] ?? "", value) < 0,
  );
}
function addOrderIssue(context: z.RefinementCtx, path: PropertyKey[], subject: string): void {
  context.addIssue({
    code: "custom",
    path,
    message: `${subject} must be unique and deterministically sorted.`,
  });
}
