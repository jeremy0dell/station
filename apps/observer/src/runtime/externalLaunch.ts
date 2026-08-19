import type {
  AgentPrepareExternalLaunchParams,
  AgentPrepareExternalLaunchResult,
  AgentReportExternalExitParams,
  AgentReportExternalExitResult,
  ManagedOpenWorkspaceResult,
  ManagedTerminalLifecycle,
  SafeError,
  SessionView,
} from "@station/contracts";
import { terminalTargetObservationFromBinding, worktreeHasLiveAgent } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import { worktreeMissingError } from "../commands/errors.js";
import { assertHarnessLaunchPreconditionsOrThrow } from "../commands/harnessLaunchPreflight.js";
import { resolveHarnessProviderOrThrow } from "../commands/providers.js";
import {
  defaultSessionCommandIdFactory,
  findProjectOrThrow,
  rememberedHarnessProviderForWorktree,
  resolveForkSessionGroupPlacement,
  type SessionCommandIdFactory,
  seedSession,
  sessionSeedGroupPlacement,
  worktreeObservationFromRow,
} from "../commands/session/shared.js";
import type { SessionSeedGroupProvenance, SessionStore } from "../persistence/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ObserverCore } from "../reconcile/core.js";
import { resolveSessionRecovery } from "../sessionRecovery.js";
import type { StationLogger } from "../stationLogger.js";
import { nowIso } from "../utils/time.js";
import type { WorktreeMutationCoordinator } from "../worktreeMutationCoordinator.js";

export type ExternalLaunchDeps = {
  core: ObserverCore;
  providers: ProviderRegistry;
  persistence: SessionStore;
  clock?: RuntimeClock | undefined;
  configPath?: string | undefined;
  sessionResumeAgentEnabled?: boolean | undefined;
  logger?: StationLogger | undefined;
  idFactory?: Partial<SessionCommandIdFactory> | undefined;
  worktreeMutations: WorktreeMutationCoordinator;
};

type ExternalExitDeps = Pick<ExternalLaunchDeps, "providers">;

export type ExternalLaunchOutcome<T> = {
  outcome: T;
  /** Whether the caller should request a shared scheduled reconcile for this lifecycle change. */
  reconcile: boolean;
};

/**
 * USE CASE
 *
 * Returns a live or attachable managed identity first, then exactly recovers the canonical open
 * Station session before permitting a fresh identity. Both launch paths preflight only the selected
 * provider and pass provider-neutral resume options to the harness. A fresh identity is atomically
 * seeded with explicit root placement or the requested source session's current Group before target
 * publication, and confirmed failed launch cleanup removes only its membership and owned inline
 * Group without touching source or retained recovery state.
 */
export async function prepareExternalLaunch(
  deps: ExternalLaunchDeps,
  params: AgentPrepareExternalLaunchParams,
): Promise<ExternalLaunchOutcome<AgentPrepareExternalLaunchResult>> {
  return deps.worktreeMutations.run(params.projectId, params.worktreeId, () =>
    prepareExternalLaunchForWorktree(deps, params),
  );
}

