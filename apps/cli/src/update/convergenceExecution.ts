import type { StationConfig } from "@station/config";
import {
  type ObserverHealth,
  type ProviderHookReconciliationResult,
  ProviderHookReconciliationResultSchema,
  providerHookReconciliationSucceeded,
  type StationHostExactEvidence,
  type UpdateArtifact,
  type UpdateChannelId,
  type UpdateCommandStep,
  type UpdateConvergencePlan,
  type UpdateConvergencePlanningInput,
  type UpdateFinalInspection,
  type UpdateReapRecoveryPreflight,
} from "@station/contracts";
import type { ExactObserverOwnershipEvidence, ProviderRegistry } from "@station/observer/internal";
import {
  publicSafeErrorFromUnknown,
  type StationBuildInfo,
  stationObserverBuildVersion,
} from "@station/runtime";
import type { UpdateRequest } from "../commands/update/args.js";
import {
  finalizeUpdateConvergence,
  type UpdateCommandResultDraft,
  updateStep,
} from "../commands/update/report.js";
import type { ExactObserverBuildStatus } from "../observerProcess/types.js";
import { resolveObserverPaths } from "../paths.js";
import type { ExecutableArgv } from "../selfExec.js";
import {
  updateHookError,
  updateHookSuccessFromHealth,
  updateRecoveryActionCommitments,
} from "./recoveryPreflight.js";
import type { UpdateApplyReportBase } from "./updateChannel.js";

export type UpdateConvergenceExecutionDeps = {
  providers?: ProviderRegistry;
  inspect: (input: {
    installed: UpdateArtifact;
    target: UpdateArtifact;
    currentBuildInfo: StationBuildInfo;
  }) => Promise<UpdateReapRecoveryPreflight>;
  convergeObserver?: (input: {
    action: "start" | "restart" | "no-op";
    targetSelector: string;
    buildInfo: StationBuildInfo;
    config: StationConfig;
    configPath?: string;
    expected?: ExactObserverOwnershipEvidence;
  }) => Promise<ExactObserverBuildStatus>;
  reconcileHook?: (
    provider: string,
    providers: ProviderRegistry,
    configPath?: string,
  ) => Promise<ProviderHookReconciliationResult>;
  convergeHost?: (input: {
    phase: UpdateConvergencePlan["phases"]["hostConvergence"];
    config: StationConfig;
    buildInfo: StationBuildInfo;
    expected?: StationHostExactEvidence;
  }) => Promise<void>;
  reconcilePersisted?: (health: ObserverHealth, socketPath: string) => Promise<void>;
};

export type UpdateConvergenceExecutionInput = {
  selectedChannel: UpdateChannelId;
  installed: UpdateArtifact;
  target: UpdateArtifact;
  buildInfo: StationBuildInfo;
  config: StationConfig;
  configPath?: string;
  request: UpdateRequest;
  report: UpdateCommandResultDraft;
  initial: UpdateReapRecoveryPreflight;
  plan: UpdateConvergencePlan;
  planning: UpdateConvergencePlanningInput;
  artifactChanged: boolean;
  apply?: () => Promise<UpdateApplyReportBase>;
  runSuccessor?: (input: {
    launcher: ExecutableArgv;
    target: UpdateArtifact;
    channel: UpdateChannelId;
    handoff: UpdateRequest["handoff"];
    hookProviderIds: readonly string[];
  }) => Promise<{
    status: "completed" | "failed";
    finalInspection: UpdateFinalInspection;
    hookReconciliations: ProviderHookReconciliationResult[];
    steps: UpdateCommandStep[];
    recoveryCommands?: readonly (readonly [string, ...string[]])[];
    error?: unknown;
  }>;
};

export type UpdateConvergenceExecutionResult = {
  status:
    | "current"
    | "updated"
    | "deferred"
    | "failed"
    | "blocked"
    | "reap-required"
    | "intentionally-incomplete";
  finalInspection?: UpdateFinalInspection;
};

/**
 * USE CASE
 *
 * Executes one ordered safe convergence. Lifecycle capabilities perform their own immediate
 * identity revalidation; this coordinator only orders them and never authorizes reap or signal.
 */
