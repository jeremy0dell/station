import {
  hostConvergenceCommitmentsMatch,
  type ObserverLifecycleFailure,
  providerHookReconciliationSucceeded,
  ptyLifetimeIdentitySetsMatch,
  type UpdateActionAudit,
  type UpdateArtifact,
  type UpdateArtifactApplication,
  type UpdateCommandReport,
  type UpdateConvergenceResult,
  type UpdateEvidencePlan,
  type UpdateExecutedAction,
  type UpdateFinalInspection,
  type UpdateHostConvergenceCommitment,
} from "@station/contracts";
import { publicSafeErrorFromUnknown, type StationBuildInfo } from "@station/runtime";
import {
  type PlannedUpdateChannel,
  selectInstalledUpdateChannel,
  selectUpdateChannel,
  type UpdateChannelProbe,
} from "./channelDetection.js";
import { attachUpdateConvergenceDigest } from "./convergenceDigest.js";
import { planUpdateConvergence, type UpdateArtifactPlanAction } from "./convergencePlan.js";
import {
  type UpdateConvergenceInspectionPort,
  type UpdateConvergencePreflightInspection,
  validateUpdateConvergenceInspection,
} from "./recoveryPreflight.js";
import { nonExecutedPhases } from "./updateCommandStatusPolicy.js";
import type { UpdateConvergenceRequest } from "./updateConvergencePort.js";
import { updateErrorFromUnknown } from "./updateError.js";
import type { UpdateHostRuntimePort } from "./updateHostRuntimePort.js";
import type { PublicUpdateReportInput, UpdatePublicReportPort } from "./updatePublicReportPort.js";
import type { UpdateRuntimeConvergencePort } from "./updateRuntimeConvergencePort.js";
import type { UpdateSuccessorTransportPort } from "./updateSuccessorTransportPort.js";

export type UpdateConvergencePorts = {
  /** Returns one strict public/private aggregate for the exact selected artifacts. */
  convergenceInspection: UpdateConvergenceInspectionPort;
  probes: readonly UpdateChannelProbe[];
  buildInfo: () => StationBuildInfo;
  publicReport: UpdatePublicReportPort;
  host: UpdateHostRuntimePort;
  runtime: UpdateRuntimeConvergencePort;
  successor: UpdateSuccessorTransportPort;
};

type InFlightUpdateAction = Pick<
  UpdateExecutedAction,
  "phase" | "action" | "provider" | "fidelity"
>;

/**
 * USE CASE
 *
 * Resolves the install owner, inspects all live state, plans convergence, executes only safe typed
 * actions, and verifies a fresh no-op plan. Host actions retain the plan's exact build, immutable
 * PTY commitment, and handoff fidelity without fallback. Artifact application remains channel-owned; destructive
 * Station process-group authorization, journaling, and reaping remain exclusively owned by #641.
 */
