import { z } from "zod";
import { type SafeError, SafeErrorSchema } from "./errors.js";
import { ptyLifetimeIdentitySetsMatch } from "./hostHandoff.js";
import { type ObserverStartupEvidence, ObserverStartupEvidenceSchema } from "./observer.js";
import { providerHookReconciliationSucceeded } from "./providerHooks.js";
import { type UpdateArtifact, UpdateArtifactSchema } from "./updateArtifact.js";
import {
  deriveUpdateReapPreviewConsequences,
  type UpdateActionAudit,
  type UpdateConvergenceResult,
  UpdateConvergenceResultSchema,
  type UpdateEvidencePlan,
  UpdateEvidencePlanSchema,
  updateReapPreviewConsequencesMatch,
} from "./updateConvergence.js";
import {
  type UpdateChannelId,
  UpdateChannelIdSchema,
  type UpdateCommandArgv,
  UpdateCommandArgvSchema,
  updateCommandArgvMatch,
  updateInstallMutationsMatch,
  updateInstallOwnersMatch,
} from "./updateInstall.js";

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

export const UpdateCommandReportStatusSchema = z.enum([
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
  status: z.infer<typeof UpdateCommandReportStatusSchema>;
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
export const UpdateCommandReportSchema: z.ZodType<UpdateCommandReport> = z
  .object({
    schemaVersion: z.literal(4),
    channel: UpdateChannelIdSchema,
    status: UpdateCommandReportStatusSchema,
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
      !updateArtifactsMatch(report.target, report.initial.plan.selectedTarget.artifact) ||
      report.initial.plan.installation.owner !== report.channel
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
        message: "Only execution-failed results require a top-level SafeError.",
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
      (!managerOwned && managerCommand !== undefined) ||
      ((report.artifactApplication.status === "preview" ||
        report.artifactApplication.status === "deferred") &&
        !updateCommandArgvMatch(managerCommand, report.initial.plan.installation.managerCommand))
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifactApplication", "managerCommand"],
        message:
          "Manager-owned preview or deferral must retain the exact manager command, which is forbidden elsewhere.",
      });
    }
    const observerLifecycleStage =
      report.result.kind === "execution-failed" && report.result.stage === "observer-convergence";
    if (
      !observerLifecycleStage &&
      (report.cause !== undefined || report.startupEvidence !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: [report.cause !== undefined ? "cause" : "startupEvidence"],
        message:
          "Observer lifecycle evidence belongs only to an observer-convergence execution failure.",
      });
    }
    validateUpdateResult(report, context);
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

function updateArtifactsMatch(left: UpdateArtifact, right: UpdateArtifact): boolean {
  return left.version === right.version && left.revision === right.revision;
}

/** Derives public status exclusively from artifact state and typed convergence verification. */
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

