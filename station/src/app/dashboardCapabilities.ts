import type { ClientNotice, ObserverService, StationClientStateSource } from "@station/client";
import { type SafeError, worktreeHasLiveAgent } from "@station/contracts";
import {
  createObserverActivationCapabilities,
  createObserverWorktreeRemovalCapabilities,
  dashboardExecution,
} from "@station/dashboard-core/runtime";
import type {
  CreatedSessionUiCommand,
  CreatedSessionUiPolicy,
  DashboardCapabilities,
  DashboardExecutionHandle,
  DashboardExecutionResult,
} from "@station/dashboard-core/runtime";
import {
  resolveDashboardShellTarget,
  STALE_DASHBOARD_TARGET_NOTICE,
} from "../dashboardCapabilities/shellTarget.js";
import type { StationStore } from "../state/store.js";
import { agentWorktreePaneId, projectPaneId, worktreePaneId } from "../state/types.js";
import type { ManagedLaunch, ManagedLaunchResult } from "../input/runtime/managedLaunch.js";
import type { PaneEffects } from "../input/runtime/paneEffects.js";
import {
  findSessionPlacementByBranch,
  waitForSessionPlacementByBranch,
} from "../input/runtime/stationRows.js";
import type { PtyRegistry } from "../terminal/registry/ptyRegistry.js";
import {
  finalizeNativeWorktreeRemoval,
  prepareNativeWorktreeRemoval,
} from "./nativeWorktreeRemoval.js";

const SESSION_PLACEMENT_UNCONFIRMED_NOTICE = {
  kind: "error",
  message: "The session was created, but Station could not confirm its Group placement.",
  hint: "Refresh the dashboard before creating another session.",
} satisfies ClientNotice;

/** Native composition inputs for semantic dashboard execution. */
export type CreateNativeDashboardCapabilitiesOptions = {
  clientState: StationClientStateSource;
  observerService: ObserverService;
  store: StationStore;
  paneEffects: PaneEffects;
  registry: PtyRegistry;
  managedLaunch: ManagedLaunch;
  /** Fully resolved native policy; capability composition receives no raw config. */
  createdSessionPolicy: CreatedSessionUiPolicy;
};

/**
 * Compose native dashboard capabilities from canonical client state, workspace pane authority,
 * promise-based managed launch, and relationship-complete deliberate-create settlement.
 */