export async function runUpdateConvergence(
  request: UpdateConvergenceRequest,
  ports: UpdateConvergencePorts,
): Promise<UpdateCommandReport> {
  const finishReport = reportFinisher(ports.publicReport);
  const selected =
    request.successorTarget === undefined
      ? await selectUpdateChannel({
          probes: ports.probes,
          ...(request.channel === undefined ? {} : { requested: request.channel }),
        })
      : await selectInstalledUpdateChannel({
          probes: ports.probes,
          target: request.successorTarget,
          ...(request.channel === undefined ? {} : { requested: request.channel }),
        });
  validatePackageManagerRequest(selected, request);

  const current = artifact(selected.plan.currentVersion, selected.plan.currentRevision);
  const detectedTarget = artifact(selected.plan.targetVersion, selected.plan.targetRevision);
  const target = request.successorTarget ?? detectedTarget;
  const build = ports.buildInfo();
  validateSuccessorTarget(request, current, build);
  const artifactAction = artifactActionFor(selected, request);
  const initial = await inspectAndPlan({
    evaluator: request.evaluator,
    current,
    target,
    selected,
    artifactAction,
    build,
    request,
    ports,
  });

  if (request.mode === "preview") {
    const result: UpdateConvergenceResult = {
      kind: "preview",
      planDigest: initial.plan.digest.value,
      phases: nonExecutedPhases(initial.plan),
      ...(initial.plan.status === "converged"
        ? {
            verification: {
              status: "converged" as const,
              source: "initial" as const,
              planDigest: initial.plan.digest.value,
            },
          }
        : {}),
    };
    return finishReport({
      selected,
      current,
      target,
      artifactApplication: managerAwareArtifactApplication("preview", selected),
      initial,
      result,
    });
  }

  if (
    initial.plan.status === "blocked" ||
    initial.plan.status === "reap-required" ||
    initial.plan.status === "intentionally-incomplete"
  ) {
    const result: UpdateConvergenceResult = {
      kind: "non-mutating-stop",
      disposition: initial.plan.status,
      planDigest: initial.plan.digest.value,
      phases: nonExecutedPhases(initial.plan),
    };
    return finishReport({
      selected,
      current,
      target,
      artifactApplication: {
        status: artifactAction === "no-op" ? "not-required" : "not-attempted",
      },
      initial,
      result,
    });
  }

  if (initial.plan.status === "deferred") {
    const result: UpdateConvergenceResult = {
      kind: "deferred",
      planDigest: initial.plan.digest.value,
      phases: initial.plan.phases.map((phase) => ({
        id: phase.id,
        status: phase.id === "artifact-application" ? "deferred" : "not-executed",
      })),
    };
    return finishReport({
      selected,
      current,
      target,
      artifactApplication: managerAwareArtifactApplication("deferred", selected),
      initial,
      result,
    });
  }

  if (initial.plan.status === "converged") {
    return finishReport({
      selected,
      current,
      target,
      artifactApplication: { status: "not-required" },
      initial,
      result: {
        kind: "already-converged",
        verification: {
          status: "converged",
          source: "initial",
          planDigest: initial.plan.digest.value,
        },
      },
    });
  }

  return artifactAction === "apply"
    ? applyThenConverge(selected, current, target, initial, request, ports)
    : executeCurrentRuntime(selected, current, target, initial, request, ports);
}

