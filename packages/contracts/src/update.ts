import { z } from "zod";
import { type SafeError, SafeErrorSchema } from "./errors.js";
import { ptyLifetimeIdentitySetsMatch } from "./hostHandoff.js";
import { type ObserverStartupEvidence, ObserverStartupEvidenceSchema } from "./observer.js";
import {
  type ProviderHookReconciliationResult,
  ProviderHookReconciliationResultSchema,
} from "./providerHooks.js";
import { nonEmptyStringSchema, safeTextSchema } from "./shared.js";
import { type UpdateArtifact, UpdateArtifactSchema } from "./updateArtifact.js";
import {
  type UpdateActionAudit,
  type UpdateConvergenceResult,
  UpdateConvergenceResultSchema,
  type UpdateEvidencePlan,
  UpdateEvidencePlanSchema,
} from "./updateConvergence.js";
import {
  type UpdateReapRecoveryPreflight,
  UpdateReapRecoveryPreflightSchema,
} from "./updateRecoveryPreflight.js";

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

export type UpdateArtifactApplication =
  | { status: "not-required" }
  | { status: "preview"; managerCommand?: UpdateCommandArgv }
  | { status: "deferred"; managerCommand?: UpdateCommandArgv }
  | { status: "not-attempted" }
  | { status: "applied" }
  | { status: "failed" };

const updateArtifactApplicationInputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-required") }).strict(),
  z
    .object({
      status: z.literal("preview"),
      managerCommand: UpdateCommandArgvSchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("deferred"),
      managerCommand: UpdateCommandArgvSchema.optional(),
    })
    .strict(),
  z.object({ status: z.literal("not-attempted") }).strict(),
  z.object({ status: z.literal("applied") }).strict(),
  z.object({ status: z.literal("failed") }).strict(),
]);

export const UpdateArtifactApplicationSchema: z.ZodType<UpdateArtifactApplication> =
  updateArtifactApplicationInputSchema.transform((application): UpdateArtifactApplication => {
    if (application.status === "preview" || application.status === "deferred") {
      const result: Extract<UpdateArtifactApplication, { status: typeof application.status }> = {
        status: application.status,
      };
      if (application.managerCommand !== undefined) {
        result.managerCommand = application.managerCommand;
      }
      return result;
    }
    return application;
  });