async function prepareExternalLaunchForWorktree(
  deps: ExternalLaunchDeps,
  params: AgentPrepareExternalLaunchParams,
): Promise<ExternalLaunchOutcome<AgentPrepareExternalLaunchResult>> {
  const project = findProjectOrThrow(deps.core.getProjects(), params.projectId);
  const snapshot = deps.core.getSnapshot();
  const row = snapshot.rows.find((candidate) => candidate.id === params.worktreeId);

  if (row !== undefined && row.projectId !== params.projectId) {
    throw worktreeProjectMismatchError(params.projectId, row.id);
  }

  if (row === undefined) {
    throw worktreeMissingError({
      projectId: params.projectId,
      worktreeId: params.worktreeId,
      message: "The requested worktree is not visible in the current snapshot.",
    });
  }

  const managedTerminal = deps.providers.managedTerminal;
  const managedTargets = managedTerminal === undefined ? [] : await managedTerminal.listTargets();
  if (managedTerminal !== undefined) {
    for (const target of managedTargets) {
      if (
        target.worktreeId !== params.worktreeId ||
        (target.projectId !== undefined && target.projectId !== params.projectId) ||
        target.sessionId === undefined
      ) {
        continue;
      }
      const attachment = await managedTerminal.attachmentForTarget(target.id);
      if (attachment !== undefined) {
        return {
          outcome: {
            kind: "existing-session",
            sessionId: target.sessionId,
            harnessProvider:
              target.harnessBinding?.harnessProvider ??
              row.agent?.harness ??
              project.defaults.harness,
            attachment,
          },
          reconcile: false,
        };
      }
    }
  }

  // One worktree, one live agent: an unattachable external or UI-owned target still wins over
  // application recovery. A stale `unknown` falls through via worktreeHasLiveAgent.
  if (worktreeHasLiveAgent(row)) {
    const agent = row.agent;
    if (agent?.sessionId === undefined) {
      throw sessionAlreadyHasAgentError(row.id);
    }
    return {
      outcome: {
        kind: "existing-session",
        sessionId: agent.sessionId,
        harnessProvider: agent.harness,
      },
      reconcile: false,
    };
  }

  const retainedSession = snapshot.sessions.find(
    (session) =>
      session.origin === "station" &&
      session.projectId === params.projectId &&
      session.worktreeId === params.worktreeId,
  );

  // Before first reconcile, the target is the only proof a concurrent prepare registered its
  // session. Retained sessions skip this provisional path so a dead UI target cannot block recovery.
  const concurrentManagedTarget =
    retainedSession === undefined && row.agent === undefined
      ? managedTargets.find(
          (target) =>
            target.worktreeId === params.worktreeId &&
            (target.projectId === undefined || target.projectId === params.projectId) &&
            target.sessionId !== undefined,
        )
      : undefined;
  if (concurrentManagedTarget?.sessionId !== undefined) {
    return {
      outcome: {
        kind: "existing-session",
        sessionId: concurrentManagedTarget.sessionId,
        harnessProvider:
          concurrentManagedTarget.harnessBinding?.harnessProvider ?? project.defaults.harness,
      },
      reconcile: false,
    };
  }

  const worktree = worktreeObservationFromRow(row, deps.providers.worktree.id, nowIso(deps.clock));

  const recovery =
    retainedSession === undefined
      ? undefined
      : await resolveAutomaticRecovery(deps, retainedSession, worktree, params.projectId);
  const harnessProviderId =
    recovery?.harness.id ??
    params.harness ??
    (await rememberedHarnessProviderForWorktree({
      persistence: deps.persistence,
      projectId: params.projectId,
      worktreeId: params.worktreeId,
      worktreePath: worktree.path,
    })) ??
    project.defaults.harness;
  const harness =
    recovery?.harness ?? resolveHarnessProviderOrThrow(deps.providers, harnessProviderId);

  await assertHarnessLaunchPreconditionsOrThrow({
    providers: deps.providers,
    providerId: harnessProviderId,
    ...(deps.configPath === undefined ? {} : { stationConfigPath: deps.configPath }),
  });

  if (managedTerminal === undefined) {
    throw managedTerminalUnavailableError();
  }

  // The worktree mutation coordinator serializes distinct clients through this
  // mutation boundary; the managed lifecycle still owns binding-generation CAS.
  const freshSession = retainedSession === undefined;
  const idFactory = { ...defaultSessionCommandIdFactory, ...deps.idFactory };
  const sessionId = retainedSession?.id ?? idFactory.sessionId();
  const acceptedGroupIntent =
    params.group?.kind === "source"
      ? resolveForkSessionGroupPlacement({
          snapshot,
          intent: params.group,
          projectId: project.id,
        })
      : params.group;
  const group = freshSession
    ? sessionSeedGroupPlacement(acceptedGroupIntent, idFactory.sessionGroupId)
    : undefined;
  const seededAt = nowIso(deps.clock);
  let opened: ManagedOpenWorkspaceResult | undefined;
  let sessionSeeded = false;
  let groupProvenance: SessionSeedGroupProvenance | undefined;
  try {
    if (freshSession) {
      const seed = await seedSession({
        persistence: deps.persistence,
        sessionId,
        projectId: project.id,
        worktreeId: worktree.id,
        initialTitle: params.title ?? row.title,
        harness: harnessProviderId,
        terminalProvider: managedTerminal.id,
        ...(group === undefined ? {} : { group }),
        clock: deps.clock,
      });
      sessionSeeded = true;
      groupProvenance = seed.groupProvenance;
      if (params.title !== undefined && params.title !== row.title) {
        // New-session intent may replace reconcile's branch fallback before the target becomes visible.
        await deps.persistence.renameSession({
          sessionId,
          title: params.title,
          renamedAt: seededAt,
        });
      }
    }

    opened = await managedTerminal.openManagedWorkspace({
      project,
      worktree,
      harness: harnessProviderId,
      layout: project.defaults.layout,
      sessionId,
    });
    const terminalTarget = terminalTargetObservationFromBinding({
      binding: opened.target,
      worktree,
      observedAt: nowIso(deps.clock),
    });
    const launchPlan = await harness.buildLaunch({
      project,
      worktree,
      terminalTarget,
      sessionId,
      ...(recovery === undefined ? {} : { resume: recovery.resume }),
    });

    // The managed result requires an attachment exactly when it starts the process,
    // so a remote spawn can never be advertised as eligible for local fallback.
    const launched = await managedTerminal.launchManagedProcess({
      project,
      worktree,
      terminalTarget: opened.target,
      agentEndpointId: opened.agentEndpointId,
      bindingToken: opened.bindingToken,
      launchPlan,
    });
    const outcome: Extract<AgentPrepareExternalLaunchResult, { kind: "prepared" }> = {
      kind: "prepared",
      sessionId,
      terminalTargetId: opened.target.targetId,
      terminalBindingToken: opened.bindingToken,
      launchPlan,
    };
    if (launched.started) {
      outcome.attachment = launched.attachment;
    } else if (launched.outputCompatibility !== undefined) {
      outcome.outputCompatibility = launched.outputCompatibility;
    }

    return {
      outcome,
      reconcile: true,
    };
  } catch (error) {
    const targetReleaseConfirmed = await releaseOpenedTargetBestEffort({
      managedTerminal,
      opened,
      sessionId,
      logger: deps.logger,
    });
    if (freshSession && sessionSeeded && targetReleaseConfirmed) {
      await discardSessionSeedBestEffort(deps, {
        sessionId,
        ...(groupProvenance === undefined ? {} : { groupProvenance }),
      });
    }
    throw error;
  }
}