async function applyThenConverge(
  selected: PlannedUpdateChannel,
  current: UpdateArtifact,
  target: UpdateArtifact,
  initial: UpdateEvidencePlan,
  request: UpdateConvergenceRequest,
  ports: UpdateConvergencePorts,
): Promise<UpdateCommandReport> {
  const finishReport = reportFinisher(ports.publicReport);
  const artifactAudit: UpdateActionAudit = {
    executor: request.evaluator,
    planDigest: initial.plan.digest.value,
    actions: [{ phase: "artifact-application", action: "apply", status: "completed" }],
  };
  let applied: Awaited<ReturnType<PlannedUpdateChannel["apply"]>>;
  try {
    applied = await selected.apply({ drivePackageManager: request.packageManager === "drive" });
  } catch (error) {
    artifactAudit.actions[0] = {
      phase: "artifact-application",
      action: "apply",
      status: "failed",
    };
    const safe = updateErrorFromUnknown(error, {
      code: "UPDATE_ARTIFACT_APPLICATION_FAILED",
      message: "Station could not apply the selected artifact.",
    });
    return finishReport({
      selected,
      current,
      target,
      artifactApplication: { status: "failed" },
      initial,
      result: {
        kind: "execution-failed",
        stage: "artifact-application",
        actionAudits: [artifactAudit],
        finalInspection: { status: "not-attempted", reason: "artifact-application-failed" },
      },
      error: safe,
      recoveryCommands: recoveryCommands(selected, request, ports),
    });
  }
  if (applied.status === "deferred") {
    return finishReport({
      selected,
      current,
      target,
      artifactApplication: managerAwareArtifactApplication("deferred", selected),
      initial,
      result: {
        kind: "deferred",
        planDigest: initial.plan.digest.value,
        phases: initial.plan.phases.map((phase) => ({
          id: phase.id,
          status: phase.id === "artifact-application" ? "deferred" : "not-executed",
        })),
      },
      warnings: applied.warnings,
    });
  }
  if (applied.successorCli === undefined) {
    const error = updateErrorFromUnknown(undefined, {
      code: "UPDATE_SUCCESSOR_UNAVAILABLE",
      message: "The artifact was applied without identifying its successor Station launcher.",
    });
    return finishReport({
      selected,
      current,
      target,
      artifactApplication: { status: "applied" },
      initial,
      result: {
        kind: "execution-failed",
        stage: "successor-boundary",
        actionAudits: [artifactAudit],
        finalInspection: { status: "not-attempted", reason: "successor-unavailable" },
      },
      warnings: applied.warnings,
      error,
      recoveryCommands: recoveryCommands(selected, request, ports),
    });
  }

  try {
    const successorReport = await ports.successor.run({
      launcher: applied.successorCli,
      channel: selected.channel,
      target,
      ...(request.handoff === undefined ? {} : { handoff: request.handoff }),
    });
    const successorAudits = auditsFrom(successorReport);
    if (successorReport.result.kind === "execution-failed") {
      return finishReport({
        selected,
        current,
        target,
        artifactApplication: { status: "applied" },
        initial,
        result: {
          kind: "execution-failed",
          stage: successorReport.result.stage,
          actionAudits: [artifactAudit, ...successorAudits],
          successor: successorReport.initial,
          finalInspection: successorReport.result.finalInspection,
        },
        warnings: [...applied.warnings, ...successorReport.warnings],
        ...(successorReport.error === undefined ? {} : { error: successorReport.error }),
        ...(successorReport.cause === undefined ? {} : { cause: successorReport.cause }),
        ...(successorReport.startupEvidence === undefined
          ? {}
          : { startupEvidence: successorReport.startupEvidence }),
        recoveryCommands: successorReport.recoveryCommands,
      });
    }
    const verified = successorVerificationEvidence(successorReport);
    return finishReport({
      selected,
      current,
      target,
      artifactApplication: { status: "applied" },
      initial,
      result: {
        kind: "successor-runtime-execution",
        actionAudits: [artifactAudit, ...successorAudits],
        successor: successorReport.initial,
        postAction: verified.evidence,
        verification: verificationFor(verified.evidence, verified.source),
      },
      warnings: [...applied.warnings, ...successorReport.warnings],
      recoveryCommands: successorReport.recoveryCommands,
    });
  } catch (error) {
    const safe = updateErrorFromUnknown(error, {
      code: "UPDATE_SUCCESSOR_BOUNDARY_FAILED",
      message: "The artifact was applied but successor runtime convergence could not start.",
    });
    return finishReport({
      selected,
      current,
      target,
      artifactApplication: { status: "applied" },
      initial,
      result: {
        kind: "execution-failed",
        stage: "successor-boundary",
        actionAudits: [artifactAudit],
        finalInspection: { status: "not-attempted", reason: "successor-unavailable" },
      },
      warnings: applied.warnings,
      error: safe,
      recoveryCommands: recoveryCommands(selected, request, ports),
    });
  }
}

