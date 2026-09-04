import type { StationConfig } from "@station/config";
import {
  type ProviderHookReconciliationResult,
  providerHookReconciliationSucceeded,
  type SafeError,
  type UpdateArtifact,
  type UpdateCommandStep,
  UpdateConvergencePlanningInputSchema,
  type UpdateFinalInspection,
  type UpdateReapJournal,
  type UpdateReapRecoveryPreflight,
  type UpdateReapRecoveryResult,
  type UpdateSuccessorRequest,
  UpdateSuccessorRequestSchema,
} from "@station/contracts";
import type { ProviderRegistry } from "@station/observer/internal";
import {
  type ExternalCommandRunner,
  publicSafeErrorFromUnknown,
  type StationBuildInfo,
  stationBuildInfo,
  stationObserverBuildVersion,
} from "@station/runtime";
import type { CliRunResult } from "../cliTypes.js";
import type { CliEnv } from "../env.js";
import type { ExecutableArgv } from "../selfExec.js";
import {
  inspectSelectedUpdateChannel,
  type PlannedUpdateChannel,
  selectUpdateChannel,
  type UpdateChannelProbe,
} from "../update/channelDetection.js";
import {
  executeUpdateConvergence,
  type UpdateConvergenceExecutionDeps,
  type UpdateConvergenceExecutionResult,
  type UpdateReapRuntimeContext,
} from "../update/convergenceExecution.js";
import { deriveUpdateConvergencePlan } from "../update/convergencePlan.js";
import {
  executeUpdateReap,
  markUpdateReapPhase,
  refusedRecoveryFromUpdateReapPreflight,
  refusedRecoveryFromUpdateReapTargets,
  UpdateReapAuthorizationRefusedError,
} from "../update/reapExecution.js";
import { type UpdateReapJournalPort, updateReapJournalHasReached } from "../update/reapJournal.js";
import type { UpdateReapAuthorization } from "../update/reapPlan.js";
import {
  UpdateReapAuthorizationEvidenceError,
  updateReapIncumbentHostIsEmpty,
} from "../update/reapPlan.js";
import type { UpdateReapProcessGroupPort } from "../update/reapProcessGroups.js";
import type { UpdateReapSessionResumePort } from "../update/reapSessionResume.js";
import { updateRecoveryActionCommitments } from "../update/recoveryPreflight.js";
import { createUpdateRuntimeCapabilities } from "../update/recoveryPreflightAdapters.js";
import {
  type UpdateSuccessorReceipt,
  UpdateSuccessorReceiptSchema,
  updateSuccessorEvidenceFitsOutput,
  updateSuccessorReceiptFitsOutput,
} from "../update/successorExecution.js";
import { resolveUpdateInstallationIntent } from "../update/updateInstallationIntent.js";
import type { HostCommandDeps } from "./host/index.js";
import { parseUpdateRequest, type UpdateRequest } from "./update/args.js";
import {
  createUpdateReport,
  createUpdateReportForArtifacts,
  previewUpdateCommandResult,
  resultUpdateCommandResult,
  type UpdateCommandResultDraft,
  updateStep,
} from "./update/report.js";

export type UpdateCommandOptions = {
  config: StationConfig;
  configPath?: string;
  cliEntryPath: string;
  env?: CliEnv;
  signal?: AbortSignal;
};

export type UpdateSuccessorRunner = (input: {
  launcher: ExecutableArgv;
  target: UpdateArtifact;
  channel: PlannedUpdateChannel["channel"];
  installedScopeDigest: string;
  handoff: UpdateRequest["handoff"];
  hookProviderIds: readonly string[];
  reapContinuation?: { journalId: string };
  reapLockTransferToken?: string;
}) => Promise<{
  status: "completed" | "failed";
  finalInspection: import("@station/contracts").UpdateFinalInspection;
  hookReconciliations: ProviderHookReconciliationResult[];
  steps: import("@station/contracts").UpdateCommandStep[];
  recoveryCommands?: readonly UpdateCommandArgv[];
  parkedTerminals?: UpdateSuccessorReceipt["parkedTerminals"];
  error?: unknown;
  reapRecovery?: UpdateReapRecoveryResult;
}>;

type UpdateCommandArgv = readonly [string, ...string[]];

