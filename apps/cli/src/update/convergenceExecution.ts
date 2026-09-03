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
  type UpdateReapTerminalEvidence,
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
    target: UpdateArtifact;
    currentBuildArtifact: UpdateArtifact;
    currentBuildInfo: StationBuildInfo;
  }) => Promise<UpdateReapRecoveryPreflight>;
  inspectInstalled: () => Promise<UpdateArtifact | undefined>;
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
  installedScopeDigest: string;
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
  applyRecoveryCommands?: (
    error: unknown,
  ) => readonly (readonly [string, ...string[]])[] | undefined;
  runSuccessor?: (input: {
    launcher: ExecutableArgv;
    target: UpdateArtifact;
    channel: UpdateChannelId;
    installedScopeDigest: string;
    handoff: UpdateRequest["handoff"];
    hookProviderIds: readonly string[];
  }) => Promise<{
    status: "completed" | "failed";
    finalInspection: UpdateFinalInspection;
    hookReconciliations: ProviderHookReconciliationResult[];
    steps: UpdateCommandStep[];
    parkedTerminals?: readonly UpdateReapTerminalEvidence[];
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
 * identity revalidation, and final inspection redetects the installed artifact. This coordinator
 * only orders those capabilities and never authorizes reap or signal.
 */
export async function executeUpdateConvergence(
  input: UpdateConvergenceExecutionInput,
  deps: UpdateConvergenceExecutionDeps,
): Promise<UpdateConvergenceExecutionResult> {
  if (input.plan.outcome === "blocked" || input.plan.outcome === "reap-required") {
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
    if (applied.installedVersion !== input.target.version) {
      throw new Error("Artifact application did not install the selected target version.");
    }
    input.report.steps.push(
      updateStep("apply", "completed", `Installed Station ${applied.installedVersion}.`),
    );
  } catch (error) {
    const recoveryCommands = input.applyRecoveryCommands?.(error);
    if (recoveryCommands !== undefined) input.report.recoveryCommands.push(...recoveryCommands);
    input.report.error = publicSafeErrorFromUnknown(error, {
      tag: "UpdateError",
      code: "UPDATE_ARTIFACT_APPLICATION_FAILED",
      message: "Station could not apply the selected artifact.",
    });
    input.report.steps.push(updateStep("apply", "failed", input.report.error.message));
    return finalizeUpdateConvergence(input, deps, error, false);
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
    return finalizeUpdateConvergence(input, deps, error, false);
  }

  try {
    const successor = await input.runSuccessor({
      launcher: applied.successorCli,
      target: input.target,
      channel: input.selectedChannel,
      installedScopeDigest: input.installedScopeDigest,
      handoff: input.request.handoff,
      hookProviderIds: input.initial.hookProviderIds,
    });
    input.report.hookReconciliations.push(...successor.hookReconciliations);
    input.report.steps.push(...successor.steps);
    if (successor.recoveryCommands !== undefined) {
      input.report.recoveryCommands.push(...successor.recoveryCommands);
    }
    input.report.finalInspection = successor.finalInspection;
    if (successor.status === "failed" || successor.finalInspection.status !== "completed") {
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
    if (
      !requiredTerminalStateWasPreserved(
        input,
        successor.finalInspection,
        successor.parkedTerminals,
      )
    ) {
      input.report.error = {
        tag: "UpdateError",
        code: "UPDATE_TERMINAL_PRESERVATION_FAILED",
        message: "The successor did not retain the required Host terminal state.",
      };
      return { status: "failed", finalInspection: successor.finalInspection };
    }
    if (successor.finalInspection.plan.outcome === "intentionally-incomplete") {
      return { status: "intentionally-incomplete", finalInspection: successor.finalInspection };
    }
    if (successor.finalInspection.plan.outcome !== "converged") {
      return { status: "failed", finalInspection: successor.finalInspection };
    }
    return { status: "updated", finalInspection: successor.finalInspection };
  } catch (error) {
    input.report.error = publicSafeErrorFromUnknown(error, {
      tag: "UpdateError",
      code: "UPDATE_RUNTIME_CROSSOVER_FAILED",
      message: "Station installed the new build but target runtime convergence did not complete.",
    });
    return finalizeUpdateConvergence(input, deps, error, false);
  }
}

function requiredTerminalStateWasPreserved(
  input: UpdateConvergenceExecutionInput,
  final: Extract<UpdateFinalInspection, { status: "completed" }>,
  finalParkedTerminals: readonly UpdateReapTerminalEvidence[] | undefined,
): boolean {
  if (
    input.request.handoff === undefined &&
    input.plan.outcome === "intentionally-incomplete" &&
    final.plan.outcome !== "intentionally-incomplete"
  ) {
    return false;
  }
  const initialHost = input.initial.host;
  const initialTerminals =
    initialHost.status === "inspected" ? initialHost.terminals.filter(({ alive }) => alive) : [];
  const initialParkedTerminals = updateRecoveryActionCommitments(input.initial).parkedTerminals;
  const finalHost = final.aggregate.host;
  if (input.initial.parkedBridges.status === "assessed") {
    const adoptionRequiredCount = input.initial.parkedBridges.adoptionRequiredCount;
    if (adoptionRequiredCount > 0) {
      if (
        initialParkedTerminals === undefined ||
        initialParkedTerminals.length !== adoptionRequiredCount
      ) {
        return false;
      }
      if (input.plan.phases.hostConvergence.action === "leave-in-place") {
        const finalParked = final.aggregate.parkedBridges;
        if (
          finalParked.status !== "assessed" ||
          finalParked.totalParkedCount !== input.initial.parkedBridges.totalParkedCount ||
          finalParked.unownedParkedCount !== input.initial.parkedBridges.unownedParkedCount ||
          finalParked.adoptionRequiredCount !== adoptionRequiredCount ||
          finalParkedTerminals === undefined ||
          !terminalIdentityListsMatch(initialParkedTerminals, finalParkedTerminals)
        ) {
          return false;
        }
      } else if (
        finalHost.status !== "inspected" ||
        !initialParkedTerminals.every((parkedTerminal) =>
          finalHost.terminals.some(
            (terminal) => parkedTerminalMatches(parkedTerminal, terminal) && terminal.alive,
          ),
        )
      ) {
        return false;
      }
    }
  }
  if (initialHost.status !== "inspected") return true;
  if (input.request.handoff === undefined) {
    if (
      finalHost.status !== "inspected" ||
      finalHost.buildVersion !== initialHost.buildVersion ||
      finalHost.buildIdentity !== initialHost.buildIdentity ||
      finalHost.protocolVersion !== initialHost.protocolVersion
    ) {
      return false;
    }
  } else if (initialTerminals.length > 0 && finalHost.status !== "inspected") {
    return false;
  }
  if (finalHost.status !== "inspected") return true;
  return initialTerminals.every((initialTerminal) =>
    finalHost.terminals.some(
      (finalTerminal) =>
        terminalIdentityMatches(initialTerminal, finalTerminal) &&
        finalTerminal.kind === initialTerminal.kind &&
        finalTerminal.projectId === initialTerminal.projectId &&
        finalTerminal.worktreeId === initialTerminal.worktreeId &&
        finalTerminal.sessionId === initialTerminal.sessionId &&
        finalTerminal.harnessProvider === initialTerminal.harnessProvider &&
        finalTerminal.alive,
    ),
  );
}

function terminalIdentityMatches(
  left: { terminalTargetId: string; ptyId: string; ptyInstanceId: string },
  right: { terminalTargetId: string; ptyId: string; ptyInstanceId: string },
): boolean {
  return (
    left.terminalTargetId === right.terminalTargetId &&
    left.ptyId === right.ptyId &&
    left.ptyInstanceId === right.ptyInstanceId
  );
}

function terminalIdentityListsMatch(
  left: readonly UpdateReapTerminalEvidence[],
  right: readonly UpdateReapTerminalEvidence[],
): boolean {
  return (
    left.length === right.length &&
    left.every((terminal, index) => {
      const candidate = right[index];
      return candidate !== undefined && parkedTerminalMatches(terminal, candidate);
    })
  );
}

function parkedTerminalMatches(
  left: UpdateReapTerminalEvidence,
  right: UpdateReapTerminalEvidence,
): boolean {
  return (
    terminalIdentityMatches(left, right) &&
    left.kind === right.kind &&
    left.projectId === right.projectId &&
    left.worktreeId === right.worktreeId &&
    left.sessionId === right.sessionId &&
    left.harnessProvider === right.harnessProvider &&
    left.alive === right.alive &&
    left.handoffSupport === right.handoffSupport
  );
}

async function executeRuntime(
  input: UpdateConvergenceExecutionInput,
  deps: UpdateConvergenceExecutionDeps,
): Promise<UpdateConvergenceExecutionResult> {
  let failure: unknown;
  try {
    const installed = await deps.inspectInstalled();
    if (
      installed === undefined ||
      !artifactsMatch(installed, input.installed) ||
      !artifactsMatch(installed, input.target)
    ) {
      throw new Error("The selected installation changed before runtime convergence.");
    }
    await reconcileHooks(input, deps);
    const observer = await convergeObserver(input, deps);
    const hostPhase = input.plan.phases.hostConvergence;
    if (hostPhase.action === "leave-in-place") {
      input.report.steps.push(
        updateStep(
          "host-handoff",
          "skipped",
          "Host handoff was disabled; the incumbent Host was left in place.",
        ),
      );
    } else if (hostPhase.action !== "no-op") {
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
  const finalized = await finalizeUpdateConvergence(input, deps, failure, failure === undefined);
  if (
    (finalized.status === "current" || finalized.status === "intentionally-incomplete") &&
    finalized.finalInspection?.status === "completed" &&
    !requiredTerminalStateWasPreserved(
      input,
      finalized.finalInspection,
      updateRecoveryActionCommitments(finalized.finalInspection.aggregate).parkedTerminals,
    )
  ) {
    input.report.error = {
      tag: "UpdateError",
      code: "UPDATE_TERMINAL_PRESERVATION_FAILED",
      message: "Final verification did not retain the required Host terminal state.",
    };
    const finalStepIndex = input.report.steps.findLastIndex(
      ({ id }) => id === "final-verification",
    );
    if (finalStepIndex >= 0) {
      input.report.steps[finalStepIndex] = updateStep(
        "final-verification",
        "failed",
        input.report.error.message,
      );
    }
    return { status: "failed", finalInspection: finalized.finalInspection };
  }
  return finalized;
}

function artifactsMatch(left: UpdateArtifact, right: UpdateArtifact): boolean {
  return left.version === right.version && left.revision === right.revision;
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