export const UpdateCommandStepIdSchema = z.enum([
  "detect",
  "plan",
  "apply",
  "hook-reconciliation",
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

type UpdateCommandReportCore = {
  channel: UpdateChannelId;
  status: "current" | "planned" | "updated" | "deferred" | "failed";
  current: UpdateArtifact;
  target: UpdateArtifact;
  warnings: SafeError[];
  recoveryCommands: UpdateCommandArgv[];
  error?: SafeError;
  cause?: SafeError;
  startupEvidence?: ObserverStartupEvidence;
};

const UpdateCommandStepV1IdSchema = z.enum([
  "detect",
  "plan",
  "apply",
  "observer-restart",
  "host-handoff",
]);

const UpdateCommandStepV1Schema = z
  .object({
    id: UpdateCommandStepV1IdSchema,
    status: UpdateCommandStepStatusSchema,
    detail: safeTextSchema,
    command: UpdateCommandArgvSchema.optional(),
  })
  .strict()
  .transform((step) => ({
    id: step.id,
    status: step.status,
    detail: step.detail,
    ...(step.command === undefined ? {} : { command: step.command }),
  }));

const updateCommandReportCoreShape = {
  channel: UpdateChannelIdSchema,
  status: z.enum(["current", "planned", "updated", "deferred", "failed"]),
  current: UpdateArtifactSchema,
  target: UpdateArtifactSchema,
  warnings: z.array(SafeErrorSchema),
  recoveryCommands: z.array(UpdateCommandArgvSchema),
  error: SafeErrorSchema.optional(),
  cause: SafeErrorSchema.optional(),
  startupEvidence: ObserverStartupEvidenceSchema.optional(),
} as const;

export type UpdateCommandReportV1 = UpdateCommandReportCore & {
  schemaVersion: 1;
  steps: z.infer<typeof UpdateCommandStepV1Schema>[];
};

/** Strict parser for the original update report retained for compatible consumers. */
export const UpdateCommandReportV1Schema: z.ZodType<UpdateCommandReportV1> = z
  .object({
    schemaVersion: z.literal(1),
    ...updateCommandReportCoreShape,
    steps: z.array(UpdateCommandStepV1Schema),
  })
  .strict()
  .transform(
    (report): UpdateCommandReportV1 => ({
      schemaVersion: report.schemaVersion,
      ...updateCommandReportCore(report),
      steps: report.steps,
    }),
  );

export type UpdateCommandReportV2 = UpdateCommandReportCore & {
  schemaVersion: 2;
  steps: UpdateCommandStep[];
  hookReconciliation?: ProviderHookReconciliationResult;
};

/** Strict parser for #637's provider-hook reconciliation report. */
export const UpdateCommandReportV2Schema: z.ZodType<UpdateCommandReportV2> = z
  .object({
    schemaVersion: z.literal(2),
    ...updateCommandReportCoreShape,
    steps: z.array(UpdateCommandStepSchema),
    hookReconciliation: ProviderHookReconciliationResultSchema.optional(),
  })
  .strict()
  .transform(
    (report): UpdateCommandReportV2 => ({
      schemaVersion: report.schemaVersion,
      ...updateCommandReportCore(report),
      steps: report.steps,
      ...(report.hookReconciliation === undefined
        ? {}
        : { hookReconciliation: report.hookReconciliation }),
    }),
  );

export type UpdateCommandReportV3 = UpdateCommandReportCore & {
  schemaVersion: 3;
  steps: UpdateCommandStep[];
  hookReconciliation?: ProviderHookReconciliationResult;
  recoveryPreflight?: UpdateReapRecoveryPreflight;
};

/** Legacy strict report parser for #639's non-authorizing recovery facts. */
export const UpdateCommandReportV3Schema: z.ZodType<UpdateCommandReportV3> = z
  .object({
    schemaVersion: z.literal(3),
    ...updateCommandReportCoreShape,
    steps: z.array(UpdateCommandStepSchema),
    hookReconciliation: ProviderHookReconciliationResultSchema.optional(),
    recoveryPreflight: UpdateReapRecoveryPreflightSchema.optional(),
  })
  .strict()
  .superRefine((report, context) => {
    if (
      report.recoveryPreflight !== undefined &&
      (!updateArtifactsMatch(report.current, report.recoveryPreflight.installed) ||
        !updateArtifactsMatch(report.target, report.recoveryPreflight.target))
    ) {
      context.addIssue({
        code: "custom",
        path: ["recoveryPreflight"],
        message: "Recovery preflight artifacts must match the enclosing update report.",
      });
    }
  })
  .transform(
    (report): UpdateCommandReportV3 => ({
      schemaVersion: report.schemaVersion,
      ...updateCommandReportCore(report),
      steps: report.steps,
      ...(report.hookReconciliation === undefined
        ? {}
        : { hookReconciliation: report.hookReconciliation }),
      ...(report.recoveryPreflight === undefined
        ? {}
        : { recoveryPreflight: report.recoveryPreflight }),
    }),
  );

export const UpdateCommandReportV4StatusSchema = z.enum([
  "current",
  "planned",
  "updated",
  "deferred",
  "reap-required",
  "intentionally-incomplete",
  "blocked",
  "failed",
]);

export type UpdateCommandReport = {
  schemaVersion: 4;
  channel: UpdateChannelId;
  status: z.infer<typeof UpdateCommandReportV4StatusSchema>;
  current: UpdateArtifact;
  target: UpdateArtifact;
  artifactApplication: UpdateArtifactApplication;
  initial: UpdateEvidencePlan;
  result: UpdateConvergenceResult;
  warnings: SafeError[];
  recoveryCommands: UpdateCommandArgv[];
  error?: SafeError;
  cause?: SafeError;
  startupEvidence?: ObserverStartupEvidence;
};

/** Current strict machine-readable update report with separate artifact and runtime truth. */
export const UpdateCommandReportV4Schema: z.ZodType<UpdateCommandReport> = z
  .object({
    schemaVersion: z.literal(4),
    channel: UpdateChannelIdSchema,
    status: UpdateCommandReportV4StatusSchema,
    current: UpdateArtifactSchema,
    target: UpdateArtifactSchema,
    artifactApplication: UpdateArtifactApplicationSchema,
    initial: UpdateEvidencePlanSchema,
    result: UpdateConvergenceResultSchema,
    warnings: z.array(SafeErrorSchema),
    recoveryCommands: z.array(UpdateCommandArgvSchema),
    error: SafeErrorSchema.optional(),
    cause: SafeErrorSchema.optional(),
    startupEvidence: ObserverStartupEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((report, context) => {
    if (
      !updateArtifactsMatch(report.current, report.initial.preflight.installed) ||
      !updateArtifactsMatch(report.target, report.initial.preflight.target) ||
      !updateArtifactsMatch(report.target, report.initial.plan.selectedTarget.artifact)
    ) {
      context.addIssue({
        code: "custom",
        path: ["initial"],
        message: "Initial evidence artifacts must match the enclosing update report.",
      });
    }
    const initialBuildStatus = updateArtifactsMatch(report.current, report.target)
      ? "known"
      : "not-yet-provable";
    if (report.initial.plan.selectedTarget.buildIdentity.status !== initialBuildStatus) {
      context.addIssue({
        code: "custom",
        path: ["initial", "plan", "selectedTarget", "buildIdentity", "status"],
        message: "Initial target build identity must reflect whether the artifact is installed.",
      });
    }
    const expectedStatus = updateCommandReportStatus(report);
    if (expectedStatus !== report.status) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `Update status must be '${expectedStatus}' for this result.`,
      });
    }
    if ((report.result.kind === "execution-failed") !== (report.error !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Only execution-failed v4 results require a top-level SafeError.",
      });
    }
    const managerOwned =
      report.channel === "homebrew" || report.channel === "npm-global" || report.channel === "mise";
    const managerCommand =
      report.artifactApplication.status === "preview" ||
      report.artifactApplication.status === "deferred"
        ? report.artifactApplication.managerCommand
        : undefined;
    if (
      (managerOwned &&
        (report.artifactApplication.status === "preview" ||
          report.artifactApplication.status === "deferred") &&
        managerCommand === undefined) ||
      (!managerOwned && managerCommand !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifactApplication", "managerCommand"],
        message:
          "Manager-owned preview or deferral must retain the exact manager command, which is forbidden elsewhere.",
      });
    }
    if (
      report.result.kind !== "execution-failed" &&
      (report.cause !== undefined || report.startupEvidence !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: [report.cause !== undefined ? "cause" : "startupEvidence"],
        message: "Observer lifecycle evidence belongs only to execution-failed v4 results.",
      });
    }
    validateV4Result(report, context);
  })
  .transform((report): UpdateCommandReport => {
    const result: UpdateCommandReport = {
      schemaVersion: 4,
      channel: report.channel,
      status: report.status,
      current: report.current,
      target: report.target,
      artifactApplication: report.artifactApplication,
      initial: report.initial,
      result: report.result,
      warnings: report.warnings,
      recoveryCommands: report.recoveryCommands,
    };
    if (report.error !== undefined) result.error = report.error;
    if (report.cause !== undefined) result.cause = report.cause;
    if (report.startupEvidence !== undefined) result.startupEvidence = report.startupEvidence;
    return result;
  });