export type UpdateCommandDeps = {
  probes?: readonly UpdateChannelProbe[];
  buildInfo?: () => StationBuildInfo;
  currentBuildInfo?: StationBuildInfo;
  executablePath?: string;
  commandRunner?: ExternalCommandRunner;
  hostDeps?: HostCommandDeps;
  providers?: ProviderRegistry;
  convergeObserver?: UpdateConvergenceExecutionDeps["convergeObserver"];
  reconcileHook?: UpdateConvergenceExecutionDeps["reconcileHook"];
  convergeHost?: UpdateConvergenceExecutionDeps["convergeHost"];
  reconcilePersisted?: UpdateConvergenceExecutionDeps["reconcilePersisted"];
  runSuccessor?: UpdateSuccessorRunner;
  reapJournal?: UpdateReapJournalPort;
  reapProcessGroups?: UpdateReapProcessGroupPort;
  reapSessionResume?: UpdateReapSessionResumePort;
  deriveReapAuthorization?: (input: {
    channel: PlannedUpdateChannel["channel"];
    selectedArtifact: UpdateArtifact;
    installedScopeDigest: string;
    preflight: UpdateReapRecoveryPreflight;
    plan: import("@station/contracts").UpdateConvergencePlan;
    signal?: AbortSignal;
  }) => Promise<UpdateReapAuthorization>;
  /** Runs the composed read-only assessment required by every update invocation. */
  recoveryPreflight?: (input: {
    installed: UpdateArtifact;
    target: UpdateArtifact;
    currentBuildArtifact: UpdateArtifact;
    currentBuildInfo: StationBuildInfo;
  }) => Promise<UpdateReapRecoveryPreflight>;
};

/**
 * ADAPTER
 *
 * Selects one install owner, captures one read-only aggregate, and delegates all mutating work
 * to the ordered capability executor. The public report is projected only at this boundary.
 */
export async function runUpdateCommand(
  args: readonly string[],
  options: UpdateCommandOptions,
  deps: UpdateCommandDeps = {},
): Promise<CliRunResult> {
  const request = parseUpdateRequest(args);
  const currentBuildInfo = deps.currentBuildInfo ?? (deps.buildInfo ?? stationBuildInfo)();
  if (deps.probes === undefined) {
    throw new Error("Update channel probes are unavailable in this CLI composition.");
  }
  const selected = await selectUpdateChannel({
    probes: deps.probes,
    ...(request.channel === undefined ? {} : { requested: request.channel }),
    ...(options.signal === undefined ? {} : { options: { signal: options.signal } }),
  });
  return runSelectedUpdate(selected, request, options, {
    ...deps,
    currentBuildInfo,
  });
}

/**
 * Runs the validated hidden successor request without re-entering the public update command. Its
 * optional journal ID continues an authorized transaction but contains no process authority.
 */
