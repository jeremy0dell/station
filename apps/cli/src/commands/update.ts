import type { StationConfig } from "@station/config";
import {
  type HostHandoffCommandResult,
  HostHandoffCommandResultSchema,
  type ObserverLifecycleFailure,
  ObserverLifecycleFailureSchema,
  ObserverRestartCommandResultSchema,
  type ObserverStartupEvidence,
  type ProviderHookReconciliationResult,
  ProviderHookReconciliationResultSchema,
  providerHookReconciliationSucceeded,
  ptyLifetimeIdentitySetsMatch,
  type SafeError,
  type UpdateActionAudit,
  type UpdateArtifact,
  type UpdateArtifactApplication,
  type UpdateCommandReport,
  UpdateCommandReportSchema,
  type UpdateConvergenceResult,
  type UpdateEvidencePlan,
  type UpdateExecutedAction,
  type UpdateFinalInspection,
  updateCommandReportStatus,
} from "@station/contracts";
import { redact } from "@station/observability";
import {
  type ExternalCommandRunner,
  publicSafeErrorFromUnknown,
  runExternalCommand,
  type StationBuildInfo,
  stationBuildInfo,
} from "@station/runtime";
import type { CliRunResult } from "../cliTypes.js";
import type { CliEnv } from "../env.js";
import type { ExecutableArgv } from "../selfExec.js";
import {
  type PlannedUpdateChannel,
  selectInstalledUpdateChannel,
  selectUpdateChannel,
  type UpdateChannelProbe,
} from "../update/channelDetection.js";
import { attachUpdateConvergenceDigest } from "../update/convergenceDigest.js";
import { planUpdateConvergence, type UpdateArtifactPlanAction } from "../update/convergencePlan.js";
import { createDefaultUpdateProbes } from "../update/defaultUpdateProbes.js";
import {
  sanitizePublicHookResult,
  sanitizePublicObserverLifecycleFailure,
  sanitizePublicUpdateReport,
} from "../update/publicUpdateReport.js";
import {
  type UpdateConvergenceInspectionPort,
  type UpdateConvergencePreflightInspection,
  validateUpdateConvergenceInspection,
} from "../update/recoveryPreflight.js";
import type { UpdateCommandArgv } from "../update/updateChannel.js";
import { updateErrorFromUnknown } from "../update/updateError.js";
import type { HostCommandDeps } from "./host/index.js";
import { parseUpdateRequest, type UpdateRequest } from "./update/args.js";
import { nonExecutedPhases, updateCommandExitCode, updateCommandResult } from "./update/report.js";

export type UpdateCommandOptions = {
  config: StationConfig;
  configPath?: string;
  cliEntryPath: string;
  env?: CliEnv;
};

export type UpdateCommandDeps = {
  /** Returns one strict public/private aggregate for the exact selected artifacts. */
  convergenceInspection: UpdateConvergenceInspectionPort;
  probes?: readonly UpdateChannelProbe[];
  buildInfo?: () => StationBuildInfo;
  executablePath?: string;
  commandRunner?: ExternalCommandRunner;
  hostDeps?: HostCommandDeps;
};

const OBSERVER_CROSSOVER_TIMEOUT_MS = 20_000;

type InFlightUpdateAction = Pick<UpdateExecutedAction, "phase" | "action" | "provider">;

/**
 * USE CASE
 *
 * Resolves the install owner, inspects all live state, plans convergence, executes only safe typed
 * actions, and verifies a fresh no-op plan. Artifact application remains channel-owned; destructive
 * Station process-group authorization, journaling, and reaping remain exclusively owned by #641.
 */