export const UpdateCommandReportSchema = UpdateCommandReportV4Schema;

export type CompatibleUpdateCommandReport =
  | UpdateCommandReportV1
  | UpdateCommandReportV2
  | UpdateCommandReportV3
  | UpdateCommandReport;

/** Explicit compatible parser for persisted or piped reports from versions 1 through 4. */
export const CompatibleUpdateCommandReportSchema: z.ZodType<CompatibleUpdateCommandReport> =
  z.union([
    UpdateCommandReportV1Schema,
    UpdateCommandReportV2Schema,
    UpdateCommandReportV3Schema,
    UpdateCommandReportV4Schema,
  ]);

function updateArtifactsMatch(left: UpdateArtifact, right: UpdateArtifact): boolean {
  return left.version === right.version && left.revision === right.revision;
}

function updateCommandReportCore(report: {
  channel: UpdateChannelId;
  status: UpdateCommandReportCore["status"];
  current: UpdateArtifact;
  target: UpdateArtifact;
  warnings: SafeError[];
  recoveryCommands: UpdateCommandArgv[];
  error?: SafeError | undefined;
  cause?: SafeError | undefined;
  startupEvidence?: ObserverStartupEvidence | undefined;
}): UpdateCommandReportCore {
  const core: UpdateCommandReportCore = {
    channel: report.channel,
    status: report.status,
    current: report.current,
    target: report.target,
    warnings: report.warnings,
    recoveryCommands: report.recoveryCommands,
  };
  if (report.error !== undefined) core.error = report.error;
  if (report.cause !== undefined) core.cause = report.cause;
  if (report.startupEvidence !== undefined) {
    core.startupEvidence = report.startupEvidence;
  }
  return core;
}