export async function executeUpdateConvergence(
  input: UpdateConvergenceExecutionInput,
  deps: UpdateConvergenceExecutionDeps,
): Promise<UpdateConvergenceExecutionResult> {
  if (
    input.plan.outcome === "blocked" ||
    input.plan.outcome === "reap-required" ||
    input.plan.outcome === "intentionally-incomplete"
  ) {
    input.report.steps.push(
      updateStep("apply", "skipped", "No artifact or runtime action was authorized by the plan."),
    );
    return { status: input.plan.outcome };
  }
  if (input.plan.outcome === "deferred") {
    const phase = input.plan.phases.artifactApplication;
    if (phase.action !== "defer")
      throw new Error("Deferred update plan omitted its manager command.");
    input.report.steps.push(
      updateStep(
        "apply",
        "deferred",
        "The package manager owns mutation and no manager command was executed.",
        phase.command.argv,
      ),
    );
    return { status: "deferred" };
  }
  if (input.artifactChanged) return executeArtifactChange(input, deps);
  input.report.steps.push(
    updateStep("apply", "skipped", "The selected artifact already matches its target."),
  );
  return executeRuntime(input, deps);
}

async function executeArtifactChange(
  input: UpdateConvergenceExecutionInput,
  deps: UpdateConvergenceExecutionDeps,
): Promise<UpdateConvergenceExecutionResult> {
  let applied: UpdateApplyReportBase;
  let installedAfterApply = input.installed;
  try {
    if (input.apply === undefined)
      throw new Error("Artifact application capability is unavailable.");
    applied = await input.apply();
    input.report.warnings.push(...applied.warnings);
    if (applied.status === "deferred") {
      input.report.steps.push(
        updateStep(
          "apply",
          "deferred",
          "The package manager deferred the selected artifact application.",
        ),
      );
      return { status: "deferred" };
    }
    installedAfterApply = input.target;
    if (applied.installedVersion !== input.target.version) {
      throw new Error("Artifact application did not install the selected target version.");
    }
    input.report.steps.push(
      updateStep("apply", "completed", `Installed Station ${applied.installedVersion}.`),
    );
  } catch (error) {
    input.report.error = publicSafeErrorFromUnknown(error, {
      tag: "UpdateError",
      code: "UPDATE_ARTIFACT_APPLICATION_FAILED",
      message: "Station could not apply the selected artifact.",
    });
    input.report.steps.push(updateStep("apply", "failed", input.report.error.message));
    return finalizeUpdateConvergence(input, deps, error, false, installedAfterApply);
  }

  if (applied.successorCli === undefined || input.runSuccessor === undefined) {
    const error = new Error(
      "The update committed without identifying its successor Station launcher.",
    );
    input.report.error = publicSafeErrorFromUnknown(error, {
      tag: "UpdateError",
      code: "UPDATE_SUCCESSOR_UNAVAILABLE",
      message: "The artifact was applied without identifying its successor Station launcher.",
    });
    return finalizeUpdateConvergence(input, deps, error, false, installedAfterApply);
  }

  try {
    const successor = await input.runSuccessor({
      launcher: applied.successorCli,
      target: input.target,
      channel: input.selectedChannel,
      handoff: input.request.handoff,
      hookProviderIds: input.initial.hookProviderIds,
    });
    input.report.hookReconciliations.push(...successor.hookReconciliations);
    input.report.steps.push(...successor.steps);
    if (successor.recoveryCommands !== undefined) {
      input.report.recoveryCommands.push(...successor.recoveryCommands);
    }
    input.report.finalInspection = successor.finalInspection;
    if (
      successor.status === "failed" ||
      successor.finalInspection.status !== "completed" ||
      successor.finalInspection.plan.outcome !== "converged"
    ) {
      if (successor.error !== undefined) {
        input.report.error = publicSafeErrorFromUnknown(successor.error, {
          tag: "UpdateError",
          code: "UPDATE_RUNTIME_CROSSOVER_FAILED",
          message:
            "Station installed the new build but target runtime convergence did not complete.",
        });
      }
      return { status: "failed", finalInspection: successor.finalInspection };
    }
    return { status: "updated", finalInspection: successor.finalInspection };
  } catch (error) {
    input.report.error = publicSafeErrorFromUnknown(error, {
      tag: "UpdateError",
      code: "UPDATE_RUNTIME_CROSSOVER_FAILED",
      message: "Station installed the new build but target runtime convergence did not complete.",
    });
    return finalizeUpdateConvergence(input, deps, error, false, installedAfterApply);
  }
}