export async function runUpdateSuccessorCommand(input: {
  stdin?: string;
  options: UpdateCommandOptions;
  deps: UpdateCommandDeps;
  reapLockTransferToken?: string;
}): Promise<CliRunResult> {
  const request = parseSuccessorInput(input.stdin);
  const run = async (): Promise<CliRunResult> => {
    try {
      const buildInfo = input.deps.currentBuildInfo ?? (input.deps.buildInfo ?? stationBuildInfo)();
      if (input.deps.probes === undefined) {
        throw new Error("Update channel probes are unavailable in this CLI composition.");
      }
      const selected = await inspectSelectedUpdateChannel({
        probes: input.deps.probes,
        requested: request.channel,
        installedScopeDigest: request.installedScopeDigest,
        ...(input.options.signal === undefined
          ? {}
          : { options: { signal: input.options.signal } }),
      });
      const target = request.target;
      if (!artifactsMatch(selected.installed, target)) {
        throw new Error("The successor launcher does not own the requested target artifact.");
      }
      if (buildInfo.version !== target.version) {
        throw new Error(
          "The successor launcher build does not match the requested target artifact.",
        );
      }
      if (input.deps.recoveryPreflight === undefined) {
        throw new Error("Update recovery preflight is unavailable in this CLI composition.");
      }
      const initial = await input.deps.recoveryPreflight({
        installed: target,
        target,
        currentBuildArtifact: target,
        currentBuildInfo: buildInfo,
      });
      if (!artifactsMatch(initial.installed, target) || !artifactsMatch(initial.target, target)) {
        throw new Error("Successor preflight did not confirm the requested target artifact.");
      }
      if (!sameProviders(initial.hookProviderIds, request.hookProviderIds)) {
        throw new Error("Successor hook providers changed across the launcher boundary.");
      }
      const planning = UpdateConvergencePlanningInputSchema.parse({
        preflight: initial,
        targetRuntime: {
          status: "known",
          buildIdentity: buildInfo.buildIdentity,
          observerSelector: stationObserverBuildVersion(buildInfo),
        },
        installation: {
          whenRequired: "apply",
          owner: request.channel,
          command: { kind: "none" },
        },
        handoff: handoffRequest(request),
      });
      const plan = deriveUpdateConvergencePlan(planning);
      const report = createUpdateReportForArtifacts(request.channel, target, target, initial, plan);
      const reap =
        request.reapContinuation === undefined
          ? undefined
          : await successorReapContext(request, input.deps);
      const execution = await executeUpdateConvergence(
        {
          selectedChannel: request.channel,
          installedScopeDigest: request.installedScopeDigest,
          installed: target,
          target,
          buildInfo,
          config: input.options.config,
          ...(input.options.configPath === undefined
            ? {}
            : { configPath: input.options.configPath }),
          request: successorRequestToUpdateRequest(request),
          report,
          initial,
          plan,
          planning,
          artifactChanged: false,
          ...(reap === undefined ? {} : { reap }),
        },
        executionDeps(input.deps, input.options, selected),
      );
      return successorResult(
        request,
        report,
        execution.status === "current" || execution.status === "intentionally-incomplete",
      );
    } catch (error) {
      return successorFailure(request, error);
    }
  };
  if (request.reapContinuation === undefined) return run();
  if (input.deps.reapJournal === undefined) {
    return successorFailure(request, new Error("Update reap journal capability is unavailable."));
  }
  if (input.reapLockTransferToken === undefined) {
    return successorFailure(request, new Error("Update reap lock transfer is unavailable."));
  }
  try {
    return await input.deps.reapJournal.takeOverLock(input.reapLockTransferToken, run);
  } catch (error) {
    return successorFailure(request, error);
  }
}

/** Runs the selected channel through aggregate planning and the one executor. */
export async function runSelectedUpdate(
  selected: PlannedUpdateChannel,
  request: UpdateRequest,
  options: UpdateCommandOptions,
  deps: UpdateCommandDeps & { currentBuildInfo: StationBuildInfo },
): Promise<CliRunResult> {
  const installation = resolveUpdateInstallationIntent(selected, request.packageManager);
  const current = artifact(selected.plan.currentVersion, selected.plan.currentRevision);
  const target = artifact(selected.plan.targetVersion, selected.plan.targetRevision);
  const initial = await inspectInitial(selected, current, target, deps);
  const planning = createPlanningInput(
    initial,
    current,
    target,
    installation,
    request,
    deps.currentBuildInfo,
  );
  const plan = deriveUpdateConvergencePlan(planning);

  if (request.mode === "preview") {
    return previewUpdateCommandResult(
      {
        schemaVersion: 6,
        kind: "preview",
        channel: selected.channel,
        current,
        target,
        initial,
        plan,
      },
      request.output,
    );
  }

  const report = createUpdateReport(selected, initial, plan);
  const incompleteJournal = await deps.reapJournal?.findIncomplete();
  if (incompleteJournal !== undefined && !request.reap) {
    report.error = {
      tag: "UpdateError",
      code: "UPDATE_REAP_CONTINUATION_REQUIRED",
      message: "An incomplete terminal-reap transaction must be continued explicitly.",
      hint: "Run `stn update --reap` to continue the exact private journal.",
    };
    report.recoveryCommands.push(["stn", "update", "--reap"]);
    report.steps.push(updateStep("recovery-preparation", "failed", report.error.message));
    return resultUpdateCommandResult(report, "failed", request.output);
  }
  if (request.reap && (plan.outcome === "reap-required" || incompleteJournal !== undefined)) {
    return runReapUpdate({
      selected,
      request,
      options,
      deps,
      initial,
      planning,
      plan,
      report,
    });
  }
  return executeSelectedPlan({
    selected,
    request,
    options,
    deps,
    initial,
    planning,
    plan,
    report,
  });
}