export function createDashboardCapabilities(
  options: CreateNativeDashboardCapabilitiesOptions,
): DashboardCapabilities {
  const observerActivation = createObserverActivationCapabilities({
    source: options.clientState,
    service: options.observerService,
    clientLabel: "Station",
    waitForFocusCompletion: true,
    onFocusSuccess: async () => {
      options.store.actions.closeOverlay();
    },
  });
  const runManagedSessionCreate = (
    request: Parameters<DashboardCapabilities["managedSessions"]["create"]>[0],
  ): Promise<ManagedLaunchResult> =>
    options.managedLaunch.create({
      projectId: request.project.id,
      title: request.title,
      branch: request.hiddenBranch,
      harness: request.harness,
      ...(request.group === undefined ? {} : { group: request.group }),
    });
  const createManagedSession: DashboardCapabilities["managedSessions"]["create"] = (request) =>
    dashboardExecution(
      runManagedSessionCreate(request).then(async (result): Promise<DashboardExecutionResult> => {
        if (result.kind === "failure") return managedSessionResult(result);
        if (result.kind === "notice") return { kind: "success", notice: result.notice };
        return resolveNativeCreatedSessionCommand(options, request);
      }),
      { successDisposition: "wait-for-canonical" },
    );
  const quickCreateManagedSession: DashboardCapabilities["managedSessions"]["quickCreate"] = (
    request,
  ) =>
    dashboardExecution(
      runManagedSessionCreate(request).then(async (result): Promise<DashboardExecutionResult> => {
        if (result.kind !== "success") return managedSessionResult(result);
        return resolveNativeCreatedSessionCommand(options, request);
      }),
      { optimistic: "pending-create", successDisposition: "wait-for-canonical" },
    );
  const closeDashboard: DashboardCapabilities["dismissal"]["dismissDashboard"] = () => {
    options.store.actions.closeOverlay();
    return dashboardExecution({ kind: "success" });
  };

  return {
    activation: {
      activate: (request) => {
        // Stable row identities are revalidated against canonical client state before native mechanics.
        const snapshot = options.clientState.getState().snapshot;
        const session = snapshot?.sessions.find(
          (candidate) =>
            candidate.id === request.sessionId &&
            candidate.projectId === request.projectId &&
            candidate.worktreeId === request.worktreeId,
        );
        const row = snapshot?.rows.find(
          (candidate) =>
            candidate.id === request.worktreeId &&
            candidate.projectId === request.projectId &&
            candidate.branch === request.branch,
        );
        if (
          session === undefined ||
          row === undefined ||
          (request.preferredObserverAction === "fresh" &&
            (session.origin !== "station" ||
              worktreeHasLiveAgent(row) ||
              row.recovery !== undefined))
        ) {
          return dashboardExecution(staleTargetResult());
        }
        if (session.origin === "external") {
          return observerActivation.activate(request);
        }
        const launched = options.managedLaunch.activate(agentWorktreePaneId(row.id), {
          projectId: row.projectId,
          worktreeId: row.id,
          cwd: row.path,
          ...(request.preferredObserverAction === "fresh"
            ? { freshStart: { expectedSessionId: session.id } }
            : {}),
        });
        return dashboardExecution(
          launched.then((result) => settleNativeActivation(options.store, result, session.title)),
          {
            optimistic: request.preferredObserverAction === "focus" ? "none" : "pending-start",
            successDisposition: "wait-for-canonical",
          },
        );
      },
    },
    createdSession: {
      applyUiPolicy: (command) => applyNativeCreatedSessionPolicy(options, command),
    },
    managedSessions: {
      create: createManagedSession,
      quickCreate: quickCreateManagedSession,
      fork: (request) => {
        if (request.inheritedHarness === undefined) {
          return managedSessionFailure({
            tag: "CommandValidationError",
            code: "HARNESS_PROVIDER_UNAVAILABLE",
            message: "Station could not resolve a harness for the fork.",
            hint: "Configure a project default harness and retry.",
          });
        }
        return managedSessionExecution(
          options.managedLaunch.fork({
            projectId: request.project.id,
            sourceWorktreeId: request.sourceWorktreeId,
            title: request.title,
            branch: request.hiddenBranch,
            copyDirty: request.copyDirty,
            harness: request.inheritedHarness,
            ...(request.group === undefined ? {} : { group: request.group }),
          }),
        );
      },
    },
    worktreeRemoval: createObserverWorktreeRemovalCapabilities({
      service: options.observerService,
      clientLabel: "Station",
      beforeRemove: (request) =>
        prepareNativeWorktreeRemoval(
          {
            service: options.observerService,
            clientState: options.clientState,
            store: options.store,
            registry: options.registry,
          },
          request.worktreeId,
        ),
      afterRemove: (request) =>
        finalizeNativeWorktreeRemoval({ store: options.store }, request.worktreeId),
    }),
    shell: {
      open: (request) => {
        const target = resolveDashboardShellTarget(options.clientState, request);
        if (target === undefined) {
          return dashboardExecution(staleTargetResult());
        }
        if (target.kind === "project") {
          options.paneEffects.openPane(projectPaneId(target.project.id), {
            cwd: target.project.root,
            role: "shell",
          });
        } else {
          options.paneEffects.openPane(worktreePaneId(target.worktree.id), {
            cwd: target.worktree.path,
            role: "shell",
            worktreeId: target.worktree.id,
          });
        }
        return dashboardExecution({ kind: "success" });
      },
    },
    dismissal: {
      dismissDashboard: closeDashboard,
      exitRenderer: closeDashboard,
    },
  };
}

async function resolveNativeCreatedSessionCommand(
  options: CreateNativeDashboardCapabilitiesOptions,
  request: Parameters<DashboardCapabilities["managedSessions"]["create"]>[0],
): Promise<DashboardExecutionResult> {
  const observed = await waitForSessionPlacementByBranch(
    options.clientState,
    request.project.id,
    request.hiddenBranch,
    request.group,
  );
  if (observed !== undefined) {
    const command = nativeCreatedSessionCommand(
      options.clientState.getState().snapshot,
      request,
      observed.id,
      options.createdSessionPolicy,
    );
    if (command !== undefined) return { kind: "success", createdSessionCommand: command };
  }

  try {
    const refreshed = await options.observerService.loadSnapshot();
    const placed = findSessionPlacementByBranch(
      refreshed,
      request.project.id,
      request.hiddenBranch,
      request.group,
    );
    const command =
      placed === undefined
        ? undefined
        : nativeCreatedSessionCommand(
            refreshed,
            request,
            placed.id,
            options.createdSessionPolicy,
          );
    if (command !== undefined) return { kind: "success", createdSessionCommand: command };
  } catch {
    // Launch already succeeded, so refresh failure must not make Create retryable.
  }
  return { kind: "success", notice: SESSION_PLACEMENT_UNCONFIRMED_NOTICE };
}