/** Derives v4 public status exclusively from artifact state and typed convergence verification. */
export function updateCommandReportStatus(
  report: Pick<UpdateCommandReport, "artifactApplication" | "initial" | "result">,
): UpdateCommandReport["status"] {
  switch (report.result.kind) {
    case "already-converged":
      return "current";
    case "preview":
      switch (report.initial.plan.status) {
        case "converged":
          return "current";
        case "actionable":
          return "planned";
        case "deferred":
          return "deferred";
        case "reap-required":
        case "intentionally-incomplete":
        case "blocked":
          return report.initial.plan.status;
      }
      return assertNever(report.initial.plan.status);
    case "deferred":
      return "deferred";
    case "non-mutating-stop":
      return report.result.disposition;
    case "current-runtime-execution":
      return report.result.verification.status === "converged"
        ? "current"
        : report.result.verification.disposition === "actionable"
          ? "failed"
          : report.result.verification.disposition;
    case "successor-runtime-execution":
      return report.result.verification.status === "converged"
        ? report.artifactApplication.status === "applied"
          ? "updated"
          : "current"
        : report.result.verification.disposition === "actionable"
          ? "failed"
          : report.result.verification.disposition;
    case "execution-failed":
      return "failed";
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected update report variant: ${String(value)}`);
}

function validateV4Result(
  report: Pick<
    UpdateCommandReport,
    "artifactApplication" | "current" | "initial" | "result" | "status" | "target"
  >,
  context: z.RefinementCtx,
): void {
  const initialDigest = report.initial.plan.digest.value;
  const digestMismatch = (path: Array<string | number>, message: string) =>
    context.addIssue({ code: "custom", path, message });
  const validateEvidenceTarget = (
    evidence: UpdateEvidencePlan,
    path: Array<string | number>,
  ): void => {
    if (!updateArtifactsMatch(evidence.preflight.target, report.target)) {
      digestMismatch(path, "Inspected convergence evidence must retain the selected target.");
    }
  };
  const validateAudit = (
    evidence: UpdateEvidencePlan,
    audit: UpdateActionAudit,
    path: Array<string | number>,
  ): void => {
    if (audit.executor !== evidence.evaluator || audit.planDigest !== evidence.plan.digest.value) {
      digestMismatch(path, "Action audit must identify the exact evaluated convergence plan.");
    }
    const plannedActions = new Map(evidence.plan.phases.map((phase) => [phase.id, phase.action]));
    audit.actions.forEach((action, index) => {
      const plannedAction =
        action.phase === "hook-reconciliation" && action.provider !== undefined
          ? evidence.plan.components.hooks.find((hook) => hook.provider === action.provider)?.action
          : plannedActions.get(action.phase);
      if (plannedAction !== action.action) {
        digestMismatch(
          [...path, "actions", index],
          "Audited action must match the action authorized by its convergence phase.",
        );
      }
      if (action.handoffReceipt !== undefined) {
        const terminals =
          evidence.preflight.host.status === "inspected" ? evidence.preflight.host.terminals : [];
        if (!ptyLifetimeIdentitySetsMatch(terminals, action.handoffReceipt.terminals)) {
          digestMismatch(
            [...path, "actions", index, "handoffReceipt"],
            "Terminal handoff receipt must match the exact planned PTY lifetime identities.",
          );
        }
      }
    });
  };
  const validateTerminalContinuity = (
    initial: UpdateEvidencePlan,
    postAction: UpdateEvidencePlan,
    audit: UpdateActionAudit | undefined,
    path: Array<string | number>,
  ): void => {
    const handoff = audit?.actions.find(
      (action) =>
        action.phase === "terminal-convergence" &&
        action.action === "preserve-via-handoff" &&
        action.status === "completed",
    );
    if (handoff === undefined) return;
    const before =
      initial.preflight.host.status === "inspected" ? initial.preflight.host.terminals : [];
    const after =
      postAction.preflight.host.status === "inspected" ? postAction.preflight.host.terminals : [];
    if (!ptyLifetimeIdentitySetsMatch(before, after)) {
      digestMismatch(
        path,
        "Verified convergence after handoff must retain every exact PTY lifetime identity.",
      );
    }
  };
  const validateVerification = (
    evidence: UpdateEvidencePlan,
    verification: Extract<
      UpdateConvergenceResult,
      { kind: "current-runtime-execution" }
    >["verification"],
    path: Array<string | number>,
  ) => {
    validateEvidenceTarget(evidence, path);
    if (verification.planDigest !== evidence.plan.digest.value) {
      digestMismatch(
        [...path, "planDigest"],
        "Verification must identify the inspected plan digest.",
      );
    }
    if (
      (verification.status === "converged") !== (evidence.plan.status === "converged") ||
      (verification.status === "not-converged" && verification.disposition !== evidence.plan.status)
    ) {
      digestMismatch(path, "Verification status must match the inspected convergence plan.");
    }
    if (verification.status === "not-converged" && verification.disposition === "actionable") {
      digestMismatch(
        path,
        "Executed convergence with remaining actions must use a verification-stage failure.",
      );
    }
  };

  switch (report.result.kind) {
    case "already-converged":
      if (
        report.artifactApplication.status !== "not-required" ||
        report.initial.plan.status !== "converged" ||
        report.result.verification.status !== "converged" ||
        report.result.verification.source !== "initial" ||
        report.result.verification.planDigest !== initialDigest
      ) {
        digestMismatch(["result"], "Already-converged must verify the initial no-op plan.");
      }
      return;
    case "preview":
      if (
        report.artifactApplication.status !== "preview" ||
        report.result.planDigest !== initialDigest ||
        (report.result.verification !== undefined &&
          (report.initial.plan.status !== "converged" ||
            report.result.verification.status !== "converged" ||
            report.result.verification.source !== "initial" ||
            report.result.verification.planDigest !== initialDigest))
      ) {
        digestMismatch(
          ["result"],
          "Preview must remain non-executed and identify the initial plan.",
        );
      }
      return;
    case "deferred":
      if (
        report.artifactApplication.status !== "deferred" ||
        report.initial.plan.status !== "deferred" ||
        report.result.planDigest !== initialDigest
      ) {
        digestMismatch(["result"], "Deferred result must identify the initial deferred plan.");
      }
      return;
    case "non-mutating-stop": {
      const expectedArtifactStatus = updateArtifactsMatch(report.current, report.target)
        ? "not-required"
        : "not-attempted";
      if (
        report.artifactApplication.status !== expectedArtifactStatus ||
        report.initial.plan.status !== report.result.disposition ||
        report.result.planDigest !== initialDigest
      ) {
        digestMismatch(
          ["result"],
          "Non-mutating stop must retain the initial disposition and artifact state.",
        );
      }
      return;
    }
    case "current-runtime-execution": {
      const audit = report.result.actionAudits[0];
      if (
        report.artifactApplication.status !== "not-required" ||
        report.initial.plan.status !== "actionable" ||
        report.result.postAction.evaluator !== report.initial.evaluator ||
        report.result.verification.source !== "post-action"
      ) {
        digestMismatch(["result", "actionAudits"], "Runtime audit must execute the initial plan.");
      }
      validateAudit(report.initial, audit, ["result", "actionAudits", 0]);
      validateVerification(report.result.postAction, report.result.verification, [
        "result",
        "verification",
      ]);
      validateTerminalContinuity(report.initial, report.result.postAction, audit, [
        "result",
        "postAction",
        "preflight",
        "host",
        "terminals",
      ]);
      return;
    }
    case "successor-runtime-execution": {
      const artifactAudit = report.result.actionAudits[0];
      const successorAudit = report.result.actionAudits[1];
      if (
        report.artifactApplication.status !== "applied" ||
        artifactAudit?.planDigest !== initialDigest ||
        artifactAudit.executor !== report.initial.evaluator ||
        artifactAudit.actions.length !== 1 ||
        artifactAudit.actions[0]?.phase !== "artifact-application" ||
        artifactAudit.actions[0]?.action !== "apply" ||
        artifactAudit.actions[0]?.status !== "completed" ||
        report.result.successor.evaluator !== "successor-cli" ||
        report.result.postAction.evaluator !== "successor-cli" ||
        report.result.successor.plan.selectedTarget.buildIdentity.status !== "known" ||
        report.result.verification.source !== "post-action" ||
        (successorAudit === undefined &&
          report.result.postAction.plan.digest.value !==
            report.result.successor.plan.digest.value) ||
        (successorAudit !== undefined &&
          (successorAudit.executor !== "successor-cli" ||
            successorAudit.planDigest !== report.result.successor.plan.digest.value))
      ) {
        digestMismatch(
          ["result", "actionAudits"],
          "Successor execution must audit artifact apply and the exact successor plan.",
        );
      }
      if (artifactAudit !== undefined) {
        validateAudit(report.initial, artifactAudit, ["result", "actionAudits", 0]);
      }
      validateEvidenceTarget(report.result.successor, ["result", "successor"]);
      if (successorAudit !== undefined) {
        validateAudit(report.result.successor, successorAudit, ["result", "actionAudits", 1]);
      }
      validateVerification(report.result.postAction, report.result.verification, [
        "result",
        "verification",
      ]);
      validateTerminalContinuity(
        report.result.successor,
        report.result.postAction,
        successorAudit,
        ["result", "postAction", "preflight", "host", "terminals"],
      );
      return;
    }
    case "execution-failed": {
      const [initialAudit, successorAudit, ...extraAudits] = report.result.actionAudits;
      if (extraAudits.length > 0) {
        digestMismatch(["result", "actionAudits"], "Failure audit supports one actor crossover.");
      }
      if (initialAudit !== undefined) {
        validateAudit(report.initial, initialAudit, ["result", "actionAudits", 0]);
      }
      if (report.result.successor !== undefined) {
        validateEvidenceTarget(report.result.successor, ["result", "successor"]);
        if (
          report.result.successor.evaluator !== "successor-cli" ||
          report.result.successor.plan.selectedTarget.buildIdentity.status !== "known"
        ) {
          digestMismatch(
            ["result", "successor"],
            "Successor failure evidence must be target-owned.",
          );
        }
      }
      if (successorAudit !== undefined) {
        if (report.result.successor === undefined) {
          digestMismatch(
            ["result", "actionAudits", 1],
            "Successor action audit requires successor plan evidence.",
          );
        } else {
          validateAudit(report.result.successor, successorAudit, ["result", "actionAudits", 1]);
        }
      }
      if (report.result.finalInspection.status === "completed") {
        validateEvidenceTarget(report.result.finalInspection.evidence, [
          "result",
          "finalInspection",
          "evidence",
        ]);
      }
      const artifactAction = initialAudit?.actions[0];
      if (report.result.stage === "artifact-application") {
        if (
          report.artifactApplication.status !== "failed" ||
          report.result.actionAudits.length !== 1 ||
          artifactAction?.phase !== "artifact-application" ||
          artifactAction.action !== "apply" ||
          artifactAction.status !== "failed" ||
          report.result.finalInspection.status !== "not-attempted" ||
          report.result.finalInspection.reason !== "artifact-application-failed"
        ) {
          digestMismatch(["result"], "Artifact failure must audit the failed initial apply only.");
        }
      } else if (report.artifactApplication.status === "not-required") {
        if (
          report.initial.plan.status !== "actionable" ||
          report.result.actionAudits.length !== 1 ||
          report.result.successor !== undefined ||
          report.result.finalInspection.status === "not-attempted"
        ) {
          digestMismatch(
            ["result"],
            "Current-runtime failure must retain one initial audit and a final inspection outcome.",
          );
        }
      } else if (report.artifactApplication.status === "applied") {
        if (
          initialAudit === undefined ||
          artifactAction?.phase !== "artifact-application" ||
          artifactAction.action !== "apply" ||
          artifactAction.status !== "completed"
        ) {
          digestMismatch(
            ["result"],
            "Post-apply failure must retain the completed artifact audit.",
          );
        }
        if (
          report.result.stage === "successor-boundary" &&
          (report.result.successor !== undefined ||
            report.result.finalInspection.status !== "not-attempted" ||
            report.result.finalInspection.reason !== "successor-unavailable")
        ) {
          digestMismatch(
            ["result"],
            "Successor boundary failure must not claim unavailable successor inspection.",
          );
        }
        if (
          report.result.stage !== "successor-boundary" &&
          (report.result.successor === undefined || successorAudit === undefined)
        ) {
          digestMismatch(
            ["result"],
            "Successor runtime failure must identify and audit the successor plan.",
          );
        }
      } else {
        digestMismatch(["artifactApplication"], "Execution failure has invalid artifact state.");
      }
      return;
    }
  }
}
