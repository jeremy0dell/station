import {
  executeObserverCommand,
  toSafeError,
  type ClientNotice,
  type ObserverService,
  type StationClientStateSource,
} from "@station/client";
import type { FreshSessionGroupPlacementIntent, ProviderId, SafeError } from "@station/contracts";
import { StationHostProviderError } from "@station/host";
import { paneTreeIds } from "../../state/paneTree.js";
import { selectPaneRecord } from "../../state/selectors.js";
import type { StationStore } from "../../state/store.js";
import type { AgentIdentity, PaneId } from "../../state/types.js";
import type {
  ManagedTerminalAttacher,
  ManagedTerminalFactory,
} from "../../terminal/pty/managedTerminalAttacher.js";
import type { PtyRegistry, PtyRegistryEntry } from "../../terminal/registry/ptyRegistry.js";
import type { StationTerminalSize, StationTerminalSpawnOptions } from "../../terminal/types.js";
import {
  externalTerminalProviderForWorktree,
  nonFocusableStationTerminalForWorktree,
  readinessForWorktree,
  unreachableTerminalRow,
} from "./stationRows.js";

/** What a managed primary-agent launch needs to ask the observer to prepare it. */
export type ManagedLaunchTarget = {
  projectId: string;
  worktreeId: string;
  cwd: string;
  /** User-visible title persisted only when preparation mints a fresh session. */
  title?: string;
  /** Harness selected for a fresh session; row activation lets Observer inherit it. */
  harness?: ProviderId;
  group?: FreshSessionGroupPlacementIntent;
  /** Spawn in the background without landing on the pane. */
  background?: boolean;
};

type ManagedLaunchAttemptDeps = {
  store: StationStore;
  clientState: StationClientStateSource;
  observerService: ObserverService | undefined;
  registry: PtyRegistry | undefined;
  managedTerminalAttacher: ManagedTerminalAttacher | undefined;
};

type ManagedLaunchContext = {
  paneId: PaneId;
  target: ManagedLaunchTarget;
  landInPane: boolean;
  turnReadiness: { sessionId: string; token: string } | undefined;
  exitedPane?: {
    entry: PtyRegistryEntry;
    identity: AgentIdentity;
  };
};

type PreparedLaunch = Awaited<ReturnType<ObserverService["prepareExternalLaunch"]>>;

/**
 * Typed result of one native managed-launch attempt.
 *
 * `landed` is true only when a foreground activation actually revealed, focused,
 * or opened its pane; notices and failures therefore cannot dismiss the overlay.
 */
export type ManagedLaunchAttemptResult =
  | { kind: "success"; landed: boolean }
  | { kind: "notice"; notice: ClientNotice }
  | { kind: "failure"; error: SafeError };

type ManagedLaunchAction =
  | {
      kind: "open-pane";
      spawnOptions: StationTerminalSpawnOptions;
      identity: AgentIdentity;
      createTerminal?: ManagedTerminalFactory;
    }
  | { kind: "focus-existing"; sessionId: string }
  | { kind: "notice"; notice: ClientNotice };

type OpenPaneAction = Extract<ManagedLaunchAction, { kind: "open-pane" }>;

type PreparedPanePlacement =
  | { kind: "fresh" }
  | {
      kind: "recycled";
      registry: PtyRegistry;
      viewport: StationTerminalSize;
      startAtStoredViewport: boolean;
    }
  | { kind: "refused" };

function failure(error: unknown): Extract<ManagedLaunchAttemptResult, { kind: "failure" }> {
  return { kind: "failure", error: toSafeError(error, { clientLabel: "Station" }) };
}

function notice(message: string): Extract<ManagedLaunchAttemptResult, { kind: "notice" }> {
  return { kind: "notice", notice: { kind: "info", message } };
}

function createContext(
  runtime: ManagedLaunchAttemptDeps,
  paneId: PaneId,
  target: ManagedLaunchTarget,
): ManagedLaunchContext {
  return {
    paneId,
    target,
    landInPane: target.background !== true,
    turnReadiness: readinessForWorktree(runtime.clientState, target.worktreeId),
  };
}

async function acknowledgeReadiness(
  service: ObserverService | undefined,
  readiness: ManagedLaunchContext["turnReadiness"],
): Promise<void> {
  if (readiness === undefined || service === undefined) {
    return;
  }
  try {
    await executeObserverCommand(
      service,
      {
        type: "session.acknowledgeTurn",
        payload: readiness,
      },
      { clientLabel: "Station" },
    );
  } catch {
    // Readiness acknowledgement remains best-effort after successful landing.
  }
}

