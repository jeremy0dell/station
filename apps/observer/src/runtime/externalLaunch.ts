import type {
  SafeError,
  TerminalProvider,
  TerminalReattachCapability,
  TerminalTargetId,
} from "@station/contracts";
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

/**
 * The terminal provider id used for externally-hosted (Station-owned) targets.
 * Kept in sync with `@station/terminal`'s provider id by value, NOT by
 * import, so the observer stays free of `integrations/terminal/*` imports.
 */
const EXTERNAL_TERMINAL_PROVIDER_ID = "native";

type MarkExitableTerminalProvider = TerminalProvider & {
  markExited(targetId: string): boolean;
};

function canMarkExited(provider: TerminalProvider): provider is MarkExitableTerminalProvider {
  return typeof (provider as Partial<MarkExitableTerminalProvider>).markExited === "function";
}

/** Runtime feature-detect — the registry holds bare `TerminalProvider`; only the
 *  host-backed `native` provider implements `reattachInfo`. */
function isReattachable(
  provider: TerminalProvider,
): provider is TerminalProvider & TerminalReattachCapability {
  return "reattachInfo" in provider;
}

/**
 * Build a reattach handle if a live host PTY backs this worktree's Station target.
 * Stays decoupled from `@station/terminal`: the target id is derived by value
 * and `reattachInfo` is the optional persistence capability (absent ⇒ no handle,
 * the UI spawns the PTY locally).
 */
async function resolveReattachHandle(
  station: TerminalProvider,
  worktreeId: string,
): Promise<AgentReattachHandle | undefined> {
  if (!isReattachable(station)) {
    return undefined;
  }
  const terminalTargetId = `${EXTERNAL_TERMINAL_PROVIDER_ID}:${worktreeId}` as TerminalTargetId;
  const info = await station.reattachInfo(terminalTargetId);
  if (info === undefined) {
    return undefined;
  }
  return { ptyId: info.endpointId, terminalTargetId, hostSocketPath: info.socketPath };
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
 * Prepare Station-hosted agent identity and launch plan without spawning; the
 * in-memory station target lets reconcile surface the session immediately.
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
    const reattachStation = deps.providers.terminals.get(EXTERNAL_TERMINAL_PROVIDER_ID);
    const reattachHandle =
      reattachStation === undefined
        ? undefined
        : await resolveReattachHandle(reattachStation, params.worktreeId);
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

  const station = deps.providers.terminals.get(EXTERNAL_TERMINAL_PROVIDER_ID);
  if (station === undefined) {
    throw externalProviderUnavailableError();
  }

  // The snapshot's `row.agent` lags a concurrent prepare's registration (it is
  // only populated by the post-prepare reconcile). When the snapshot shows no
  // agent at all but a station target already exists, a concurrent prepare just
  // registered it — return its session instead of minting a second. (An *exited*
  // agent's stale target is intentionally NOT reused: `row.agent` is defined, so
  // this short-circuits to undefined and openWorkspace upserts the stale target
  // below, relaunching the agent.)
  const concurrentStationTarget =
    row.agent === undefined
      ? (await station.listTargets()).find(
          (target) => target.worktreeId === params.worktreeId && target.sessionId !== undefined,
        )
      : undefined;
  if (concurrentStationTarget?.sessionId !== undefined) {
    const reattachHandle = await resolveReattachHandle(station, params.worktreeId);
    return {
      outcome: {
        kind: "existing-session",
        sessionId: concurrentStationTarget.sessionId,
        harnessProvider:
          concurrentStationTarget.harnessBinding?.harnessProvider ?? harnessProviderId,
        ...(reattachHandle === undefined ? {} : { reattachHandle }),
      },
      reconcile: false,
    };
  }

  // Accepted race: two *distinct* UIs racing prepare on the same worktree
  // can both pass the listTargets check above before either openWorkspace below
  // runs. openWorkspace upserts by the deterministic `station:<worktreeId>` id, so
  // the window resolves to exactly one target (the second session wins; the first
  // is orphaned and reaped at the next reconcile) — never two targets/runs. A
  // single UI is already covered by Station's `launchesInFlight` guard; a
  // server-side lock is intentionally out of scope.
  const sessionId = defaultSessionCommandIdFactory.sessionId();

  let openedTargetId: string | undefined;
  try {
    const opened = await station.openWorkspace({
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
    if (station.launchProcess !== undefined) {
      const launched = await station.launchProcess({
        project,
        worktree,
        terminalTarget: opened.target,
        agentEndpointId: opened.agentEndpointId,
        launchPlan,
      });
      if (launched.started && launched.reattach !== undefined) {
        reattachHandle = {
          ptyId: launched.reattach.endpointId,
          terminalTargetId: opened.target.targetId,
          hostSocketPath: launched.reattach.socketPath,
        };
      }
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
    if (openedTargetId !== undefined && canMarkExited(station)) {
      station.markExited(openedTargetId);
    }
    throw error;
  }
}

/**
 * Drop an externally-hosted target when the Station UI reports its PTY exited, so
 * the next reconcile removes the session from both dashboards. Idempotent: an
 * unknown target id is acknowledged without a reconcile.
 */
export async function reportExternalExit(
  deps: ExternalLaunchDeps,
  params: AgentReportExternalExitParams,
): Promise<ExternalLaunchOutcome<AgentReportExternalExitResult>> {
  let acknowledged = false;
  for (const provider of deps.providers.terminals.values()) {
    if (canMarkExited(provider) && provider.markExited(params.terminalTargetId)) {
      acknowledged = true;
    }
  }
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

function externalProviderUnavailableError(): SafeError {
  return {
    tag: "TerminalProviderError",
    code: "TERMINAL_PROVIDER_UNAVAILABLE",
    message:
      "The Station terminal provider is not registered, so an external launch cannot be prepared.",
    provider: EXTERNAL_TERMINAL_PROVIDER_ID,
  };
}