async function executeCurrentRuntime(
  selected: PlannedUpdateChannel,
  current: UpdateArtifact,
  target: UpdateArtifact,
  initial: UpdateEvidencePlan,
  request: UpdateConvergenceRequest,
  ports: UpdateConvergencePorts,
): Promise<UpdateCommandReport> {
  const finishReport = reportFinisher(ports.publicReport);
  const actions: UpdateExecutedAction[] = [];
  let inFlightAction: InFlightUpdateAction | undefined;
  let observerLifecycleFailure: ObserverLifecycleFailure | undefined;
  const audit: UpdateActionAudit = {
    executor: request.evaluator,
    planDigest: initial.plan.digest.value,
    actions,
  };
  try {
    for (const hook of initial.plan.components.hooks) {
      if (hook.action !== "reconcile") continue;
      inFlightAction = {
        phase: "hook-reconciliation",
        action: "reconcile",
        provider: hook.provider,
      };
      const result = await ports.runtime.reconcileHook(selected.plan.currentCli, hook.provider);
      const succeeded = providerHookReconciliationSucceeded(result);
      actions.push({
        phase: "hook-reconciliation",
        action: "reconcile",
        status: succeeded ? "completed" : "failed",
        provider: hook.provider,
        hookResult: result,
      });
      if (!succeeded) {
        throw result.status === "ownership-conflict"
          ? updateErrorFromUnknown(undefined, {
              code: "UPDATE_HOOK_OWNERSHIP_CONFLICT",
              message: "Configured provider hooks are owned by another installation.",
            })
          : result.error;
      }
      inFlightAction = undefined;
    }
    const observer = initial.plan.components.observer;
    if (observer.action === "start" || observer.action === "restart") {
      inFlightAction = {
        phase: "observer-convergence",
        action: observer.action,
      };
      observerLifecycleFailure = await ports.runtime.convergeObserver(
        selected.plan.currentCli,
        observer.action,
      );
      if (observerLifecycleFailure !== undefined) {
        throw updateErrorFromUnknown(undefined, {
          code: "UPDATE_RUNTIME_CONVERGENCE_FAILED",
          message: "Station could not complete safe runtime convergence.",
        });
      }
      actions.push({
        phase: "observer-convergence",
        action: observer.action,
        status: "completed",
      });
      inFlightAction = undefined;
    }
    const host = initial.plan.components.host;
    if (host.action === "handoff" || host.action === "replace-idle") {
      const commitment = hostConvergenceCommitment(initial);
      const plannedFidelity =
        host.action === "handoff" ? requiredHandoffFidelity(host.fidelity) : undefined;
      inFlightAction = {
        phase: "host-convergence",
        action: host.action,
        ...(plannedFidelity === undefined ? {} : { fidelity: plannedFidelity }),
      };
      const hostResult =
        host.action === "handoff"
          ? await ports.host.handoffHost(requiredHandoffFidelity(plannedFidelity), commitment)
          : await ports.host.replaceIdleHost(commitment);
      if (
        hostResult.requestedAction !== host.action ||
        hostResult.requestedFidelity !== plannedFidelity
      ) {
        throw updateErrorFromUnknown(undefined, {
          code: "UPDATE_HOST_CONVERGENCE_ACTION_MISMATCH",
          message:
            "Host convergence returned an outcome for a different planned action or fidelity.",
        });
      }
      switch (hostResult.status) {
        case "absent":
        case "stale":
        case "failed":
          throw hostResult.error;
        case "already-converged":
          if (!hostConvergenceCommitmentsMatch(hostResult.validatedCommitment, commitment)) {
            throw hostCommitmentMismatch();
          }
          actions.push({
            phase: "host-convergence",
            action: host.action,
            status: "skipped",
            ...(plannedFidelity === undefined ? {} : { fidelity: plannedFidelity }),
          });
          throw updateErrorFromUnknown(undefined, {
            code: "UPDATE_HOST_CONVERGENCE_SUPERSEDED",
            message:
              "Another actor converged the Host before the authorized mutation; Station stopped for fresh verification.",
          });
        case "completed": {
          const hostReceipt = hostResult.receipt;
          if (!hostConvergenceCommitmentsMatch(hostReceipt.validatedCommitment, commitment)) {
            throw hostCommitmentMismatch();
          }
          if (host.action === "handoff") {
            inFlightAction = {
              phase: "terminal-convergence",
              action: "preserve-via-handoff",
              fidelity: plannedFidelity,
            };
            const expectedTerminals =
              initial.preflight.host.status === "inspected" ? initial.preflight.host.terminals : [];
            if (
              hostReceipt.ensuredBy !== "handoff" ||
              hostReceipt.fidelity !== plannedFidelity ||
              !ptyLifetimeIdentitySetsMatch(expectedTerminals, hostReceipt.handoffReceipt.terminals)
            ) {
              throw updateErrorFromUnknown(undefined, {
                code: "UPDATE_TERMINAL_HANDOFF_RECEIPT_MISMATCH",
                message: "Host handoff did not acknowledge every exact planned PTY lifetime.",
              });
            }
            actions.push({
              phase: "terminal-convergence",
              action: "preserve-via-handoff",
              status: "completed",
              fidelity: plannedFidelity,
              handoffReceipt: hostReceipt.handoffReceipt,
            });
          } else if (hostReceipt.ensuredBy !== "idle-replace") {
            throw updateErrorFromUnknown(undefined, {
              code: "UPDATE_HOST_CONVERGENCE_ACTION_MISMATCH",
              message: "Host convergence completed through an action the plan did not authorize.",
            });
          }
          actions.push({
            phase: "host-convergence",
            action: host.action,
            status: "completed",
            ...(plannedFidelity === undefined ? {} : { fidelity: plannedFidelity }),
          });
          inFlightAction = undefined;
          break;
        }
      }
    }
    if (initial.plan.components.reconcile.action === "run") {
      inFlightAction = {
        phase: "runtime-reconcile",
        action: "run",
      };
      await ports.runtime.reconcile(selected.plan.currentCli);
      actions.push({ phase: "runtime-reconcile", action: "run", status: "completed" });
      inFlightAction = undefined;
    }
  } catch (error) {
    let failedAction = actions.at(-1);
    if (failedAction?.status !== "failed" && failedAction?.status !== "skipped") {
      // Descriptive phases such as terminal convergence must not shift the identity of the
      // concrete mutation that failed.
      if (inFlightAction === undefined) {
        throw new Error("Runtime convergence failure has no in-flight action identity.", {
          cause: error,
        });
      }
      failedAction = { ...inFlightAction, status: "failed" };
      actions.push(failedAction);
    }
    const safe = updateErrorFromUnknown(error, {
      code: "UPDATE_RUNTIME_CONVERGENCE_FAILED",
      message: "Station could not complete safe runtime convergence.",
    });
    const finalInspection = await attemptFinalInspection({
      current,
      target,
      selected,
      build: ports.buildInfo(),
      request,
      ports,
    });
    return finishReport({
      selected,
      current,
      target,
      artifactApplication: { status: "not-required" },
      initial,
      result: {
        kind: "execution-failed",
        stage: failedAction.phase,
        actionAudits: [audit],
        finalInspection,
      },
      error: safe,
      ...(observerLifecycleFailure === undefined
        ? {}
        : {
            cause: observerLifecycleFailure.cause ?? observerLifecycleFailure.error,
            ...(observerLifecycleFailure.startupEvidence === undefined
              ? {}
              : { startupEvidence: observerLifecycleFailure.startupEvidence }),
          }),
      recoveryCommands: recoveryCommands(selected, request, ports),
    });
  }

  const finalInspection = await attemptFinalInspection({
    current,
    target,
    selected,
    build: ports.buildInfo(),
    request,
    ports,
  });
  if (finalInspection.status !== "completed") {
    const error =
      finalInspection.status === "failed"
        ? finalInspection.error
        : updateErrorFromUnknown(undefined, {
            code: "UPDATE_FINAL_INSPECTION_FAILED",
            message: "Final aggregate inspection was not attempted after runtime convergence.",
          });
    actions.push({ phase: "verification", action: "reinspect", status: "failed" });
    return finishReport({
      selected,
      current,
      target,
      artifactApplication: { status: "not-required" },
      initial,
      result: {
        kind: "execution-failed",
        stage: "verification",
        actionAudits: [audit],
        finalInspection,
      },
      error,
      recoveryCommands: recoveryCommands(selected, request, ports),
    });
  }
  const postAction = finalInspection.evidence;
  if (!terminalsPreservedAcrossHostConvergence(initial, postAction, audit)) {
    const error = updateErrorFromUnknown(undefined, {
      code: "UPDATE_TERMINAL_CONVERGENCE_INCOMPLETE",
      message:
        "Fresh inspection after Host handoff did not retain every planned PTY lifetime identity.",
    });
    actions.push({ phase: "verification", action: "reinspect", status: "failed" });
    return finishReport({
      selected,
      current,
      target,
      artifactApplication: { status: "not-required" },
      initial,
      result: {
        kind: "execution-failed",
        stage: "verification",
        actionAudits: [audit],
        finalInspection,
      },
      error,
      recoveryCommands: recoveryCommands(selected, request, ports),
    });
  }
  if (postAction.plan.status === "actionable") {
    const error = updateErrorFromUnknown(undefined, {
      code: "UPDATE_RUNTIME_CONVERGENCE_INCOMPLETE",
      message:
        "Station completed the planned runtime actions, but fresh inspection still requires convergence.",
    });
    actions.push({ phase: "verification", action: "reinspect", status: "failed" });
    return finishReport({
      selected,
      current,
      target,
      artifactApplication: { status: "not-required" },
      initial,
      result: {
        kind: "execution-failed",
        stage: "verification",
        actionAudits: [audit],
        finalInspection,
      },
      error,
      recoveryCommands: recoveryCommands(selected, request, ports),
    });
  }
  actions.push({ phase: "verification", action: "reinspect", status: "completed" });
  return finishReport({
    selected,
    current,
    target,
    artifactApplication: { status: "not-required" },
    initial,
    result: {
      kind: "current-runtime-execution",
      actionAudits: [audit],
      postAction,
      verification: verificationFor(postAction, "post-action"),
    },
  });
}