async function releaseOpenedTargetBestEffort(input: {
  managedTerminal: ManagedTerminalLifecycle;
  opened: ManagedOpenWorkspaceResult | undefined;
  sessionId: string;
  logger?: StationLogger | undefined;
}): Promise<boolean> {
  if (input.opened === undefined) {
    return true;
  }
  try {
    return await input.managedTerminal.releaseTarget({
      targetId: input.opened.target.targetId,
      expectedSessionId: input.sessionId,
      expectedBindingToken: input.opened.bindingToken,
    });
  } catch (error) {
    await input.logger
      ?.warn("External launch cleanup could not release its managed target.", {
        sessionId: input.sessionId,
        terminalTargetId: input.opened.target.targetId,
        error,
      })
      .catch(() => undefined);
    return false;
  }
}

async function discardSessionSeedBestEffort(
  deps: Pick<ExternalLaunchDeps, "persistence" | "logger" | "clock">,
  input: {
    sessionId: string;
    groupProvenance?: SessionSeedGroupProvenance;
  },
): Promise<void> {
  try {
    await deps.persistence.discardSessionSeed({
      sessionId: input.sessionId,
      ...(input.groupProvenance === undefined ? {} : { groupProvenance: input.groupProvenance }),
      discardedAt: nowIso(deps.clock),
    });
  } catch (error) {
    await deps.logger
      ?.warn("External launch cleanup could not discard its session seed.", {
        sessionId: input.sessionId,
        error,
      })
      .catch(() => undefined);
  }
}

async function resolveAutomaticRecovery(
  deps: ExternalLaunchDeps,
  session: SessionView,
  worktree: ReturnType<typeof worktreeObservationFromRow>,
  projectId: string,
) {
  if (deps.sessionResumeAgentEnabled !== true) {
    throw sessionResumeDisabledError(projectId, worktree.id, session.id);
  }
  return resolveSessionRecovery({
    persistence: deps.persistence,
    providers: deps.providers,
    projectId,
    worktreeId: worktree.id,
    worktree,
    expected: {
      sessionId: session.id,
      provider: session.harness.provider,
    },
  });
}

/**
 * USE CASE
 *
 * Forgets only the matching managed target, session, and binding generation.
 * Missing exact identity or a superseded binding fails closed without reconcile;
 * reconciliation may retain the durable Station session as `No Agent`.
 */
export async function reportExternalExit(
  deps: ExternalExitDeps,
  params: AgentReportExternalExitParams,
): Promise<ExternalLaunchOutcome<AgentReportExternalExitResult>> {
  if (params.expectedSessionId === undefined || params.expectedBindingToken === undefined) {
    return {
      outcome: { acknowledged: false, terminalTargetId: params.terminalTargetId },
      reconcile: false,
    };
  }
  const acknowledged =
    (await deps.providers.managedTerminal?.releaseTarget({
      targetId: params.terminalTargetId,
      expectedSessionId: params.expectedSessionId,
      expectedBindingToken: params.expectedBindingToken,
    })) ?? false;
  return {
    outcome: { acknowledged, terminalTargetId: params.terminalTargetId },
    reconcile: acknowledged,
  };
}

function worktreeProjectMismatchError(projectId: string, worktreeId: string): SafeError {
  return {
    tag: "CommandValidationError",
    code: "WORKTREE_PROJECT_MISMATCH",
    message: "The requested worktree belongs to a different configured project.",
    projectId,
    worktreeId,
  };
}

function sessionAlreadyHasAgentError(worktreeId: string): SafeError {
  return {
    tag: "CommandValidationError",
    code: "SESSION_ALREADY_HAS_AGENT",
    message: "This worktree already has a primary agent session.",
    hint: "Focus the existing agent or close it before starting a new one.",
    worktreeId,
  };
}

function sessionResumeDisabledError(
  projectId: string,
  worktreeId: string,
  sessionId: string,
): SafeError {
  return {
    tag: "CommandValidationError",
    code: "SESSION_RESUME_DISABLED",
    message: "Agent resume is disabled for this interrupted session.",
    hint: "Enable feature_flags.session_resume_agent and retry.",
    projectId,
    worktreeId,
    sessionId,
  };
}

function managedTerminalUnavailableError(): SafeError {
  return {
    tag: "TerminalProviderError",
    code: "TERMINAL_PROVIDER_UNAVAILABLE",
    message: "No managed terminal lifecycle is registered for external launch.",
  };
}