async function executeSelectedPlan(input: {
  selected: PlannedUpdateChannel;
  request: UpdateRequest;
  options: UpdateCommandOptions;
  deps: UpdateCommandDeps & { currentBuildInfo: StationBuildInfo };
  initial: UpdateReapRecoveryPreflight;
  planning: import("@station/contracts").UpdateConvergencePlanningInput;
  plan: import("@station/contracts").UpdateConvergencePlan;
  report: UpdateCommandResultDraft;
  reap?: UpdateReapRuntimeContext;
}): Promise<CliRunResult> {
  const { selected, request, options, deps, initial, planning, plan, report } = input;
  const current = artifact(selected.plan.currentVersion, selected.plan.currentRevision);
  const target = artifact(selected.plan.targetVersion, selected.plan.targetRevision);
  if (
    plan.phases.artifactApplication.action === "apply" &&
    !updateSuccessorEvidenceFitsOutput(initial, plan)
  ) {
    report.error = {
      tag: "UpdateError",
      code: "UPDATE_SUCCESSOR_EVIDENCE_TOO_LARGE",
      message: "Update evidence exceeds the bounded successor transport.",
      hint: "Reduce retained terminal evidence before retrying Station.",
    };
    report.steps.push(updateStep("apply", "skipped", report.error.message));
    return resultUpdateCommandResult(report, "failed", request.output);
  }
  const result = await executeUpdateConvergence(
    {
      selectedChannel: selected.channel,
      installedScopeDigest: selected.installedScopeDigest,
      installed: current,
      target,
      buildInfo: deps.currentBuildInfo,
      config: options.config,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      request,
      report,
      initial,
      plan,
      planning,
      artifactChanged: plan.phases.artifactApplication.action === "apply",
      ...(plan.phases.artifactApplication.action === "apply"
        ? {
            apply: () => applySelectedUpdate(selected, request, options.signal),
            ...(selected.applyRecoveryCommands === undefined
              ? {}
              : { applyRecoveryCommands: selected.applyRecoveryCommands }),
          }
        : {}),
      ...(deps.runSuccessor === undefined ? {} : { runSuccessor: deps.runSuccessor }),
      ...(input.reap === undefined ? {} : { reap: input.reap }),
    },
    executionDeps(deps, options, selected),
  );

  if (result.status === "intentionally-incomplete") {
    report.warnings.push({
      tag: "UpdateWarning",
      code: "UPDATE_HOST_HANDOFF_DISABLED",
      message: "Host handoff was disabled; the next TUI may refuse the incumbent Host.",
    });
  } else if (
    result.status !== "current" &&
    result.status !== "updated" &&
    result.status !== "deferred"
  ) {
    addRecoveryGuidance(report, selected, request, options.configPath, result.status);
  }
  return resultUpdateCommandResult(report, result.status, request.output);
}