export async function runUpdateCommand(
  args: readonly string[],
  options: UpdateCommandOptions,
  deps: UpdateCommandDeps,
): Promise<CliRunResult> {
  const request = parseUpdateRequest(args);
  const probes = deps.probes ?? createDefaultUpdateProbes(options, deps);
  const selected =
    request.successorTarget === undefined
      ? await selectUpdateChannel({
          probes,
          ...(request.channel === undefined ? {} : { requested: request.channel }),
        })
      : await selectInstalledUpdateChannel({
          probes,
          target: request.successorTarget,
          ...(request.channel === undefined ? {} : { requested: request.channel }),
        });
  validatePackageManagerRequest(selected, request);

  const current = artifact(selected.plan.currentVersion, selected.plan.currentRevision);
  const detectedTarget = artifact(selected.plan.targetVersion, selected.plan.targetRevision);
  const target = request.successorTarget ?? detectedTarget;
  const build = (deps.buildInfo ?? stationBuildInfo)();
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
    deps,
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
      output: request.output,
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
      output: request.output,
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
      output: request.output,
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
      output: request.output,
    });
  }

  return artifactAction === "apply"
    ? applyThenConverge(selected, current, target, initial, request, options, deps)
    : executeCurrentRuntime(selected, current, target, initial, request, options, deps);
}

async function applyThenConverge(
  selected: PlannedUpdateChannel,
  current: UpdateArtifact,
  target: UpdateArtifact,
  initial: UpdateEvidencePlan,
  request: UpdateRequest,
  options: UpdateCommandOptions,
  deps: UpdateCommandDeps,
): Promise<CliRunResult> {
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
      recoveryCommands: retryCommands(selected, options, request),
      output: request.output,
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
      output: request.output,
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
      recoveryCommands: retryCommands(selected, options, request),
      output: request.output,
    });
  }

  try {
    const successorReport = await runSuccessorUpdate(
      applied.successorCli,
      selected,
      target,
      request,
      options,
      deps.commandRunner,
    );
    const successorAudits = auditsFrom(successorReport);
    const postAction = newestEvidence(successorReport);
    const verification = verificationFor(postAction, "post-action");
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
        output: request.output,
      });
    }
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
        postAction,
        verification,
      },
      warnings: [...applied.warnings, ...successorReport.warnings],
      recoveryCommands: successorReport.recoveryCommands,
      output: request.output,
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
      recoveryCommands: retryCommands(selected, options, request),
      output: request.output,
    });
  }
}