function hostConvergenceCommitment(evidence: UpdateEvidencePlan): UpdateHostConvergenceCommitment {
  const host = evidence.preflight.host;
  const targetBuild = evidence.plan.selectedTarget.buildIdentity;
  if (host.status !== "inspected" || targetBuild.status !== "known") {
    throw new Error(
      "Actionable Host convergence requires inspected Host and target build evidence.",
    );
  }
  return {
    incumbent: {
      buildVersion: committedHostValue(host.buildVersion),
      buildIdentity: committedHostValue(host.buildIdentity),
      protocolVersion: host.protocolVersion,
      inventory: {
        terminals: host.terminals.map((terminal) => ({
          terminalTargetId: terminal.terminalTargetId,
          ptyId: terminal.ptyId,
          ptyInstanceId: terminal.ptyInstanceId,
        })),
      },
    },
    target: {
      buildVersion: evidence.plan.selectedTarget.artifact.version,
      buildIdentity: targetBuild.value,
    },
  };
}

function requiredHandoffFidelity(
  fidelity: "processes" | "screen" | undefined,
): "processes" | "screen" {
  if (fidelity === undefined) {
    throw new Error("Host handoff plan is missing its exact fidelity commitment.");
  }
  return fidelity;
}

function committedHostValue(
  value: string | undefined,
): UpdateHostConvergenceCommitment["incumbent"]["buildVersion"] {
  return value === undefined ? { status: "absent" } : { status: "known", value };
}

