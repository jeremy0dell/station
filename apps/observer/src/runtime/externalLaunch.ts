import type { ManagedTerminalLifecycle, SafeError, TerminalTargetId } from "@station/contracts";
import { terminalTargetObservationFromBinding, worktreeHasLiveAgent } from "@station/contracts";
import type {
  AgentPrepareExternalLaunchParams,
  AgentPrepareExternalLaunchResult,
  AgentReattachHandle,
  AgentReportExternalExitParams,
  AgentReportExternalExitResult,
} from "@station/protocol";
import type { RuntimeClock } from "@station/runtime";
import { worktreeMissingError } from "../commands/errors.js";
import {
  assertHooksInstalledOrThrow,
  resolveHarnessProviderOrThrow,
} from "../commands/providers.js";
import {
  defaultSessionCommandIdFactory,
  findProjectOrThrow,
  rememberedHarnessProviderForWorktree,
  worktreeObservationFromRow,
} from "../commands/session/shared.js";
import type { ObserverPersistence } from "../persistence/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ObserverCore } from "../reconcile/core.js";
import { nowIso } from "../utils/time.js";

async function resolveReattachHandle(
  managedTerminal: ManagedTerminalLifecycle,
  targetId: TerminalTargetId,
): Promise<AgentReattachHandle | undefined> {
  const info = await managedTerminal.reattachInfo(targetId);
  if (info === undefined) {
    return undefined;
  }
  return { ptyId: info.endpointId, terminalTargetId: targetId, hostSocketPath: info.socketPath };
}

export type ExternalLaunchDeps = {
  core: ObserverCore;
  providers: ProviderRegistry;
  persistence: ObserverPersistence;
  clock?: RuntimeClock | undefined;
  configPath?: string | undefined;
};

export type ExternalLaunchOutcome<T> = {
  outcome: T;
  /** Whether the caller should reconcile so the change reaches the snapshot. */
  reconcile: boolean;
};

/**
 * USE CASE
 *
 * Prepare Station-hosted agent identity, launch plan, and managed process handoff;
 * the managed target lets reconcile surface the session immediately.
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
    const reattachHandle =
      managedTerminal === undefined || managedTarget === undefined
        ? undefined
        : await resolveReattachHandle(managedTerminal, managedTarget.id);
    return {
      outcome: {
        kind: "existing-session",
        sessionId: agent.sessionId,
        harnessProvider: agent.harness,
        ...(reattachHandle === undefined ? {} : { reattachHandle }),
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

  await assertHooksInstalledOrThrow(
    harness,
    deps.configPath === undefined ? {} : { stationConfigPath: deps.configPath },
  );

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
    const reattachHandle = await resolveReattachHandle(managedTerminal, concurrentManagedTarget.id);
    return {
      outcome: {
        kind: "existing-session",
        sessionId: concurrentManagedTarget.sessionId,
        harnessProvider:
          concurrentManagedTarget.harnessBinding?.harnessProvider ?? harnessProviderId,
        ...(reattachHandle === undefined ? {} : { reattachHandle }),
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

  let openedTargetId: TerminalTargetId | undefined;
  try {
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

    // Spawn the agent into the host so it outlives the UI, then hand the client a
    // reattach handle built FROM the spawn result — so "spawned remotely" and "has
    // a handle" never diverge (a divergence would double-spawn: host PTY + local
    // UI PTY). `started: false` (no host / host unavailable) ⇒ no handle and the UI
    // spawns the PTY locally from launchPlan.
    let reattachHandle: AgentReattachHandle | undefined;
    const launched = await managedTerminal.launchProcess({
      project,
      worktree,
      terminalTarget: opened.target,
      agentEndpointId: opened.agentEndpointId,
      launchPlan,
    });
    if (launched.started) {
      reattachHandle = {
        ptyId: launched.reattach.endpointId,
        terminalTargetId: opened.target.targetId,
        hostSocketPath: launched.reattach.socketPath,
      };
    }

    return {
      outcome: {
        kind: "prepared",
        sessionId,
        terminalTargetId: opened.target.targetId,
        launchPlan,
        ...(reattachHandle === undefined ? {} : { reattachHandle }),
      },
      reconcile: true,
    };
  } catch (error) {
    // Unregister the half-prepared target so a retry is not blocked by a dangling
    // session and reconcile does not surface a launch that never spawned.
    if (openedTargetId !== undefined) {
      try {
        await managedTerminal.releaseTarget(openedTargetId);
      } catch {
        // Cleanup must not replace the launch failure that explains why the target was abandoned.
      }
    }
    throw error;
  }
}

/**
 * USE CASE
 *
 * Drop an externally-hosted target when the Station UI reports its PTY exited, so
 * the next reconcile removes the session from both dashboards. Idempotent: an
 * unknown target id is acknowledged without a reconcile.
 */
export async function reportExternalExit(
  deps: ExternalLaunchDeps,
  params: AgentReportExternalExitParams,
): Promise<ExternalLaunchOutcome<AgentReportExternalExitResult>> {
  const acknowledged =
    (await deps.providers.managedTerminal?.releaseTarget(params.terminalTargetId)) ?? false;
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
