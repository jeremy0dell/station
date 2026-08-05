import type {
  AgentPrepareExternalLaunchParams,
  AgentPrepareExternalLaunchResult,
  AgentReportExternalExitParams,
  AgentReportExternalExitResult,
  SafeError,
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
import type { StationLogger } from "../stationLogger.js";
import { nowIso } from "../utils/time.js";

export type ExternalLaunchDeps = {
  core: ObserverCore;
  providers: ProviderRegistry;
  persistence: SessionStore;
  clock?: RuntimeClock | undefined;
  configPath?: string | undefined;
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
 * Returns existing live identity without a gate; otherwise freshly preflights the selected harness
 * before seeding the canonical title or registering a target. Failed launch cleanup independently
 * releases its exact session target and discards only a seed whose target release is confirmed.
 * Local fallbacks retain the managed terminal's provider-neutral output policy; attachments consume
 * compatibility remotely.
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

  // One worktree, one live agent: if a primary agent is genuinely running, hand
  // back its session rather than minting a second. worktreeHasLiveAgent owns the
  // unknown/stale-terminal rules — a stale `unknown` falls through and openWorkspace
  // relaunches it below.
  if (row !== undefined && worktreeHasLiveAgent(row)) {
    const agent = row.agent;
    if (agent?.sessionId === undefined) {
      throw sessionAlreadyHasAgentError(row.id);
    }
    const managedTerminal = deps.providers.managedTerminal;
    const managedTarget =
      managedTerminal === undefined
        ? undefined
        : (await managedTerminal.listTargets()).find(
            (target) =>
              target.worktreeId === params.worktreeId && target.sessionId === agent.sessionId,
          );
    const attachment =
      managedTerminal === undefined || managedTarget === undefined
        ? undefined
        : await managedTerminal.attachmentForTarget(managedTarget.id);
    return {
      outcome: {
        kind: "existing-session",
        sessionId: agent.sessionId,
        harnessProvider: agent.harness,
        ...(attachment === undefined ? {} : { attachment }),
      },
      reconcile: false,
    };
  }

  if (row === undefined) {
    throw worktreeMissingError({
      projectId: params.projectId,
      worktreeId: params.worktreeId,
      message: "The requested worktree is not visible in the current snapshot.",
    });
  }

  const worktree = worktreeObservationFromRow(row, deps.providers.worktree.id, nowIso(deps.clock));

  const harnessProviderId =
    params.harness ??
    (await rememberedHarnessProviderForWorktree({
      persistence: deps.persistence,
      projectId: params.projectId,
      worktreeId: params.worktreeId,
      worktreePath: worktree.path,
    })) ??
    project.defaults.harness;
  const harness = resolveHarnessProviderOrThrow(deps.providers, harnessProviderId);

  await assertHarnessLaunchPreconditionsOrThrow({
    providers: deps.providers,
    providerId: harnessProviderId,
    ...(deps.configPath === undefined ? {} : { stationConfigPath: deps.configPath }),
  });

  const managedTerminal = deps.providers.managedTerminal;
  if (managedTerminal === undefined) {
    throw managedTerminalUnavailableError();
  }

  // The snapshot's `row.agent` lags a concurrent prepare's registration (it is
  // only populated by the post-prepare reconcile). When the snapshot shows no
  // agent at all but a station target already exists, a concurrent prepare just
  // registered it — return its session instead of minting a second. (An *exited*
  // agent's stale target is intentionally NOT reused: `row.agent` is defined, so
  // this short-circuits to undefined and openWorkspace upserts the stale target
  // below, relaunching the agent.)
  const concurrentManagedTarget =
    row.agent === undefined
      ? (await managedTerminal.listTargets()).find(
          (target) => target.worktreeId === params.worktreeId && target.sessionId !== undefined,
        )
      : undefined;
  if (concurrentManagedTarget?.sessionId !== undefined) {
    const attachment = await managedTerminal.attachmentForTarget(concurrentManagedTarget.id);
    return {
      outcome: {
        kind: "existing-session",
        sessionId: concurrentManagedTarget.sessionId,
        harnessProvider:
          concurrentManagedTarget.harnessBinding?.harnessProvider ?? harnessProviderId,
        ...(attachment === undefined ? {} : { attachment }),
      },
      reconcile: false,
    };
  }

  // Accepted race: two *distinct* UIs racing prepare on the same worktree
  // can both pass the listTargets check above before either openWorkspace below
  // runs. The managed lifecycle owns the one-target-per-worktree invariant, so
  // the window resolves to one target (the second session may replace the first,
  // which reconcile later reaps) rather than two targets. A single UI is already
  // covered by Station's `launchesInFlight` guard; a server-side lock is out of scope.
  const sessionId = defaultSessionCommandIdFactory.sessionId();
  const seededAt = nowIso(deps.clock);
  let openedTargetId: TerminalTargetId | undefined;
  let sessionSeeded = false;
  try {
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
    if (sessionSeeded && targetReleaseConfirmed) {
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

function managedTerminalUnavailableError(): SafeError {
  return {
    tag: "TerminalProviderError",
    code: "TERMINAL_PROVIDER_UNAVAILABLE",
    message: "No managed terminal lifecycle is registered for external launch.",
  };
}