function nativeCreatedSessionCommand(
  snapshot: ReturnType<StationClientStateSource["getState"]>["snapshot"],
  request: Parameters<DashboardCapabilities["managedSessions"]["create"]>[0],
  sessionId: string,
  policy: CreatedSessionUiPolicy,
): CreatedSessionUiCommand | undefined {
  const session = snapshot?.sessions.find(
    (candidate) =>
      candidate.id === sessionId && candidate.projectId === request.project.id,
  );
  const row = snapshot?.rows.find(
    (candidate) =>
      candidate.id === session?.worktreeId &&
      candidate.projectId === request.project.id &&
      candidate.branch === request.hiddenBranch,
  );
  if (session === undefined || row === undefined) return undefined;
  return {
    type: "createdSession.applyUiPolicy",
    target: {
      sessionId: session.id,
      projectId: session.projectId,
      worktreeId: session.worktreeId,
      branch: row.branch,
      terminalProvider: "native",
    },
    policy,
  };
}

async function applyNativeCreatedSessionPolicy(
  options: CreateNativeDashboardCapabilitiesOptions,
  command: CreatedSessionUiCommand,
): Promise<DashboardExecutionResult> {
  if (!command.policy.focusCreatedSession) {
    if (command.policy.dismissDashboard) options.store.actions.closeOverlay();
    return { kind: "success" };
  }

  const snapshot = options.clientState.getState().snapshot;
  const session = snapshot?.sessions.find(
    (candidate) =>
      candidate.id === command.target.sessionId &&
      candidate.projectId === command.target.projectId &&
      candidate.worktreeId === command.target.worktreeId,
  );
  const row = snapshot?.rows.find(
    (candidate) =>
      candidate.id === command.target.worktreeId &&
      candidate.projectId === command.target.projectId &&
      candidate.branch === command.target.branch,
  );
  if (
    command.target.terminalProvider !== "native" ||
    session === undefined ||
    session.terminal?.provider !== "native" ||
    row === undefined
  ) {
    return createdSessionFailure(
      "CREATED_SESSION_TARGET_MISMATCH",
      "The created session no longer matches its canonical native pane.",
    );
  }
  const result = await options.managedLaunch.activate(agentWorktreePaneId(row.id), {
    projectId: row.projectId,
    worktreeId: row.id,
    cwd: row.path,
  });
  if (result.kind === "failure") {
    return { kind: "failure", error: result.error, disposition: "remove-immediately" };
  }
  if (result.kind === "notice") {
    return createdSessionFailure("CREATED_SESSION_ACTIVATION_FAILED", result.notice.message);
  }
  if (!result.landed) {
    return createdSessionFailure(
      "CREATED_SESSION_ACTIVATION_UNCONFIRMED",
      "Station could not confirm that the created session was opened.",
    );
  }
  if (command.policy.dismissDashboard) options.store.actions.closeOverlay();
  return { kind: "success" };
}

function createdSessionFailure(code: string, message: string): DashboardExecutionResult {
  return {
    kind: "failure",
    disposition: "remove-immediately",
    error: {
      tag: "TuiCreatedSessionError",
      code,
      message,
      hint: "The session was created successfully and remains available in the dashboard.",
    },
  };
}

function settleNativeActivation(
  store: StationStore,
  result: ManagedLaunchResult,
  sessionTitle: string,
): DashboardExecutionResult {
  if (result.kind === "success") {
    if (result.landed) {
      store.actions.closeOverlay();
    }
    return { kind: "success" };
  }
  if (result.kind === "notice") {
    return result;
  }
  if (
    result.error.tag === "TimeoutError" &&
    result.error.code === "CLIENT_PREPARE_EXTERNAL_LAUNCH_TIMEOUT"
  ) {
    return {
      kind: "success",
      notice: {
        kind: "info",
        message: `Session "${sessionTitle}" may still be starting. Station is waiting for Observer state before allowing another launch.`,
      },
    };
  }
  return {
    kind: "failure",
    error: {
      ...result.error,
      message: `Could not open session "${sessionTitle}". ${result.error.message}`,
    },
    disposition: "remove-immediately",
  };
}

function managedSessionExecution(
  completion: Promise<ManagedLaunchResult>,
): DashboardExecutionHandle {
  return dashboardExecution(
    completion.then(managedSessionResult),
    { optimistic: "pending-create", successDisposition: "wait-for-canonical" },
  );
}

function managedSessionResult(result: ManagedLaunchResult): DashboardExecutionResult {
  if (result.kind === "success") return { kind: "success" };
  if (result.kind === "notice") return result;
  return {
    kind: "failure",
    error: result.error,
    disposition: result.stage === "launch" ? "retain-failed" : "remove-immediately",
  };
}

function managedSessionFailure(error: SafeError): DashboardExecutionHandle {
  return dashboardExecution(
    { kind: "failure", error, disposition: "remove-immediately" },
    { optimistic: "pending-create", successDisposition: "wait-for-canonical" },
  );
}

function staleTargetResult(): DashboardExecutionResult {
  return { kind: "notice", notice: STALE_DASHBOARD_TARGET_NOTICE };
}
