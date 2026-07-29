import {
  safeErrorToNotice,
  toSafeError,
  type ObserverService,
  type StationClientStateSource,
} from "@station/client";
import type { ProviderId, SafeError } from "@station/contracts";
import type { DashboardActions, DashboardStateSource } from "@station/dashboard-core";
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

type ManagedLaunchDashboard = {
  state: DashboardStateSource;
  clientState: StationClientStateSource;
  actions: Pick<DashboardActions, "pushToast">;
};

/** What a managed primary-agent launch needs to ask the observer to prepare it. */
export type ManagedLaunchTarget = {
  projectId: string;
  worktreeId: string;
  cwd: string;
  /**
   * User-visible title to persist only when this preparation mints a fresh
   * session; an existing session keeps its current title.
   */
  title?: string;
  /**
   * Harness to launch when minting a fresh session (the New Session wizard's
   * pick). Absent for a row click, where the observer uses the worktree's
   * remembered harness or the project default.
   */
  harness?: ProviderId;
  /**
   * Spawn the agent pane but leave the STATION overlay open and unfocused — the New
   * Session flow stays on the dashboard instead of focusing the pane. A row click
   * omits this and focuses the new pane.
   */
  background?: boolean;
};

type ManagedLaunchAttemptDeps = {
  store: StationStore;
  dashboardRuntime: ManagedLaunchDashboard | undefined;
  observerService: ObserverService | undefined;
  registry: PtyRegistry | undefined;
  managedTerminalAttacher: ManagedTerminalAttacher | undefined;
};

type ManagedLaunchRuntime = ManagedLaunchAttemptDeps;

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

export type ManagedLaunchAttemptResult =
  | { kind: "settled" }
  | { kind: "preparation-failed"; error: SafeError };

const SETTLED_RESULT: ManagedLaunchAttemptResult = { kind: "settled" };

type ManagedLaunchAction =
  | {
      kind: "open-pane";
      spawnOptions: StationTerminalSpawnOptions;
      identity: AgentIdentity;
      createTerminal?: ManagedTerminalFactory;
    }
  | { kind: "focus-existing"; sessionId: string }
  | { kind: "notice"; message: string };

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

type PreparedActionResult = "performed" | "refused";

function pushToast(
  runtime: ManagedLaunchRuntime,
  message: string,
  kind: "info" | "error" = "error",
): void {
  runtime.dashboardRuntime?.actions.pushToast({ kind, message });
}

function pushSafeError(runtime: ManagedLaunchRuntime, error: SafeError): void {
  runtime.dashboardRuntime?.actions.pushToast(safeErrorToNotice(error));
}

function pushError(runtime: ManagedLaunchRuntime, error: unknown): void {
  pushSafeError(runtime, toSafeError(error, { clientLabel: "Station" }));
}

function createContext(
  runtime: ManagedLaunchRuntime,
  paneId: PaneId,
  target: ManagedLaunchTarget,
): ManagedLaunchContext {
  return {
    paneId,
    target,
    landInPane: target.background !== true,
    turnReadiness:
      runtime.dashboardRuntime === undefined
        ? undefined
        : readinessForWorktree(runtime.dashboardRuntime.clientState, target.worktreeId),
  };
}

async function landOnPane(
  runtime: ManagedLaunchRuntime,
  service: ObserverService | undefined,
  readiness: ManagedLaunchContext["turnReadiness"],
): Promise<void> {
  runtime.store.actions.closeOverlay();
  if (readiness === undefined || service === undefined) {
    return;
  }
  try {
    const receipt = await service.dispatch({
      type: "session.acknowledgeTurn",
      payload: readiness,
    });
    if (receipt.accepted) {
      await service.waitForCommandCompletion(receipt.commandId);
    }
  } catch {
    // Readiness acknowledgement is best-effort after the pane has opened successfully.
  }
}