async function executeCurrentRuntime(
  selected: PlannedUpdateChannel,
  current: UpdateArtifact,
  target: UpdateArtifact,
  initial: UpdateEvidencePlan,
  request: UpdateRequest,
  options: UpdateCommandOptions,
  deps: UpdateCommandDeps,
): Promise<CliRunResult> {
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
      const result = await runHookReconciliation(
        stationCommand(selected.plan.currentCli, options.configPath, [
          "hooks",
          "reconcile",
          hook.provider,
        ]),
        deps.commandRunner,
      );
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
      observerLifecycleFailure = await runObserverMutation(
        stationCommand(selected.plan.currentCli, options.configPath, [
          "observer",
          observer.action,
          "--timeout-ms",
          String(OBSERVER_CROSSOVER_TIMEOUT_MS),
        ]),
        deps.commandRunner,
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
      inFlightAction = {
        phase: "host-convergence",
        action: host.action,
      };
      const handoffResult = await runHostMutation(
        stationCommand(selected.plan.currentCli, options.configPath, [
          "host",
          "handoff",
          "--fidelity",
          request.handoff ?? "processes",
          "--json",
        ]),
        deps.commandRunner,
      );
      if (host.action === "handoff") {
        inFlightAction = {
          phase: "terminal-convergence",
          action: "preserve-via-handoff",
        };
        const expectedTerminals =
          initial.preflight.host.status === "inspected" ? initial.preflight.host.terminals : [];
        if (
          handoffResult.receipt === undefined ||
          !ptyLifetimeIdentitySetsMatch(expectedTerminals, handoffResult.receipt.terminals)
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
          handoffReceipt: handoffResult.receipt,
        });
      } else if (handoffResult.receipt !== undefined) {
        throw updateErrorFromUnknown(undefined, {
          code: "UPDATE_HOST_REPLACEMENT_RECEIPT_UNEXPECTED",
          message: "Idle Host replacement returned an unexpected live-terminal receipt.",
        });
      }
      actions.push({
        phase: "host-convergence",
        action: host.action,
        status: "completed",
      });
      inFlightAction = undefined;
    }
    if (initial.plan.components.reconcile.action === "run") {
      inFlightAction = {
        phase: "runtime-reconcile",
        action: "run",
      };
      await runMutationCommand(
        stationCommand(selected.plan.currentCli, options.configPath, [
          "reconcile",
          "--reason",
          "update-convergence",
        ]),
        deps.commandRunner,
      );
      actions.push({ phase: "runtime-reconcile", action: "run", status: "completed" });
      inFlightAction = undefined;
    }
  } catch (error) {
    let failedAction = actions.at(-1);
    if (failedAction?.status !== "failed") {
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
      build: (deps.buildInfo ?? stationBuildInfo)(),
      request,
      deps,
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
      recoveryCommands: retryCommands(selected, options, request),
      output: request.output,
    });
  }

  const finalInspection = await attemptFinalInspection({
    current,
    target,
    selected,
    build: (deps.buildInfo ?? stationBuildInfo)(),
    request,
    deps,
  });
  if (finalInspection.status !== "completed") {
    const error =
      finalInspection.status === "failed"
        ? finalInspection.error
        : updateErrorFromUnknown(undefined, {
            code: "UPDATE_FINAL_INSPECTION_FAILED",
            message: "Final aggregate inspection was not attempted after runtime convergence.",
          });
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
      recoveryCommands: retryCommands(selected, options, request),
      output: request.output,
    });
  }
  const postAction = finalInspection.evidence;
  if (!terminalsPreservedAcrossHandoff(initial, postAction, audit)) {
    const error = updateErrorFromUnknown(undefined, {
      code: "UPDATE_TERMINAL_CONVERGENCE_INCOMPLETE",
      message:
        "Fresh inspection after Host handoff did not retain every planned PTY lifetime identity.",
    });
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
      recoveryCommands: retryCommands(selected, options, request),
      output: request.output,
    });
  }
  if (postAction.plan.status === "actionable") {
    const error = updateErrorFromUnknown(undefined, {
      code: "UPDATE_RUNTIME_CONVERGENCE_INCOMPLETE",
      message:
        "Station completed the planned runtime actions, but fresh inspection still requires convergence.",
    });
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
      recoveryCommands: retryCommands(selected, options, request),
      output: request.output,
    });
  }
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
    output: request.output,
  });
}

async function inspectAndPlan(input: {
  evaluator: "incumbent-cli" | "successor-cli";
  current: UpdateArtifact;
  target: UpdateArtifact;
  selected: PlannedUpdateChannel;
  artifactAction: UpdateArtifactPlanAction;
  build: StationBuildInfo;
  request: UpdateRequest;
  deps: UpdateCommandDeps;
}): Promise<UpdateEvidencePlan> {
  const inspection = await runInspection(input.current, input.target, input.deps);
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
  deps: UpdateCommandDeps,
): Promise<UpdateConvergencePreflightInspection> {
  const artifacts = { installed: current, target };
  return validateUpdateConvergenceInspection(
    await deps.convergenceInspection(artifacts),
    artifacts,
  );
}