type ManagedLaunchPreflight =
  | { kind: "continue"; service: ObserverService }
  | { kind: "settled"; result: ManagedLaunchAttemptResult };

async function runPreflight(
  runtime: ManagedLaunchAttemptDeps,
  context: ManagedLaunchContext,
): Promise<ManagedLaunchPreflight> {
  const pane = selectPaneRecord(runtime.store.getState(), context.paneId);
  const entry = runtime.registry?.get(context.paneId);
  if (
    pane?.role === "primary-agent" &&
    pane.agentIdentity !== undefined &&
    entry?.exited === true &&
    context.landInPane
  ) {
    context.exitedPane = { entry, identity: pane.agentIdentity };
  } else if (pane !== null) {
    if (context.landInPane) {
      runtime.store.actions.revealPane(context.paneId);
      await acknowledgeReadiness(runtime.observerService, context.turnReadiness);
    }
    return { kind: "settled", result: { kind: "success", landed: context.landInPane } };
  }

  const unreachable = unreachableTerminalRow(runtime.clientState, context.target.worktreeId);
  if (unreachable !== undefined) {
    return {
      kind: "settled",
      result: notice(
        `${unreachable.label}: agent is ${unreachable.state} under '${unreachable.provider}'; Station can't focus it here.`,
      ),
    };
  }

  // The HMR-shared synchronous guard prevents duplicate clicks from minting another session.
  if (runtime.store.transient.managedLaunchesInFlight.has(context.paneId)) {
    return { kind: "settled", result: { kind: "success", landed: false } };
  }
  if (runtime.observerService === undefined) {
    return {
      kind: "settled",
      result: failure({
        tag: "ClientObserverError",
        code: "OBSERVER_UNAVAILABLE",
        message: "No observer connection; cannot launch the agent.",
      } satisfies SafeError),
    };
  }

  runtime.store.transient.managedLaunchesInFlight.add(context.paneId);
  return { kind: "continue", service: runtime.observerService };
}

function buildPrepareParams(
  target: ManagedLaunchTarget,
): Parameters<ObserverService["prepareExternalLaunch"]>[0] {
  const params: Parameters<ObserverService["prepareExternalLaunch"]>[0] = {
    projectId: target.projectId,
    worktreeId: target.worktreeId,
  };
  if (target.harness !== undefined) {
    params.harness = target.harness;
  }
  if (target.title !== undefined) {
    params.title = target.title;
  }
  if (target.group !== undefined) {
    params.group = target.group;
  }
  return params;
}

async function prepareLaunch(
  service: ObserverService,
  target: ManagedLaunchTarget,
): Promise<{ kind: "prepared"; launch: PreparedLaunch } | { kind: "failed"; error: SafeError }> {
  try {
    return { kind: "prepared", launch: await service.prepareExternalLaunch(buildPrepareParams(target)) };
  } catch (error: unknown) {
    return { kind: "failed", error: toSafeError(error, { clientLabel: "Station" }) };
  }
}

function resolveExistingSession(
  runtime: ManagedLaunchAttemptDeps,
  prepared: Extract<PreparedLaunch, { kind: "existing-session" }>,
  target: ManagedLaunchTarget,
): ManagedLaunchAction {
  const nonFocusableStation = nonFocusableStationTerminalForWorktree(
    runtime.clientState,
    target.worktreeId,
  );
  if (nonFocusableStation !== undefined) {
    return {
      kind: "notice",
      notice: {
        kind: "info",
        message: `${nonFocusableStation.label}: Station has no attachable host PTY for this existing agent.`,
      },
    };
  }
  const externalProvider = externalTerminalProviderForWorktree(
    runtime.clientState,
    target.worktreeId,
  );
  if (externalProvider !== undefined) {
    return {
      kind: "notice",
      notice: {
        kind: "info",
        message: `This agent runs in the "${externalProvider}" terminal, which Station can't display. Attach to it from a ${externalProvider} client.`,
      },
    };
  }
  return { kind: "focus-existing", sessionId: prepared.sessionId };
}