async function runReapUpdate(input: {
  selected: PlannedUpdateChannel;
  request: UpdateRequest;
  options: UpdateCommandOptions;
  deps: UpdateCommandDeps & { currentBuildInfo: StationBuildInfo };
  initial: UpdateReapRecoveryPreflight;
  planning: import("@station/contracts").UpdateConvergencePlanningInput;
  plan: import("@station/contracts").UpdateConvergencePlan;
  report: UpdateCommandResultDraft;
}): Promise<CliRunResult> {
  const { selected, request, options, deps, report } = input;
  if (
    deps.reapJournal === undefined ||
    deps.reapProcessGroups === undefined ||
    deps.reapSessionResume === undefined ||
    deps.deriveReapAuthorization === undefined
  ) {
    report.error = {
      tag: "UpdateError",
      code: "UPDATE_REAP_CAPABILITY_UNAVAILABLE",
      message: "Terminal-reap execution capabilities are unavailable.",
    };
    report.steps.push(updateStep("recovery-preparation", "failed", report.error.message));
    return resultUpdateCommandResult(report, "failed", request.output);
  }
  const journalPort = deps.reapJournal;
  const processGroups = deps.reapProcessGroups;
  const resumePort = deps.reapSessionResume;
  const deriveAuthorization = deps.deriveReapAuthorization;
  return journalPort.withLock(async (lock) => {
    let initialAuthorization: UpdateReapAuthorization | undefined;
    let continuation: UpdateReapJournal | undefined;
    try {
      continuation = await journalPort.findIncomplete();
      const authorize = async (
        preflight: UpdateReapRecoveryPreflight,
        plan: import("@station/contracts").UpdateConvergencePlan,
      ) =>
        deriveAuthorization({
          channel: selected.channel,
          selectedArtifact: artifact(selected.plan.targetVersion, selected.plan.targetRevision),
          installedScopeDigest: selected.installedScopeDigest,
          preflight,
          plan,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      if (input.plan.outcome === "reap-required") {
        try {
          initialAuthorization = await authorize(input.initial, input.plan);
        } catch (error) {
          throw new UpdateReapAuthorizationRefusedError(
            error instanceof UpdateReapAuthorizationEvidenceError
              ? error.message
              : "Initial update reap evidence could not be verified.",
          );
        }
      }
      const reauthorize = async () => {
        const current = artifact(selected.plan.currentVersion, selected.plan.currentRevision);
        const target = artifact(selected.plan.targetVersion, selected.plan.targetRevision);
        const repeated = await inspectInitial(selected, current, target, deps);
        const repeatedPlanning = createPlanningInput(
          repeated,
          current,
          target,
          resolveUpdateInstallationIntent(selected, request.packageManager),
          request,
          deps.currentBuildInfo,
        );
        return authorize(repeated, deriveUpdateConvergencePlan(repeatedPlanning));
      };
      const prepared = await executeUpdateReap({
        expected: {
          channel: selected.channel,
          selectedArtifact: artifact(selected.plan.targetVersion, selected.plan.targetRevision),
          installedScopeDigest: selected.installedScopeDigest,
        },
        ...(initialAuthorization === undefined ? {} : { authorization: initialAuthorization }),
        ...(initialAuthorization === undefined ? {} : { reauthorize }),
        journal: journalPort,
        processGroups,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      report.steps.push(
        updateStep(
          "recovery-preparation",
          "completed",
          "Locked preflight matched the private terminal-reap authorization.",
        ),
        updateStep(
          "terminal-reap",
          prepared.recovery.unresolved ? "failed" : "completed",
          prepared.recovery.unresolved
            ? "One or more exact terminal process groups remain unresolved."
            : "Exact terminal process groups reached a terminal outcome.",
        ),
      );
      report.reapRecovery = prepared.recovery;
      if (prepared.recovery.unresolved) {
        report.recoveryCommands.push(...prepared.recovery.recoveryCommands);
        report.error = {
          tag: "UpdateError",
          code: "UPDATE_REAP_UNRESOLVED",
          message: "Terminal reaping did not reach a verified result for every target.",
        };
        return resultUpdateCommandResult(report, "failed", request.output);
      }

      let journal = prepared.journal;
      const current = artifact(selected.plan.currentVersion, selected.plan.currentRevision);
      const target = artifact(selected.plan.targetVersion, selected.plan.targetRevision);
      let postReap = await inspectInitial(selected, current, target, deps);
      if (!updateReapJournalHasReached(journal, "incumbent-host-empty")) {
        if (
          !updateReapIncumbentHostIsEmpty(
            journal,
            postReap,
            updateRecoveryActionCommitments(postReap),
          )
        ) {
          throw new Error("The incumbent Host did not report an exact zero-PTY inventory.");
        }
        journal = await markUpdateReapPhase(journal, "incumbent-host-empty", journalPort);
        postReap = await inspectInitial(selected, current, target, deps);
      }
      const postPlanning = createPlanningInput(
        postReap,
        current,
        target,
        resolveUpdateInstallationIntent(selected, request.packageManager),
        request,
        deps.currentBuildInfo,
      );
      const postPlan = deriveUpdateConvergencePlan(postPlanning);
      if (postPlan.outcome === "reap-required" || postPlan.outcome === "blocked") {
        throw new Error("The post-reap convergence plan was not actionable.");
      }
      return executeSelectedPlan({
        selected,
        request,
        options,
        deps,
        initial: postReap,
        planning: postPlanning,
        plan: postPlan,
        report,
        reap: {
          journal,
          journalPort,
          resumePort,
          prepareLockTransfer: lock.prepareTransfer,
        },
      });
    } catch (error) {
      const refusalSource = initialAuthorization ?? continuation;
      if (error instanceof UpdateReapAuthorizationRefusedError) {
        report.error = {
          tag: "UpdateError",
          code: "UPDATE_REAP_AUTHORIZATION_REFUSED",
          message: error.message,
        };
        report.steps.push(
          updateStep("recovery-preparation", "failed", error.message),
          updateStep(
            "terminal-reap",
            "skipped",
            "No terminal signal was sent because locked preflight did not match authorization.",
          ),
          updateStep(
            "session-resume",
            "skipped",
            "No session was resumed because terminal reaping did not start.",
          ),
        );
        report.reapRecovery =
          refusalSource === undefined
            ? refusedRecoveryFromUpdateReapPreflight(input.initial)
            : refusedRecoveryFromUpdateReapTargets(refusalSource);
        report.recoveryCommands.push(...report.reapRecovery.recoveryCommands);
        return resultUpdateCommandResult(report, "failed", request.output);
      }
      report.error = publicSafeErrorFromUnknown(error, {
        tag: "UpdateError",
        code: "UPDATE_REAP_EXECUTION_FAILED",
        message: "Station could not complete the authorized terminal-reap transaction.",
      });
      report.recoveryCommands.push(["stn", "update", "--reap"]);
      return resultUpdateCommandResult(report, "failed", request.output);
    }
  });
}

async function inspectInitial(
  selected: PlannedUpdateChannel,
  current: UpdateArtifact,
  target: UpdateArtifact,
  deps: UpdateCommandDeps & { currentBuildInfo: StationBuildInfo },
): Promise<UpdateReapRecoveryPreflight> {
  if (deps.recoveryPreflight === undefined) {
    throw {
      tag: "UpdatePreflightError",
      code: "UPDATE_PREFLIGHT_PORTS_UNAVAILABLE",
      message: "Update recovery preflight is unavailable in this CLI composition.",
    } satisfies SafeError;
  }
  const initial = await deps.recoveryPreflight({
    installed: current,
    target,
    currentBuildArtifact: current,
    currentBuildInfo: deps.currentBuildInfo,
  });
  if (
    initial.installed.version !== current.version ||
    initial.installed.revision !== current.revision ||
    initial.target.version !== target.version ||
    initial.target.revision !== target.revision
  ) {
    throw new Error(`Update preflight changed the selected ${selected.channel} artifacts.`);
  }
  return initial;
}

function createPlanningInput(
  initial: UpdateReapRecoveryPreflight,
  current: UpdateArtifact,
  target: UpdateArtifact,
  installation: ReturnType<typeof resolveUpdateInstallationIntent>,
  request: UpdateRequest,
  buildInfo: StationBuildInfo,
): import("@station/contracts").UpdateConvergencePlanningInput {
  return UpdateConvergencePlanningInputSchema.parse({
    preflight: initial,
    targetRuntime: artifactsMatch(current, target)
      ? {
          status: "known",
          buildIdentity: buildInfo.buildIdentity,
          observerSelector: stationObserverBuildVersion(buildInfo),
        }
      : { status: "not-yet-provable" },
    installation,
    handoff:
      request.handoff === undefined
        ? { action: "leave-in-place" }
        : { action: "preserve", fidelity: request.handoff },
  });
}

async function applySelectedUpdate(
  selected: PlannedUpdateChannel,
  request: UpdateRequest,
  signal: AbortSignal | undefined,
): Promise<import("../update/updateChannel.js").UpdateApplyReportBase> {
  const result = await selected.apply({
    drivePackageManager: request.packageManager === "drive",
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.channel !== selected.channel) {
    throw new Error("The selected install owner returned a different channel.");
  }
  return result;
}

function executionDeps(
  deps: UpdateCommandDeps,
  options: UpdateCommandOptions,
  selected: Pick<PlannedUpdateChannel, "channel" | "inspectInstalled">,
): UpdateConvergenceExecutionDeps {
  if (deps.recoveryPreflight === undefined) {
    throw new Error("Update recovery preflight is unavailable in this CLI composition.");
  }
  const recoveryPreflight = deps.recoveryPreflight;
  const capabilities = createUpdateRuntimeCapabilities({
    config: options.config,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(deps.providers === undefined ? {} : { providers: deps.providers }),
    ...(deps.hostDeps === undefined ? {} : { hostDeps: deps.hostDeps }),
    ...(deps.convergeObserver === undefined ? {} : { convergeObserver: deps.convergeObserver }),
    ...(deps.reconcileHook === undefined ? {} : { reconcileHook: deps.reconcileHook }),
    ...(deps.convergeHost === undefined ? {} : { convergeHost: deps.convergeHost }),
    ...(deps.reconcilePersisted === undefined
      ? {}
      : { reconcilePersisted: deps.reconcilePersisted }),
  });
  return {
    inspectInstalled: () =>
      selected.inspectInstalled(options.signal === undefined ? {} : { signal: options.signal }),
    inspect: async ({ target, currentBuildArtifact, currentBuildInfo }) => {
      const installedBefore = await selected.inspectInstalled(
        options.signal === undefined ? {} : { signal: options.signal },
      );
      if (installedBefore === undefined) {
        throw new Error(
          `The ${selected.channel} channel no longer owns the selected installation.`,
        );
      }
      const aggregate = await recoveryPreflight({
        installed: installedBefore,
        target,
        currentBuildArtifact,
        currentBuildInfo,
      });
      const installedAfter = await selected.inspectInstalled(
        options.signal === undefined ? {} : { signal: options.signal },
      );
      if (installedAfter === undefined || !artifactsMatch(installedBefore, installedAfter)) {
        throw new Error(`The ${selected.channel} installation changed during final verification.`);
      }
      return aggregate;
    },
    ...(deps.providers === undefined ? {} : { providers: deps.providers }),
    ...capabilities,
  };
}

function parseSuccessorInput(stdin: string | undefined): UpdateSuccessorRequest {
  if (
    stdin === undefined ||
    stdin.length === 0 ||
    new TextEncoder().encode(stdin).byteLength > 64 * 1024
  ) {
    throw new Error("The update successor request is missing or exceeds its size limit.");
  }
  return UpdateSuccessorRequestSchema.parse(JSON.parse(stdin));
}

function successorResult(
  request: UpdateSuccessorRequest,
  report: UpdateCommandResultDraft,
  completed: boolean,
): CliRunResult {
  const receipt: UpdateSuccessorReceipt = {
    schemaVersion: 1,
    status: completed ? "completed" : "failed",
    channel: request.channel,
    target: request.target,
    actions: report.steps.map(actionFromStep),
    hookReconciliations: report.hookReconciliations,
    parkedTerminals: parkedTerminalsFromInspection(report.finalInspection),
    finalInspection: receiptFinalInspection(
      report.finalInspection ?? {
        status: "failed",
        error: {
          tag: "UpdateError",
          code: "UPDATE_FINAL_VERIFICATION_MISSING",
          message: "Successor did not produce final verification evidence.",
        },
      },
    ),
    ...(report.reapRecovery === undefined ? {} : { reapRecovery: report.reapRecovery }),
  };
  if (report.error !== undefined) receipt.error = report.error;
  if (!updateSuccessorReceiptFitsOutput(receipt)) {
    return successorFailure(request, {
      tag: "UpdateError",
      code: "UPDATE_SUCCESSOR_RECEIPT_TOO_LARGE",
      message: "The target Station successor produced more evidence than the transport accepts.",
    });
  }
  const parsed = UpdateSuccessorReceiptSchema.parse(receipt);
  return { code: completed ? 0 : 1, output: parsed };
}

function successorFailure(request: UpdateSuccessorRequest, error: unknown): CliRunResult {
  const safeError = publicSafeErrorFromUnknown(error, {
    tag: "UpdateError",
    code: "UPDATE_SUCCESSOR_REQUEST_FAILED",
    message: "The target Station successor could not converge its runtime.",
  });
  const receipt: UpdateSuccessorReceipt = {
    schemaVersion: 1,
    status: "failed",
    channel: request.channel,
    target: request.target,
    actions: [],
    hookReconciliations: [],
    parkedTerminals: [],
    finalInspection: { status: "failed", error: safeError },
    error: safeError,
  };
  return { code: 1, output: UpdateSuccessorReceiptSchema.parse(receipt) };
}

function parkedTerminalsFromInspection(
  inspection: UpdateFinalInspection | undefined,
): UpdateSuccessorReceipt["parkedTerminals"] {
  if (inspection === undefined || inspection.status === "failed") return [];
  return [...(updateRecoveryActionCommitments(inspection.aggregate).parkedTerminals ?? [])];
}

function actionFromStep(step: UpdateCommandStep): UpdateSuccessorReceipt["actions"][number] {
  return {
    id: step.id,
    status: step.status,
    detail: step.detail.slice(0, 512),
  };
}

function receiptFinalInspection(inspection: UpdateFinalInspection): UpdateFinalInspection {
  if (inspection.status === "failed") return inspection;
  if (inspection.plan.phases.artifactApplication.action === "defer") {
    throw new Error("Completed successor inspection cannot defer artifact installation.");
  }
  return {
    status: "completed",
    aggregate: inspection.aggregate,
    plan: {
      ...inspection.plan,
      phases: {
        ...inspection.plan.phases,
        artifactApplication: {
          ...inspection.plan.phases.artifactApplication,
          command: { kind: "none" },
        },
      },
    },
  };
}

function successorRequestToUpdateRequest(request: UpdateSuccessorRequest): UpdateRequest {
  return {
    channel: request.channel,
    mode: "apply",
    output: "json",
    packageManager: "defer",
    reap: request.reapContinuation !== undefined,
    ...(request.handoff.action === "preserve" ? { handoff: request.handoff.fidelity } : {}),
  };
}

async function successorReapContext(
  request: UpdateSuccessorRequest,
  deps: UpdateCommandDeps,
): Promise<UpdateReapRuntimeContext> {
  if (
    request.reapContinuation === undefined ||
    deps.reapJournal === undefined ||
    deps.reapSessionResume === undefined
  ) {
    throw new Error("Update reap continuation capabilities are unavailable.");
  }
  const journal = await deps.reapJournal.read(request.reapContinuation.journalId);
  if (
    journal.channel !== request.channel ||
    journal.selectedArtifact.version !== request.target.version ||
    journal.selectedArtifact.revision !== request.target.revision ||
    journal.installedScopeDigest !== request.installedScopeDigest ||
    !updateReapJournalHasReached(journal, "artifact-applied") ||
    updateReapJournalHasReached(journal, "completed")
  ) {
    throw new Error("The protected successor request did not match its update reap journal.");
  }
  return {
    journal,
    journalPort: deps.reapJournal,
    resumePort: deps.reapSessionResume,
  };
}

function handoffRequest(request: UpdateSuccessorRequest) {
  return request.handoff.action === "preserve"
    ? { action: "preserve" as const, fidelity: request.handoff.fidelity }
    : { action: "leave-in-place" as const };
}

function sameProviders(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((provider, index) => provider === right[index]);
}

function addRecoveryGuidance(
  report: UpdateCommandResultDraft,
  selected: PlannedUpdateChannel,
  request: UpdateRequest,
  configPath: string | undefined,
  status: UpdateConvergenceExecutionResult["status"],
): void {
  if (report.recoveryCommands.length === 0) {
    report.recoveryCommands.push(retryUpdateCommand(selected.plan.currentCli, configPath, request));
  }
  if (status === "reap-required") return;
  const failedHook =
    report.hookReconciliations.find((entry) => !providerHookReconciliationSucceeded(entry)) ??
    report.initial.hooks.find(
      (entry) => entry.status === "ownership-conflict" || entry.status === "inspection-failed",
    );
  if (failedHook === undefined) return;
  const followUp = "followUp" in failedHook ? failedHook.followUp.action : undefined;
  let hookRecovery: UpdateCommandArgv | undefined;
  if (followUp === "run-explicit-takeover") {
    hookRecovery = stationCommand(selected.plan.currentCli, configPath, [
      "hooks",
      "install",
      failedHook.provider,
      "--yes",
      "--takeover",
    ]);
  } else if (followUp === "run-doctor") {
    hookRecovery = stationCommand(selected.plan.currentCli, configPath, [
      "hooks",
      "doctor",
      failedHook.provider,
    ]);
  }
  if (
    hookRecovery !== undefined &&
    !report.recoveryCommands.some((command) => sameCommand(command, hookRecovery))
  ) {
    report.recoveryCommands.unshift(hookRecovery);
  }
}

function sameCommand(left: UpdateCommandArgv, right: UpdateCommandArgv): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function retryUpdateCommand(
  cli: ExecutableArgv,
  configPath: string | undefined,
  request: UpdateRequest,
): UpdateCommandArgv {
  return stationCommand(cli, configPath, [
    "update",
    ...(request.channel === undefined ? [] : ["--channel", request.channel]),
    ...(request.packageManager === "drive" ? ["--drive-package-manager"] : []),
    ...(request.handoff === undefined ? ["--no-handoff"] : [`--handoff=${request.handoff}`]),
  ]);
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

function artifact(version: string, revision: string | undefined): UpdateArtifact {
  return { version, ...(revision === undefined ? {} : { revision }) };
}

function artifactsMatch(left: UpdateArtifact, right: UpdateArtifact): boolean {
  return left.version === right.version && left.revision === right.revision;
}