async function attemptFinalInspection(input: {
  current: UpdateArtifact;
  target: UpdateArtifact;
  selected: PlannedUpdateChannel;
  build: StationBuildInfo;
  request: UpdateRequest;
  deps: UpdateCommandDeps;
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
        deps: input.deps,
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

async function runSuccessorUpdate(
  launcher: ExecutableArgv,
  selected: PlannedUpdateChannel,
  target: UpdateArtifact,
  request: UpdateRequest,
  options: UpdateCommandOptions,
  runner: ExternalCommandRunner | undefined,
): Promise<UpdateCommandReport> {
  const command = stationCommand(launcher, options.configPath, [
    "update",
    "--channel",
    selected.channel,
    "--json",
    "--internal-successor-evaluator",
    "--internal-selected-target-version",
    target.version,
    ...(target.revision === undefined
      ? []
      : ["--internal-selected-target-revision", target.revision]),
    ...(request.handoff === undefined
      ? ["--no-handoff"]
      : request.handoff === "processes"
        ? []
        : [`--handoff=${request.handoff}`]),
  ]);
  const [executable, ...args] = command;
  const result = await runExternalCommand(
    {
      command: executable,
      args,
      timeoutMs: 120_000,
      maxOutputChars: 512 * 1024,
      allowedExitCodes: [1],
    },
    runner,
  );
  const report = sanitizePublicUpdateReport(
    UpdateCommandReportSchema.parse(JSON.parse(result.stdout)),
  );
  if (result.exitCode !== updateCommandExitCode(report)) {
    throw new Error("Successor update report contradicted its process exit status.");
  }
  return report;
}

async function runHookReconciliation(
  command: UpdateCommandArgv,
  runner: ExternalCommandRunner | undefined,
): Promise<ProviderHookReconciliationResult> {
  const [executable, ...args] = command;
  const result = await runExternalCommand(
    {
      command: executable,
      args,
      timeoutMs: 60_000,
      maxOutputChars: 64 * 1024,
      allowedExitCodes: [1],
    },
    runner,
  );
  const parsed = sanitizePublicHookResult(
    ProviderHookReconciliationResultSchema.parse(JSON.parse(result.stdout)),
  );
  if ((result.exitCode === 0) !== providerHookReconciliationSucceeded(parsed)) {
    throw new Error("Hook reconciliation contradicted its process exit status.");
  }
  return parsed;
}

async function runMutationCommand(
  command: UpdateCommandArgv,
  runner: ExternalCommandRunner | undefined,
): Promise<void> {
  const [executable, ...args] = command;
  await runExternalCommand(
    { command: executable, args, timeoutMs: 60_000, maxOutputChars: 128 * 1024 },
    runner,
  );
}

async function runHostMutation(
  command: UpdateCommandArgv,
  runner: ExternalCommandRunner | undefined,
): Promise<HostHandoffCommandResult> {
  const [executable, ...args] = command;
  const result = await runExternalCommand(
    {
      command: executable,
      args,
      timeoutMs: 60_000,
      maxOutputChars: 128 * 1024,
      allowedExitCodes: [1],
    },
    runner,
  );
  const parsed = HostHandoffCommandResultSchema.parse(JSON.parse(result.stdout));
  const succeeded = parsed.status === "planned" || parsed.status === "completed";
  if ((result.exitCode === 0) !== succeeded) {
    throw new Error("Host handoff result contradicted its process exit status.");
  }
  if (parsed.status !== "completed" || parsed.dryRun) {
    throw new Error("Host handoff did not complete the requested mutation.");
  }
  return parsed;
}

async function runObserverMutation(
  command: UpdateCommandArgv,
  runner: ExternalCommandRunner | undefined,
): Promise<ObserverLifecycleFailure | undefined> {
  const [executable, ...args] = command;
  const result = await runExternalCommand(
    {
      command: executable,
      args,
      timeoutMs: 60_000,
      maxOutputChars: 128 * 1024,
      allowedExitCodes: [1],
    },
    runner,
  );
  const parsed = ObserverRestartCommandResultSchema.parse(JSON.parse(result.stdout));
  if (result.exitCode === 0 && parsed.status === "running") return undefined;
  if (result.exitCode !== 0 && parsed.status !== "running") {
    const failure: ObserverLifecycleFailure = { error: parsed.error };
    if (parsed.cause !== undefined) failure.cause = parsed.cause;
    if (parsed.startupEvidence !== undefined) failure.startupEvidence = parsed.startupEvidence;
    return sanitizePublicObserverLifecycleFailure(ObserverLifecycleFailureSchema.parse(failure));
  }
  throw new Error("Observer convergence result contradicted its process exit status.");
}

function finishReport(input: {
  selected: PlannedUpdateChannel;
  current: UpdateArtifact;
  target: UpdateArtifact;
  artifactApplication: UpdateArtifactApplication;
  initial: UpdateEvidencePlan;
  result: UpdateConvergenceResult;
  output: UpdateRequest["output"];
  warnings?: SafeError[];
  recoveryCommands?: UpdateCommandArgv[];
  error?: SafeError;
  cause?: SafeError;
  startupEvidence?: ObserverStartupEvidence;
}): CliRunResult {
  const core = {
    schemaVersion: 4 as const,
    channel: input.selected.channel,
    current: input.current,
    target: input.target,
    artifactApplication: input.artifactApplication,
    initial: input.initial,
    result: input.result,
    warnings: input.warnings ?? [],
    recoveryCommands: input.recoveryCommands ?? [],
  };
  const report: UpdateCommandReport = {
    ...core,
    warnings: core.warnings.map((warning) =>
      publicSafeErrorFromUnknown(warning, {
        tag: warning.tag,
        code: warning.code,
        message: warning.message,
      }),
    ),
    status: updateCommandReportStatus(core),
  };
  if (input.error !== undefined) {
    report.error = publicSafeErrorFromUnknown(input.error, {
      tag: input.error.tag,
      code: input.error.code,
      message: input.error.message,
    });
  }
  if (input.cause !== undefined) {
    const cause = publicSafeErrorFromUnknown(input.cause, {
      tag: input.cause.tag,
      code: input.cause.code,
      message: input.cause.message,
    });
    report.cause = redact(cause).value;
  }
  if (input.startupEvidence !== undefined) {
    report.startupEvidence = redact(input.startupEvidence).value;
  }
  return updateCommandResult(sanitizePublicUpdateReport(report), input.output);
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

function newestEvidence(report: UpdateCommandReport): UpdateEvidencePlan {
  switch (report.result.kind) {
    case "current-runtime-execution":
      return report.result.postAction;
    case "successor-runtime-execution":
      return report.result.postAction;
    case "execution-failed":
      return report.result.finalInspection.status === "completed"
        ? report.result.finalInspection.evidence
        : (report.result.successor ?? report.initial);
    case "already-converged":
    case "preview":
    case "deferred":
    case "non-mutating-stop":
      return report.initial;
  }
}

function artifactActionFor(
  selected: PlannedUpdateChannel,
  request: UpdateRequest,
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
  request: UpdateRequest,
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

function terminalsPreservedAcrossHandoff(
  initial: UpdateEvidencePlan,
  postAction: UpdateEvidencePlan,
  audit: UpdateActionAudit,
): boolean {
  const handoffCompleted = audit.actions.some(
    (action) =>
      action.phase === "terminal-convergence" &&
      action.action === "preserve-via-handoff" &&
      action.status === "completed",
  );
  if (!handoffCompleted) return true;
  const before =
    initial.preflight.host.status === "inspected" ? initial.preflight.host.terminals : [];
  const after =
    postAction.preflight.host.status === "inspected" ? postAction.preflight.host.terminals : [];
  return ptyLifetimeIdentitySetsMatch(before, after);
}

function validatePackageManagerRequest(
  selected: PlannedUpdateChannel,
  request: UpdateRequest,
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

function stationCommand(
  cli: ExecutableArgv,
  configPath: string | undefined,
  operation: string[],
): UpdateCommandArgv {
  const [command, ...prefix] = cli;
  return [
    command,
    ...prefix,
    ...(configPath === undefined ? [] : ["--config", configPath]),
    ...operation,
  ];
}

function retryCommands(
  selected: PlannedUpdateChannel,
  options: UpdateCommandOptions,
  request: UpdateRequest,
): UpdateCommandArgv[] {
  return [
    stationCommand(selected.plan.currentCli, options.configPath, [
      "update",
      "--channel",
      selected.channel,
      ...(request.packageManager === "drive" ? ["--drive-package-manager"] : []),
      ...(request.handoff === undefined
        ? ["--no-handoff"]
        : request.handoff === "processes"
          ? []
          : [`--handoff=${request.handoff}`]),
    ]),
  ];
}