async function resolvePreparedLaunch(
  runtime: ManagedLaunchAttemptDeps,
  prepared: PreparedLaunch,
  target: ManagedLaunchTarget,
): Promise<ManagedLaunchAction | Extract<ManagedLaunchAttemptResult, { kind: "failure" }>> {
  // An advertised attachment is a commitment: resolution failure must never reach local spawn.
  if (prepared.attachment !== undefined) {
    if (runtime.managedTerminalAttacher === undefined) {
      return failure(
        new StationHostProviderError("HOST_UNREACHABLE", "Station host is not reachable."),
      );
    }
    try {
      const createTerminal = await runtime.managedTerminalAttacher.resolve(
        prepared.attachment,
        prepared.sessionId,
      );
      return {
        kind: "open-pane",
        createTerminal,
        spawnOptions: { cwd: target.cwd },
        identity: {
          sessionId: prepared.sessionId,
          terminalTargetId: prepared.attachment.terminalTargetId,
          harnessProvider:
            prepared.kind === "prepared" ? prepared.launchPlan.provider : prepared.harnessProvider,
        },
      };
    } catch (error: unknown) {
      return failure(error);
    }
  }

  if (prepared.kind === "existing-session") {
    return resolveExistingSession(runtime, prepared, target);
  }

  const spawnOptions: StationTerminalSpawnOptions = {
    cwd: target.cwd,
    command: prepared.launchPlan.command,
    args: prepared.launchPlan.args,
  };
  if (prepared.launchPlan.env !== undefined) {
    spawnOptions.env = prepared.launchPlan.env;
  }
  if (prepared.outputCompatibility !== undefined) {
    spawnOptions.outputCompatibility = prepared.outputCompatibility;
  }
  return {
    kind: "open-pane",
    spawnOptions,
    identity: {
      sessionId: prepared.sessionId,
      terminalTargetId: prepared.terminalTargetId,
      ...(prepared.terminalBindingToken === undefined
        ? {}
        : { terminalBindingToken: prepared.terminalBindingToken }),
      harnessProvider: prepared.launchPlan.provider,
    },
  };
}

async function focusExistingSession(
  service: ObserverService,
  sessionId: string,
): Promise<DashboardFocusResult> {
  const execution = await executeObserverCommand(
    service,
    {
      type: "terminal.focus",
      payload: { sessionId },
    },
    { clientLabel: "Station" },
  );
  if (execution.status === "succeeded" || execution.status === "accepted") {
    return { kind: "success" };
  }
  if (execution.status === "rejected" && execution.receipt.error === undefined) {
    return {
      kind: "failure",
      error: {
        ...execution.error,
        tag: "ClientObserverError",
        code: "STATION_FOCUS_REJECTED",
        message: "Station could not focus the existing agent.",
      },
    };
  }
  return { kind: "failure", error: execution.error };
}

type DashboardFocusResult =
  | { kind: "success" }
  | Extract<ManagedLaunchAttemptResult, { kind: "failure" }>;

async function performPreparedAction(
  runtime: ManagedLaunchAttemptDeps,
  context: ManagedLaunchContext,
  service: ObserverService,
  action: ManagedLaunchAction,
): Promise<ManagedLaunchAttemptResult> {
  switch (action.kind) {
    case "open-pane":
      return openPreparedPane(runtime, context, service, action);
    case "focus-existing": {
      if (!context.landInPane) {
        return { kind: "success", landed: false };
      }
      const focused = await focusExistingSession(service, action.sessionId);
      if (focused.kind === "failure") {
        return focused;
      }
      await acknowledgeReadiness(service, context.turnReadiness);
      return { kind: "success", landed: true };
    }
    case "notice":
      return { kind: "notice", notice: action.notice };
  }
}

async function openPreparedPane(
  runtime: ManagedLaunchAttemptDeps,
  context: ManagedLaunchContext,
  service: ObserverService,
  action: OpenPaneAction,
): Promise<ManagedLaunchAttemptResult> {
  const placement = placePreparedTerminal(runtime, context, action);
  if (placement.kind === "refused") {
    return notice("The agent pane changed while Station was preparing its relaunch.");
  }

  runtime.store.actions.createPane(context.paneId, { role: "primary-agent" });
  runtime.store.actions.setPrimaryAgent(context.paneId, action.identity);
  if (placement.kind === "recycled") {
    if (context.landInPane) {
      runtime.store.actions.revealPane(context.paneId);
    }
    if (placement.startAtStoredViewport) {
      placement.registry.resize(context.paneId, placement.viewport);
    }
  }
  if (context.landInPane) {
    await acknowledgeReadiness(service, context.turnReadiness);
  }
  return { kind: "success", landed: context.landInPane };
}