function hostCommitmentMismatch() {
  return updateErrorFromUnknown(undefined, {
    code: "UPDATE_HOST_CONVERGENCE_COMMITMENT_MISMATCH",
    message: "Host convergence did not retain the exact authorized build and inventory.",
  });
}

async function inspectAndPlan(input: {
  evaluator: "incumbent-cli" | "successor-cli";
  current: UpdateArtifact;
  target: UpdateArtifact;
  selected: PlannedUpdateChannel;
  artifactAction: UpdateArtifactPlanAction;
  build: StationBuildInfo;
  request: UpdateConvergenceRequest;
  ports: UpdateConvergencePorts;
}): Promise<UpdateEvidencePlan> {
  const inspection = await runInspection(input.current, input.target, input.ports);
  const selectedTarget = {
    artifact: input.target,
    buildIdentity:
      input.artifactAction === "no-op"
        ? ({ status: "known", value: input.build.buildIdentity } as const)
        : ({ status: "not-yet-provable" } as const),
  };
  const draft = planUpdateConvergence({
    selectedTarget,
    artifactAction: input.artifactAction,
    ...(input.request.handoff === undefined ? {} : { handoffFidelity: input.request.handoff }),
    preflight: inspection.preflight,
  });
  const plan = attachUpdateConvergenceDigest({
    draft,
    preflight: inspection.preflight,
    privateEvidence: inspection.privateEvidence,
  });
  return { evaluator: input.evaluator, preflight: inspection.preflight, plan };
}