async function runPreflight(
  runtime: ManagedLaunchRuntime,
  context: ManagedLaunchContext,
): Promise<ObserverService | undefined> {
  const pane = selectPaneRecord(runtime.store.getState(), context.paneId);
  const entry = runtime.registry?.get(context.paneId);
  if (
    pane?.role === "primary-agent" &&
    pane.agentIdentity !== undefined &&
    entry?.exited === true &&
    context.landInPane
  ) {
    context.exitedPane = {
      entry,
      identity: pane.agentIdentity,
    };
  } else if (pane !== null) {
    if (context.landInPane) {
      runtime.store.actions.revealPane(context.paneId);
      await landOnPane(runtime, runtime.observerService, context.turnReadiness);
    }
    return undefined;
  }

  const unreachable =
    runtime.dashboardRuntime === undefined
      ? undefined
      : unreachableTerminalRow(runtime.dashboardRuntime.clientState, context.target.worktreeId);
  if (unreachable !== undefined) {
    pushToast(
      runtime,
      `${unreachable.label}: agent is ${unreachable.state} under '${unreachable.provider}'; Station can't focus it here.`,
      "info",
    );
    return undefined;
  }

  // The synchronous guard prevents duplicate clicks from minting a second Observer session.
  if (runtime.store.transient.managedLaunchesInFlight.has(context.paneId)) {
    return undefined;
  }
  if (runtime.observerService === undefined) {
    pushToast(runtime, "No observer connection; cannot launch the agent.");
    return undefined;
  }

  runtime.store.transient.managedLaunchesInFlight.add(context.paneId);
  return runtime.observerService;
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
  return params;
}

async function prepareLaunch(
  runtime: ManagedLaunchRuntime,
  service: ObserverService,
  target: ManagedLaunchTarget,
): Promise<
  | { kind: "prepared"; launch: PreparedLaunch }
  | Extract<ManagedLaunchAttemptResult, { kind: "preparation-failed" }>
> {
  try {
    return {
      kind: "prepared",
      launch: await service.prepareExternalLaunch(buildPrepareParams(target)),
    };
  } catch (error) {
    const safeError = toSafeError(error, { clientLabel: "Station" });
    pushSafeError(runtime, safeError);
    return { kind: "preparation-failed", error: safeError };
  }
}

function resolveExistingSession(
  runtime: ManagedLaunchRuntime,
  prepared: Extract<PreparedLaunch, { kind: "existing-session" }>,
  target: ManagedLaunchTarget,
): ManagedLaunchAction {
  const nonFocusableStation =
    runtime.dashboardRuntime === undefined
      ? undefined
      : nonFocusableStationTerminalForWorktree(
          runtime.dashboardRuntime.clientState,
          target.worktreeId,
        );
  if (nonFocusableStation !== undefined) {
    return {
      kind: "notice",
      message: `${nonFocusableStation.label}: Station has no attachable host PTY for this existing agent.`,
    };
  }
  const externalProvider =
    runtime.dashboardRuntime === undefined
      ? undefined
      : externalTerminalProviderForWorktree(
          runtime.dashboardRuntime.clientState,
          target.worktreeId,
        );
  if (externalProvider !== undefined) {
    return {
      kind: "notice",
      message: `This agent runs in the "${externalProvider}" terminal, which Station can't display. Attach to it from a ${externalProvider} client.`,
    };
  }
  return { kind: "focus-existing", sessionId: prepared.sessionId };
}

async function resolvePreparedLaunch(
  runtime: ManagedLaunchRuntime,
  prepared: PreparedLaunch,
  target: ManagedLaunchTarget,
): Promise<ManagedLaunchAction | undefined> {
  // An advertised attachment is a commitment: resolution failure must never reach local spawn.
  if (prepared.attachment !== undefined) {
    if (runtime.managedTerminalAttacher === undefined) {
      pushError(
        runtime,
        new StationHostProviderError("HOST_UNREACHABLE", "Station host is not reachable."),
      );
      return undefined;
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
    } catch (error) {
      pushError(runtime, error);
      return undefined;
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
      harnessProvider: prepared.launchPlan.provider,
    },
  };
}

async function focusExistingSession(
  runtime: ManagedLaunchRuntime,
  service: ObserverService,
  sessionId: string,
): Promise<boolean> {
  try {
    const receipt = await service.dispatch({
      type: "terminal.focus",
      payload: { sessionId },
    });
    if (!receipt.accepted) {
      pushError(
        runtime,
        receipt.error ?? {
          tag: "ClientObserverError",
          code: "STATION_FOCUS_REJECTED",
          message: "Station could not focus the existing agent.",
        },
      );
      return false;
    }
    const completion = await service.waitForCommandCompletion(receipt.commandId);
    if (completion.status === "failed") {
      pushError(runtime, completion.error);
      return false;
    }
    return true;
  } catch (error) {
    pushError(runtime, error);
    return false;
  }
}

async function performPreparedAction(
  runtime: ManagedLaunchRuntime,
  context: ManagedLaunchContext,
  service: ObserverService,
  action: ManagedLaunchAction,
): Promise<PreparedActionResult> {
  switch (action.kind) {
    case "open-pane":
      return await openPreparedPane(runtime, context, service, action);
    case "focus-existing":
      if (
        context.landInPane &&
        (await focusExistingSession(runtime, service, action.sessionId))
      ) {
        await landOnPane(runtime, service, context.turnReadiness);
      }
      return "performed";
    case "notice":
      pushToast(runtime, action.message, "info");
      return "performed";
  }
}

