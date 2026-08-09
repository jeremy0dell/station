import type {
  AgentPrepareExternalLaunchParams,
  AgentPrepareExternalLaunchResult,
  AgentReportExternalExitParams,
  AgentReportExternalExitResult,
  SafeError,
  SessionView,
  TerminalTargetId,
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
  worktreeObservationFromRow,
} from "../commands/session/shared.js";
import type { SessionStore } from "../persistence/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ObserverCore } from "../reconcile/core.js";
import { resolveSessionRecovery } from "../sessionRecovery.js";
import type { StationLogger } from "../stationLogger.js";
import { nowIso } from "../utils/time.js";

export type ExternalLaunchDeps = {
  core: ObserverCore;
  providers: ProviderRegistry;
  persistence: SessionStore;
  clock?: RuntimeClock | undefined;
  configPath?: string | undefined;
  sessionResumeAgentEnabled?: boolean | undefined;
  logger?: StationLogger | undefined;
};

export type ExternalLaunchOutcome<T> = {
  outcome: T;
  /** Whether the caller should reconcile so the change reaches the snapshot. */
  reconcile: boolean;
};

/**
 * USE CASE
 *
 * Returns a live or attachable managed identity first, then exactly recovers the canonical open
 * Station session before permitting a fresh identity. Both launch paths preflight only the selected
 * provider and pass provider-neutral resume options to the harness. Failed cleanup releases only
 * the exact opened binding and never discards retained recovery state; local fallbacks preserve the
 * managed terminal's output policy while attachments consume compatibility remotely.
 */
export async function prepareExternalLaunch(
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

  // Accepted race: two *distinct* UIs racing prepare on the same worktree
  // can both pass the listTargets check above before either openWorkspace below
  // runs. The managed lifecycle owns the one-target-per-worktree invariant, so
  // the window resolves to one target (the second session may replace the first,
  // which reconcile later reaps) rather than two targets. A single UI is already
  // covered by Station's `launchesInFlight` guard; a server-side lock is out of scope.
  const freshSession = retainedSession === undefined;
  const sessionId = retainedSession?.id ?? defaultSessionCommandIdFactory.sessionId();
  const seededAt = nowIso(deps.clock);
  let openedTargetId: TerminalTargetId | undefined;
  let sessionSeeded = false;
  try {
    if (freshSession) {
      await deps.persistence.seedSession({
        sessionId,
        projectId: project.id,
        worktreeId: worktree.id,
        initialTitle: params.title ?? row.title,
        createdAt: seededAt,
        lastSeenAt: seededAt,
      });
      sessionSeeded = true;
      if (params.title !== undefined && params.title !== row.title) {
        // New-session intent may replace reconcile's branch fallback before the target becomes visible.
        await deps.persistence.renameSession({
          sessionId,
          title: params.title,
          renamedAt: seededAt,
        });
      }
    }

    const opened = await managedTerminal.openWorkspace({
      project,
      worktree,
      harness: harnessProviderId,
      layout: project.defaults.layout,
      sessionId,
    });
    openedTargetId = opened.target.targetId;
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
    const launched = await managedTerminal.launchProcess({
      project,
      worktree,
      terminalTarget: opened.target,
      agentEndpointId: opened.agentEndpointId,
      launchPlan,
    });
    const outcome: Extract<AgentPrepareExternalLaunchResult, { kind: "prepared" }> = {
      kind: "prepared",
      sessionId,
      terminalTargetId: opened.target.targetId,
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
    // Cleanup attempts stay independent so one failure cannot suppress the other or replace the launch error.
    let targetReleaseConfirmed = openedTargetId === undefined;
    if (openedTargetId !== undefined) {
      try {
        await managedTerminal.releaseTarget({
          targetId: openedTargetId,
          expectedSessionId: sessionId,
        });
        targetReleaseConfirmed = true;
      } catch (cleanupError) {
        await deps.logger
          ?.warn("External launch cleanup could not release its managed target.", {
            sessionId,
            terminalTargetId: openedTargetId,
            error: cleanupError,
          })
          .catch(() => undefined);
      }
    }
    if (freshSession && sessionSeeded && targetReleaseConfirmed) {
      try {
        await deps.persistence.discardSessionSeed({ sessionId });
      } catch (cleanupError) {
        await deps.logger
          ?.warn("External launch cleanup could not discard its session seed.", {
            sessionId,
            error: cleanupError,
          })
          .catch(() => undefined);
      }
    }
    throw error;
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
 * Forgets only the exact managed target/session binding reported by Station. A
 * missing expected session or superseded target fails closed without reconcile;
 * reconciliation may retain the durable Station session as `No Agent`.
 */
export async function reportExternalExit(
  deps: ExternalLaunchDeps,
  params: AgentReportExternalExitParams,
): Promise<ExternalLaunchOutcome<AgentReportExternalExitResult>> {
  if (params.expectedSessionId === undefined) {
    return {
      outcome: { acknowledged: false, terminalTargetId: params.terminalTargetId },
      reconcile: false,
    };
  }
  const acknowledged =
    (await deps.providers.managedTerminal?.releaseTarget({
      targetId: params.terminalTargetId,
      expectedSessionId: params.expectedSessionId,
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