async function runInspection(
  current: UpdateArtifact,
  target: UpdateArtifact,
  ports: UpdateConvergencePorts,
): Promise<UpdateConvergencePreflightInspection> {
  const artifacts = { installed: current, target };
  return validateUpdateConvergenceInspection(
    await ports.convergenceInspection(artifacts),
    artifacts,
  );
}

async function attemptFinalInspection(input: {
  current: UpdateArtifact;
  target: UpdateArtifact;
  selected: PlannedUpdateChannel;
  build: StationBuildInfo;
  request: UpdateConvergenceRequest;
  ports: UpdateConvergencePorts;
}): Promise<UpdateFinalInspection> {
  try {
    return {
      status: "completed",
      evidence: await inspectAndPlan({
        evaluator: input.request.evaluator,
        current: input.current,
        target: input.target,
        selected: input.selected,
        artifactAction: "no-op",
        build: input.build,
        request: input.request,
        ports: input.ports,
      }),
    };
  } catch (error) {
    return {
      status: "failed",
      error: publicSafeErrorFromUnknown(error, {
        tag: "UpdatePreflightError",
        code: "UPDATE_FINAL_INSPECTION_FAILED",
        message: "Final aggregate inspection failed after a runtime action failure.",
      }),
    };
  }
}

function reportFinisher(publicReport: UpdatePublicReportPort) {
  return (input: PublicUpdateReportInput): UpdateCommandReport => publicReport.create(input);
}

function verificationFor(
  evidence: UpdateEvidencePlan,
  source: "successor" | "post-action",
): Extract<UpdateConvergenceResult, { kind: "current-runtime-execution" }>["verification"] {
  return evidence.plan.status === "converged"
    ? { status: "converged", source, planDigest: evidence.plan.digest.value }
    : {
        status: "not-converged",
        source,
        planDigest: evidence.plan.digest.value,
        disposition: evidence.plan.status === "deferred" ? "blocked" : evidence.plan.status,
      };
}

function auditsFrom(report: UpdateCommandReport): UpdateActionAudit[] {
  switch (report.result.kind) {
    case "current-runtime-execution":
    case "successor-runtime-execution":
    case "execution-failed":
      return [...report.result.actionAudits];
    case "already-converged":
    case "preview":
    case "deferred":
    case "non-mutating-stop":
      return [];
  }
}

function successorVerificationEvidence(report: UpdateCommandReport): {
  evidence: UpdateEvidencePlan;
  source: "successor" | "post-action";
} {
  switch (report.result.kind) {
    case "already-converged":
    case "non-mutating-stop":
      return { evidence: report.initial, source: "successor" };
    case "current-runtime-execution": {
      const verification = report.result.actionAudits[0].actions.at(-1);
      if (verification?.phase !== "verification" || verification.status !== "completed") {
        throw new Error(
          "Successor runtime execution did not complete its final aggregate inspection.",
        );
      }
      return { evidence: report.result.postAction, source: "post-action" };
    }
    case "preview":
    case "deferred":
    case "successor-runtime-execution":
    case "execution-failed":
      throw new Error("Successor transport returned a result without verification provenance.");
  }
}

