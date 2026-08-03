import { safeErrorToNotice, toSafeError, type ObserverService } from "@station/client";
import type { ProviderId, SafeError } from "@station/contracts";
import type { DashboardRuntime } from "@station/dashboard-core";
import { StationHostProviderError } from "@station/host";
import { selectPaneRecord } from "../../state/selectors.js";
import type { StationStore } from "../../state/store.js";
import type { AgentIdentity, PaneId } from "../../state/types.js";
import type {
  ManagedTerminalAttacher,
  ManagedTerminalFactory,
} from "../../terminal/pty/managedTerminalAttacher.js";
import type { PtyRegistry } from "../../terminal/registry/ptyRegistry.js";
import type { StationTerminalSpawnOptions } from "../../terminal/types.js";
import {
  externalTerminalProviderForWorktree,
  nonFocusableStationTerminalForWorktree,
  readinessForWorktree,
  unreachableTerminalRow,
} from "./stationRows.js";

type DashboardInput = Pick<DashboardRuntime, "state" | "actions">;

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
  dashboardRuntime: DashboardInput | undefined;
  observerService: ObserverService | undefined;
  registry: PtyRegistry | undefined;
  managedTerminalAttacher: ManagedTerminalAttacher | undefined;
};

type ManagedLaunchRuntime = ManagedLaunchAttemptDeps & {
  launchesInFlight: Set<PaneId>;
};

type ManagedLaunchContext = {
  paneId: PaneId;
  target: ManagedLaunchTarget;
  landInPane: boolean;
  turnReadiness: { sessionId: string; token: string } | undefined;
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
        : readinessForWorktree(runtime.dashboardRuntime, target.worktreeId),
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
  if (selectPaneRecord(runtime.store.getState(), context.paneId) !== null) {
    if (context.landInPane) {
      runtime.store.actions.revealPane(context.paneId);
      await landOnPane(runtime, runtime.observerService, context.turnReadiness);
    }
    return undefined;
  }

  const unreachable =
    runtime.dashboardRuntime === undefined
      ? undefined
      : unreachableTerminalRow(runtime.dashboardRuntime, context.target.worktreeId);
  if (unreachable !== undefined) {
    pushToast(
      runtime,
      `${unreachable.label}: agent is ${unreachable.state} under '${unreachable.provider}'; Station can't focus it here.`,
      "info",
    );
    return undefined;
  }

  // The synchronous guard prevents duplicate clicks from minting a second Observer session.
  if (runtime.launchesInFlight.has(context.paneId)) {
    return undefined;
  }
  if (runtime.observerService === undefined) {
    pushToast(runtime, "No observer connection; cannot launch the agent.");
    return undefined;
  }

  runtime.launchesInFlight.add(context.paneId);
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
      : nonFocusableStationTerminalForWorktree(runtime.dashboardRuntime, target.worktreeId);
  if (nonFocusableStation !== undefined) {
    return {
      kind: "notice",
      message: `${nonFocusableStation.label}: Station has no attachable host PTY for this existing agent.`,
    };
  }
  const externalProvider =
    runtime.dashboardRuntime === undefined
      ? undefined
      : externalTerminalProviderForWorktree(runtime.dashboardRuntime, target.worktreeId);
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
      const createTerminal = await runtime.managedTerminalAttacher.resolve(prepared.attachment);
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
): Promise<void> {
  switch (action.kind) {
    case "open-pane":
      // Registry seeding must precede pane publication so first render cannot spawn defaults.
      if (action.createTerminal === undefined) {
        runtime.registry?.ensure(context.paneId, action.spawnOptions);
      } else {
        runtime.registry?.ensure(context.paneId, action.spawnOptions, action.createTerminal);
      }
      runtime.store.actions.createPane(context.paneId, { role: "primary-agent" });
      runtime.store.actions.setPrimaryAgent(context.paneId, action.identity);
      if (context.landInPane) {
        await landOnPane(runtime, service, context.turnReadiness);
      }
      return;
    case "focus-existing":
      if (
        context.landInPane &&
        (await focusExistingSession(runtime, service, action.sessionId))
      ) {
        await landOnPane(runtime, service, context.turnReadiness);
      }
      return;
    case "notice":
      pushToast(runtime, action.message, "info");
      return;
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
      await performPreparedAction(runtime, context, service, action);
    }
    return SETTLED_RESULT;
  } finally {
    runtime.launchesInFlight.delete(paneId);
  }
}

/**
 * Creates one managed-launch runner whose phases preserve registry-before-pane publication,
 * apply output compatibility only to local spawns, and treat every advertised attachment as a
 * no-local-fallback commitment.
 */
export function createManagedLaunchAttempt(
  deps: ManagedLaunchAttemptDeps,
): (paneId: PaneId, target: ManagedLaunchTarget) => Promise<ManagedLaunchAttemptResult> {
  const runtime: ManagedLaunchRuntime = {
    ...deps,
    launchesInFlight: new Set<PaneId>(),
  };
  return (paneId, target) => runManagedLaunchAttempt(runtime, paneId, target);
}