function placePreparedTerminal(
  runtime: ManagedLaunchAttemptDeps,
  context: ManagedLaunchContext,
  action: OpenPaneAction,
): PreparedPanePlacement {
  const exitedPane = context.exitedPane;
  const registry = runtime.registry;
  if (exitedPane === undefined || registry === undefined) {
    ensurePreparedTerminal(registry, context.paneId, action);
    return { kind: "fresh" };
  }

  const currentPane = selectPaneRecord(runtime.store.getState(), context.paneId);
  if (
    currentPane !== null &&
    (currentPane.role !== "primary-agent" ||
      !agentIdentityEquals(currentPane.agentIdentity, exitedPane.identity))
  ) {
    return { kind: "refused" };
  }
  const workspace = runtime.store.getState().workspace;
  const activePaneId = workspace.activePaneId;
  const treeIsActive =
    activePaneId !== null && paneTreeIds(workspace.panes, context.paneId).has(activePaneId);

  // The exact exited entry and replacement generation remain qualified through resetExited.
  const reset =
    action.createTerminal === undefined
      ? registry.resetExited(exitedPane.entry, action.spawnOptions)
      : registry.resetExited(exitedPane.entry, action.spawnOptions, action.createTerminal);
  if (reset.kind === "reset") {
    return {
      kind: "recycled",
      registry,
      viewport: reset.viewport,
      // Inactive trees remount after reveal, so they must not respawn at a stale hidden viewport.
      startAtStoredViewport: treeIsActive,
    };
  }
  if (reset.reason === "missing" && currentPane === null) {
    ensurePreparedTerminal(registry, context.paneId, action);
    return { kind: "fresh" };
  }
  return { kind: "refused" };
}

function ensurePreparedTerminal(
  registry: PtyRegistry | undefined,
  paneId: PaneId,
  action: OpenPaneAction,
): void {
  // Registry seeding must precede pane publication so first render cannot spawn defaults.
  if (action.createTerminal === undefined) {
    registry?.ensure(paneId, action.spawnOptions);
  } else {
    registry?.ensure(paneId, action.spawnOptions, action.createTerminal);
  }
}

function agentIdentityEquals(left: AgentIdentity | undefined, right: AgentIdentity): boolean {
  return (
    left?.sessionId === right.sessionId &&
    left.terminalTargetId === right.terminalTargetId &&
    left.terminalBindingToken === right.terminalBindingToken &&
    left.harnessProvider === right.harnessProvider
  );
}

async function releaseUnplacedLocalLaunch(
  service: ObserverService,
  prepared: PreparedLaunch,
): Promise<Extract<ManagedLaunchAttemptResult, { kind: "failure" }> | undefined> {
  if (prepared.kind !== "prepared" || prepared.attachment !== undefined) {
    return undefined;
  }
  try {
    // Observer compare-and-release is expected-session-qualified, so an old attempt
    // cannot remove a replacement generation that won the pane race.
    await service.reportExternalExit({
      terminalTargetId: prepared.terminalTargetId,
      expectedSessionId: prepared.sessionId,
      ...(prepared.terminalBindingToken === undefined
        ? {}
        : { expectedBindingToken: prepared.terminalBindingToken }),
    });
    return undefined;
  } catch (error: unknown) {
    return failure(error);
  }
}

async function runManagedLaunchAttempt(
  runtime: ManagedLaunchAttemptDeps,
  paneId: PaneId,
  target: ManagedLaunchTarget,
): Promise<ManagedLaunchAttemptResult> {
  const context = createContext(runtime, paneId, target);
  const preflight = await runPreflight(runtime, context);
  if (preflight.kind === "settled") {
    return preflight.result;
  }
  try {
    const preparation = await prepareLaunch(preflight.service, target);
    if (preparation.kind === "failed") {
      return { kind: "failure", error: preparation.error };
    }
    const action = await resolvePreparedLaunch(runtime, preparation.launch, target);
    if (action.kind === "failure") {
      return action;
    }
    const result = await performPreparedAction(runtime, context, preflight.service, action);
    if (
      result.kind === "notice" &&
      result.notice.message === "The agent pane changed while Station was preparing its relaunch."
    ) {
      const cleanupFailure = await releaseUnplacedLocalLaunch(preflight.service, preparation.launch);
      return cleanupFailure ?? result;
    }
    return result;
  } finally {
    runtime.store.transient.managedLaunchesInFlight.delete(paneId);
  }
}

/**
 * Create one native managed-launch runner while preserving registry-before-pane
 * publication, advertised-attachment fail-closed behavior, exact exited-entry
 * recycling, replacement guards, and viewport-aware retained-pane respawn.
 */
export function createManagedLaunchAttempt(
  deps: ManagedLaunchAttemptDeps,
): (paneId: PaneId, target: ManagedLaunchTarget) => Promise<ManagedLaunchAttemptResult> {
  const runtime: ManagedLaunchAttemptDeps = { ...deps };
  return (paneId, target) => runManagedLaunchAttempt(runtime, paneId, target);
}