function artifactActionFor(
  selected: PlannedUpdateChannel,
  request: UpdateConvergenceRequest,
): UpdateArtifactPlanAction {
  if (request.successorTarget !== undefined) return "no-op";
  if (selected.plan.status === "current") return "no-op";
  if (selected.plan.managerCommand !== undefined && request.packageManager === "defer") {
    return "defer";
  }
  return "apply";
}

function managerAwareArtifactApplication(
  status: "preview" | "deferred",
  selected: PlannedUpdateChannel,
): UpdateArtifactApplication {
  if (status === "preview") {
    const application: Extract<UpdateArtifactApplication, { status: "preview" }> = {
      status: "preview",
    };
    if (selected.plan.managerCommand !== undefined) {
      application.managerCommand = selected.plan.managerCommand;
    }
    return application;
  }
  const application: Extract<UpdateArtifactApplication, { status: "deferred" }> = {
    status: "deferred",
  };
  if (selected.plan.managerCommand !== undefined) {
    application.managerCommand = selected.plan.managerCommand;
  }
  return application;
}

function validateSuccessorTarget(
  request: UpdateConvergenceRequest,
  current: UpdateArtifact,
  build: StationBuildInfo,
): void {
  if (request.successorTarget === undefined) return;
  if (
    !artifactsMatch(current, request.successorTarget) ||
    build.version !== request.successorTarget.version
  ) {
    throw updateErrorFromUnknown(undefined, {
      code: "UPDATE_SUCCESSOR_TARGET_MISMATCH",
      message: "The successor launcher does not match the artifact selected before application.",
      hint: "Rerun stn update from the currently installed launcher to build a fresh plan.",
    });
  }
}

function artifactsMatch(left: UpdateArtifact, right: UpdateArtifact): boolean {
  return left.version === right.version && left.revision === right.revision;
}

function terminalsPreservedAcrossHostConvergence(
  initial: UpdateEvidencePlan,
  postAction: UpdateEvidencePlan,
  audit: UpdateActionAudit,
): boolean {
  const terminalInventoryCommitted = audit.actions.some(
    (action) =>
      action.phase === "terminal-convergence" &&
      action.action === "preserve-via-handoff" &&
      action.status !== "failed",
  );
  if (!terminalInventoryCommitted) return true;
  const before =
    initial.preflight.host.status === "inspected" ? initial.preflight.host.terminals : [];
  const after =
    postAction.preflight.host.status === "inspected" ? postAction.preflight.host.terminals : [];
  return ptyLifetimeIdentitySetsMatch(before, after);
}

function validatePackageManagerRequest(
  selected: PlannedUpdateChannel,
  request: UpdateConvergenceRequest,
): void {
  if (request.packageManager === "drive" && selected.plan.managerCommand === undefined) {
    throw updateErrorFromUnknown(undefined, {
      code: "UPDATE_FLAG_INVALID",
      message: "--drive-package-manager requires a Homebrew, npm-global, or mise channel.",
    });
  }
}

function artifact(version: string, revision: string | undefined): UpdateArtifact {
  return { version, ...(revision === undefined ? {} : { revision }) };
}

function recoveryCommands(
  selected: PlannedUpdateChannel,
  request: UpdateConvergenceRequest,
  ports: UpdateConvergencePorts,
) {
  return ports.runtime.recoveryCommands({
    cli: selected.plan.currentCli,
    channel: selected.channel,
    drivePackageManager: request.packageManager === "drive",
    ...(request.handoff === undefined ? {} : { handoff: request.handoff }),
  });
}