async function openPreparedPane(
  runtime: ManagedLaunchRuntime,
  context: ManagedLaunchContext,
  service: ObserverService,
  action: OpenPaneAction,
): Promise<PreparedActionResult> {
  const placement = placePreparedTerminal(runtime, context, action);
  if (placement.kind === "refused") {
    return "refused";
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
    await landOnPane(runtime, service, context.turnReadiness);
  }
  return "performed";
}

function placePreparedTerminal(
  runtime: ManagedLaunchRuntime,
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
    return refusePaneReplacement(runtime);
  }
  const workspace = runtime.store.getState().workspace;
  const activePaneId = workspace.activePaneId;
  const treeIsActive =
    activePaneId !== null && paneTreeIds(workspace.panes, context.paneId).has(activePaneId);

  const reset =
    action.createTerminal === undefined
      ? registry.resetExited(exitedPane.entry, action.spawnOptions)
      : registry.resetExited(exitedPane.entry, action.spawnOptions, action.createTerminal);
  if (reset.kind === "reset") {
    return {
      kind: "recycled",
      registry,
      viewport: reset.viewport,
      // An inactive tree remounts after reveal and reports its current layout;
      // spawning at its hidden historical size would force a startup correction.
      startAtStoredViewport: treeIsActive,
    };
  }
  if (reset.reason === "missing" && currentPane === null) {
    ensurePreparedTerminal(registry, context.paneId, action);
    return { kind: "fresh" };
  }
  return refusePaneReplacement(runtime);
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

function refusePaneReplacement(runtime: ManagedLaunchRuntime): PreparedPanePlacement {
  pushToast(runtime, "The agent pane changed while Station was preparing its relaunch.", "info");
  return { kind: "refused" };
}

function agentIdentityEquals(
  left: AgentIdentity | undefined,
  right: AgentIdentity,
): boolean {
  return (
    left?.sessionId === right.sessionId &&
    left.terminalTargetId === right.terminalTargetId &&
    left.harnessProvider === right.harnessProvider
  );
}

async function releaseUnplacedLocalLaunch(
  runtime: ManagedLaunchRuntime,
  service: ObserverService,
  prepared: PreparedLaunch,
): Promise<void> {
  if (prepared.kind !== "prepared" || prepared.attachment !== undefined) {
    return;
  }
  try {
    await service.reportExternalExit({
      terminalTargetId: prepared.terminalTargetId,
      expectedSessionId: prepared.sessionId,
    });
  } catch (error) {
    // A rejected compare-and-release leaves target ownership uncertain; never hide that cleanup state.
    pushError(runtime, error);
  }
}

async function runManagedLaunchAttempt(
  runtime: ManagedLaunchRuntime,
  paneId: PaneId,
  target: ManagedLaunchTarget,
): Promise<ManagedLaunchAttemptResult> {
  const context = createContext(runtime, paneId, target);
  const service = await runPreflight(runtime, context);
  if (service === undefined) {
    return SETTLED_RESULT;
  }
  try {
    const preparation = await prepareLaunch(runtime, service, target);
    if (preparation.kind === "preparation-failed") {
      return preparation;
    }
    const action = await resolvePreparedLaunch(runtime, preparation.launch, target);
    if (action !== undefined) {
      const result = await performPreparedAction(runtime, context, service, action);
      if (result === "refused") {
        await releaseUnplacedLocalLaunch(runtime, service, preparation.launch);
      }
    }
    return SETTLED_RESULT;
  } finally {
    runtime.store.transient.managedLaunchesInFlight.delete(paneId);
  }
}

/**
 * Creates one managed-launch runner whose phases preserve registry-before-pane publication,
 * apply output compatibility only to local spawns, and treat every advertised attachment as a
 * no-local-fallback commitment. Foreground dashboard activation may recycle only the exact exited
 * entry it observed, after preparation succeeds and before replacement identity can spawn.
 */
export function createManagedLaunchAttempt(
  deps: ManagedLaunchAttemptDeps,
): (paneId: PaneId, target: ManagedLaunchTarget) => Promise<ManagedLaunchAttemptResult> {
  const runtime: ManagedLaunchRuntime = { ...deps };
  return (paneId, target) => runManagedLaunchAttempt(runtime, paneId, target);
}