async function executeRuntime(
  input: UpdateConvergenceExecutionInput,
  deps: UpdateConvergenceExecutionDeps,
): Promise<UpdateConvergenceExecutionResult> {
  let failure: unknown;
  try {
    await reconcileHooks(input, deps);
    const observer = await convergeObserver(input, deps);
    const hostPhase = input.plan.phases.hostConvergence;
    if (hostPhase.action !== "no-op") {
      if (deps.convergeHost === undefined) {
        throw new Error("Host convergence capability is unavailable.");
      }
      const hostCommitment = updateRecoveryActionCommitments(input.initial).host;
      await deps.convergeHost({
        phase: hostPhase,
        config: input.config,
        buildInfo: input.buildInfo,
        ...(hostCommitment === undefined ? {} : { expected: hostCommitment }),
      });
      input.report.steps.push(
        updateStep("host-handoff", "completed", "The Host completed exact ownership convergence."),
      );
    }
    if (input.plan.phases.persistedStateReconcile.action === "run") {
      if (deps.reconcilePersisted === undefined) {
        throw new Error("Persisted-state reconcile capability is unavailable.");
      }
      await deps.reconcilePersisted(observer, resolveObserverPaths(input.config).socketPath);
      input.report.steps.push(
        updateStep(
          "persisted-state-reconcile",
          "completed",
          "Persisted state was reconciled through the exact Observer.",
        ),
      );
    }
  } catch (error) {
    failure = error;
    input.report.error = publicSafeErrorFromUnknown(error, {
      tag: "UpdateError",
      code: "UPDATE_RUNTIME_CONVERGENCE_FAILED",
      message: "Station could not complete safe runtime convergence.",
    });
  }
  return finalizeUpdateConvergence(input, deps, failure, failure === undefined, input.installed);
}

async function reconcileHooks(
  input: UpdateConvergenceExecutionInput,
  deps: UpdateConvergenceExecutionDeps,
): Promise<void> {
  for (const decision of input.plan.phases.hookReconciliation.providers) {
    const health = input.initial.hooks.find(({ provider }) => provider === decision.provider);
    if (decision.action === "blocked") throw updateHookError(health);
    if (decision.action === "no-op") {
      if (health !== undefined)
        input.report.hookReconciliations.push(updateHookSuccessFromHealth(health));
      continue;
    }
    if (deps.providers === undefined) throw new Error("Hook provider registry is unavailable.");
    if (deps.reconcileHook === undefined) {
      throw new Error("Hook reconciliation capability is unavailable.");
    }
    const result = ProviderHookReconciliationResultSchema.parse(
      await deps.reconcileHook(decision.provider, deps.providers, input.configPath),
    );
    if (result.provider !== decision.provider) {
      throw new Error("Hook reconciliation returned a different provider.");
    }
    input.report.hookReconciliations.push(result);
    if (!providerHookReconciliationSucceeded(result)) throw updateHookError(result);
  }
  input.report.steps.push(
    updateStep(
      "hook-reconciliation",
      "completed",
      "Configured provider hooks were reconciled in canonical order.",
    ),
  );
}

async function convergeObserver(
  input: UpdateConvergenceExecutionInput,
  deps: UpdateConvergenceExecutionDeps,
): Promise<ObserverHealth> {
  const action = input.plan.phases.observerConvergence.action;
  if (action === "blocked" || action === "reinspect") {
    throw new Error("Observer target evidence is not actionable.");
  }
  if (deps.convergeObserver === undefined) {
    throw new Error("Observer convergence capability is unavailable.");
  }
  const status = await deps.convergeObserver({
    action,
    targetSelector: stationObserverBuildVersion(input.buildInfo),
    buildInfo: input.buildInfo,
    config: input.config,
    ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
    ...(action === "restart" &&
    updateRecoveryActionCommitments(input.initial).observer !== undefined
      ? { expected: updateRecoveryActionCommitments(input.initial).observer }
      : {}),
  });
  if (status.status !== "running") throw status.error;
  input.report.steps.push(
    updateStep("observer-restart", "completed", "The exact target Observer is running."),
  );
  return status.health;
}