function validateUpdateResult(
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
    if (
      !updateArtifactsMatch(evidence.preflight.target, report.target) ||
      evidence.plan.installation.owner !== report.initial.plan.installation.owner
    ) {
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
      const plannedFidelity =
        action.phase === "terminal-convergence"
          ? evidence.plan.components.terminals.fidelity
          : action.phase === "host-convergence"
            ? evidence.plan.components.host.fidelity
            : undefined;
      if (action.fidelity !== plannedFidelity) {
        digestMismatch(
          [...path, "actions", index, "fidelity"],
          "Audited handoff fidelity must match the exact authorized convergence decision.",
        );
      }
      if (
        action.phase === "artifact-application" &&
        (action.installation === undefined ||
          !updateInstallMutationsMatch(action.installation, evidence.plan.installation))
      ) {
        digestMismatch(
          [...path, "actions", index, "installation"],
          "Audited artifact application must retain the exact planned install mutation.",
        );
      }
      if (action.handoffReceipt !== undefined) {
        const terminals =
          evidence.preflight.host.status === "inspected" ? evidence.preflight.host.terminals : [];
        if (!ptyLifetimeIdentitySetsMatch(terminals, action.handoffReceipt.terminals)) {
          digestMismatch(
            [...path, "actions", index, "handoffReceipt"],
            "Terminal handoff receipt must match the exact planned session-bound PTY lifetime identities.",
          );
        }
      }
    });
  };
  const validateSuccessfulRuntimeAudit = (
    evidence: UpdateEvidencePlan,
    audit: UpdateActionAudit,
    path: Array<string | number>,
  ): void => {
    validateAudit(evidence, audit, path);
    const expected = executableRuntimeActions(evidence);
    if (audit.actions.length !== expected.length) {
      digestMismatch(
        [...path, "actions"],
        "Successful runtime audit must contain every executable phase and provider exactly once.",
      );
    }
    audit.actions.forEach((action, index) => {
      const expectedAction = expected[index];
      if (
        expectedAction === undefined ||
        !auditActionIdentityMatches(action, expectedAction) ||
        action.status !== "completed"
      ) {
        digestMismatch(
          [...path, "actions", index],
          "Successful runtime actions must be exact, canonical, unique, and completed.",
        );
      }
      validateCompletedHookResult(action, [...path, "actions", index], digestMismatch);
    });
  };
  const validateFailedRuntimeAudit = (
    evidence: UpdateEvidencePlan,
    audit: UpdateActionAudit,
    stage: Extract<UpdateConvergenceResult, { kind: "execution-failed" }>["stage"],
    path: Array<string | number>,
  ): void => {
    validateAudit(evidence, audit, path);
    const expected = executableRuntimeActions(evidence);
    if (stage === "hook-reconciliation") {
      const hookActions = expected.filter((action) => action.phase === "hook-reconciliation");
      if (
        audit.actions.length !== hookActions.length ||
        audit.actions.some(
          (action, index) =>
            !auditActionIdentityMatches(action, hookActions[index]) ||
            (action.status !== "completed" && action.status !== "failed"),
        ) ||
        !audit.actions.some((action) => action.status === "failed")
      ) {
        digestMismatch(
          [...path, "actions"],
          "Hook failure audit must retain every provider exactly once in canonical order and at least one typed failure.",
        );
      }
      audit.actions.forEach((action, index) => {
        if (action.status === "completed") {
          validateCompletedHookResult(action, [...path, "actions", index], digestMismatch);
        } else if (
          action.hookResult !== undefined &&
          (action.hookResult.provider !== action.provider ||
            providerHookReconciliationSucceeded(action.hookResult))
        ) {
          digestMismatch(
            [...path, "actions", index],
            "Failed hook reconciliation must retain one failed typed provider result.",
          );
        }
      });
      return;
    }
    const finalAction = audit.actions.at(-1);
    if (
      finalAction === undefined ||
      (finalAction.status !== "failed" && finalAction.status !== "skipped") ||
      finalAction.phase !== stage
    ) {
      digestMismatch(
        [...path, "actions"],
        "Runtime failure audit must end with one failed or skipped action matching the failure stage.",
      );
      return;
    }
    if (audit.actions.slice(0, -1).some((action) => action.status !== "completed")) {
      digestMismatch(
        [...path, "actions"],
        "Only the final action in a failure audit may be failed or skipped.",
      );
    }
    const finalExpectedIndex = expected.findIndex((action) =>
      auditActionIdentityMatches(finalAction, action),
    );
    if (finalExpectedIndex < 0) {
      digestMismatch(
        [...path, "actions", audit.actions.length - 1],
        "Failed or skipped action must be executable in the audited convergence plan.",
      );
      return;
    }
    let expectedCompleted = expected.slice(0, finalExpectedIndex);
    if (
      finalAction.phase === "host-convergence" &&
      finalAction.action === "handoff" &&
      expectedCompleted.at(-1)?.phase === "terminal-convergence"
    ) {
      // Terminal preservation becomes auditable only after Host handoff returns a session-bound receipt.
      expectedCompleted = expectedCompleted.slice(0, -1);
    }
    const completed = audit.actions.slice(0, -1);
    if (
      completed.length !== expectedCompleted.length ||
      completed.some(
        (action, index) =>
          !auditActionIdentityMatches(action, expectedCompleted[index]) ||
          action.status !== "completed",
      )
    ) {
      digestMismatch(
        [...path, "actions"],
        "Failure audit must retain the exact completed prefix before its failed stage.",
      );
    }
    completed.forEach((action, index) => {
      validateCompletedHookResult(action, [...path, "actions", index], digestMismatch);
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
        action.status !== "failed",
    );
    if (handoff === undefined) return;
    const before =
      initial.preflight.host.status === "inspected" ? initial.preflight.host.terminals : [];
    const after =
      postAction.preflight.host.status === "inspected" ? postAction.preflight.host.terminals : [];
    if (!ptyLifetimeIdentitySetsMatch(before, after)) {
      digestMismatch(
        path,
        "Verified convergence after handoff must retain every exact session-bound PTY lifetime identity.",
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
            report.result.verification.planDigest !== initialDigest)) ||
        (report.result.reapConsequences !== undefined &&
          !updateReapPreviewConsequencesMatch(
            report.result.reapConsequences,
            deriveUpdateReapPreviewConsequences(report.initial),
          ))
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
        !updateInstallMutationsMatch(
          report.result.postAction.plan.installation,
          report.initial.plan.installation,
        ) ||
        report.result.verification.source !== "post-action"
      ) {
        digestMismatch(["result", "actionAudits"], "Runtime audit must execute the initial plan.");
      }
      validateSuccessfulRuntimeAudit(report.initial, audit, ["result", "actionAudits", 0]);
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
      const expectedVerificationSource = successorAudit === undefined ? "successor" : "post-action";
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
        report.result.successor.plan.installation.action !== "no-op" ||
        !updateInstallOwnersMatch(
          report.initial.plan.installation,
          report.result.successor.plan.installation,
        ) ||
        !updateInstallMutationsMatch(
          report.result.postAction.plan.installation,
          report.result.successor.plan.installation,
        ) ||
        report.result.verification.source !== expectedVerificationSource ||
        (successorAudit === undefined &&
          (report.result.successor.plan.status === "actionable" ||
            report.result.postAction.plan.digest.value !==
              report.result.successor.plan.digest.value)) ||
        (successorAudit !== undefined &&
          (successorAudit.executor !== "successor-cli" ||
            successorAudit.planDigest !== report.result.successor.plan.digest.value))
      ) {
        digestMismatch(
          ["result", "actionAudits"],
          "Successor execution must audit artifact apply and attribute verification to the exact inspected successor plan.",
        );
      }
      if (artifactAudit !== undefined) {
        validateArtifactAudit(
          report.initial,
          artifactAudit,
          "completed",
          ["result", "actionAudits", 0],
          digestMismatch,
        );
      }
      validateEvidenceTarget(report.result.successor, ["result", "successor"]);
      if (successorAudit !== undefined) {
        validateSuccessfulRuntimeAudit(report.result.successor, successorAudit, [
          "result",
          "actionAudits",
          1,
        ]);
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
        if (initialAudit !== undefined) {
          validateArtifactAudit(
            report.initial,
            initialAudit,
            "failed",
            ["result", "actionAudits", 0],
            digestMismatch,
          );
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
        if (initialAudit !== undefined) {
          validateFailedRuntimeAudit(report.initial, initialAudit, report.result.stage, [
            "result",
            "actionAudits",
            0,
          ]);
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
        if (initialAudit !== undefined) {
          validateArtifactAudit(
            report.initial,
            initialAudit,
            "completed",
            ["result", "actionAudits", 0],
            digestMismatch,
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
        if (
          report.result.stage !== "successor-boundary" &&
          report.result.successor !== undefined &&
          successorAudit !== undefined
        ) {
          validateFailedRuntimeAudit(report.result.successor, successorAudit, report.result.stage, [
            "result",
            "actionAudits",
            1,
          ]);
        }
      } else {
        digestMismatch(["artifactApplication"], "Execution failure has invalid artifact state.");
      }
      return;
    }
  }
}

type ExpectedAuditAction = {
  phase: UpdateActionAudit["actions"][number]["phase"];
  action: UpdateActionAudit["actions"][number]["action"];
  provider?: string;
  fidelity?: "processes" | "screen";
};

function executableRuntimeActions(evidence: UpdateEvidencePlan): ExpectedAuditAction[] {
  const actions: ExpectedAuditAction[] = [];
  for (const hook of evidence.plan.components.hooks) {
    if (hook.action === "reconcile") {
      actions.push({ phase: "hook-reconciliation", action: "reconcile", provider: hook.provider });
    }
  }
  const observer = evidence.plan.components.observer;
  if (observer.action === "start" || observer.action === "restart") {
    actions.push({ phase: "observer-convergence", action: observer.action });
  }
  if (evidence.plan.components.terminals.action === "preserve-via-handoff") {
    const fidelity = evidence.plan.components.terminals.fidelity;
    actions.push({
      phase: "terminal-convergence",
      action: "preserve-via-handoff",
      ...(fidelity === undefined ? {} : { fidelity }),
    });
  }
  const host = evidence.plan.components.host;
  if (host.action === "replace-idle" || host.action === "handoff") {
    actions.push({
      phase: "host-convergence",
      action: host.action,
      ...(host.fidelity === undefined ? {} : { fidelity: host.fidelity }),
    });
  }
  if (evidence.plan.components.reconcile.action === "run") {
    actions.push({ phase: "runtime-reconcile", action: "run" });
  }
  if (evidence.plan.components.verification.action === "reinspect") {
    actions.push({ phase: "verification", action: "reinspect" });
  }
  return actions;
}

function auditActionIdentityMatches(
  actual: UpdateActionAudit["actions"][number],
  expected: ExpectedAuditAction | undefined,
): boolean {
  return (
    expected !== undefined &&
    actual.phase === expected.phase &&
    actual.action === expected.action &&
    actual.provider === expected.provider &&
    actual.fidelity === expected.fidelity
  );
}

function validateCompletedHookResult(
  action: UpdateActionAudit["actions"][number],
  path: Array<string | number>,
  addIssue: (path: Array<string | number>, message: string) => void,
): void {
  if (action.phase !== "hook-reconciliation" || action.action !== "reconcile") return;
  if (
    action.hookResult === undefined ||
    action.hookResult.provider !== action.provider ||
    !providerHookReconciliationSucceeded(action.hookResult)
  ) {
    addIssue(
      path,
      "Completed hook reconciliation must retain one successful typed provider result.",
    );
  }
}

function validateArtifactAudit(
  evidence: UpdateEvidencePlan,
  audit: UpdateActionAudit,
  status: "completed" | "failed",
  path: Array<string | number>,
  addIssue: (path: Array<string | number>, message: string) => void,
): void {
  const action = audit.actions[0];
  if (
    audit.executor !== evidence.evaluator ||
    audit.planDigest !== evidence.plan.digest.value ||
    audit.actions.length !== 1 ||
    action?.phase !== "artifact-application" ||
    action.action !== "apply" ||
    action.status !== status ||
    action.installation === undefined ||
    !updateInstallMutationsMatch(action.installation, evidence.plan.installation)
  ) {
    addIssue(path, `Artifact audit must contain the exact ${status} selected apply action.`);
  }
}
