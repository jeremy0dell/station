import type { ObserverService, StationClientStateSource } from "@station/client";
import type { SafeError } from "@station/contracts";
import {
  createObserverActivationCapabilities,
  dashboardExecution,
  type DashboardCapabilities,
  type DashboardExecutionHandle,
  type DashboardExecutionResult,
} from "@station/dashboard-core";
import type { StationStore } from "../state/store.js";
import { agentWorktreePaneId, projectPaneId, worktreePaneId } from "../state/types.js";
import type { ManagedLaunch, ManagedLaunchResult } from "../input/runtime/managedLaunch.js";
import type { PaneEffects } from "../input/runtime/paneEffects.js";

/** Native composition inputs for semantic dashboard execution. */
export type CreateNativeDashboardCapabilitiesOptions = {
  clientState: StationClientStateSource;
  observerService: ObserverService;
  store: StationStore;
  paneEffects: PaneEffects;
  managedLaunch: ManagedLaunch;
};

const STALE_TARGET_NOTICE = "That dashboard item is no longer available.";

/**
 * Compose native dashboard capabilities from canonical client state, workspace
 * pane authority, and promise-based managed-launch execution.
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
        if (session === undefined || row === undefined) {
          return dashboardExecution(staleTargetResult());
        }
        if (session.origin === "external") {
          return observerActivation.activate(request);
        }
        return dashboardExecution(
          options.managedLaunch
            .activate(agentWorktreePaneId(row.id), {
              projectId: row.projectId,
              worktreeId: row.id,
              cwd: row.path,
            })
            .then((result) => settleNativeActivation(options.store, result)),
          {
            optimistic:
              request.preferredObserverAction === "focus" ? "none" : "pending-start",
            successDisposition: "wait-for-canonical",
          },
        );
      },
    },
    managedSessions: {
      create: (request) =>
        managedSessionExecution(
          options.managedLaunch.create({
            projectId: request.project.id,
            title: request.title,
            branch: request.hiddenBranch,
            harness: request.harness,
          }),
        ),
      quickCreate: (request) =>
        managedSessionExecution(
          options.managedLaunch.create({
            projectId: request.project.id,
            title: request.title,
            branch: request.hiddenBranch,
            harness: request.harness,
          }),
        ),
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
          }),
        );
      },
    },
    shell: {
      open: (request) => {
        const snapshot = options.clientState.getState().snapshot;
        if (request.kind === "project") {
          const project = snapshot?.projects.find((candidate) => candidate.id === request.projectId);
          if (project === undefined) {
            return dashboardExecution(staleTargetResult());
          }
          options.paneEffects.openPane(projectPaneId(project.id), {
            cwd: project.root,
            role: "shell",
          });
          return dashboardExecution({ kind: "success" });
        }
        const session = snapshot?.sessions.find((candidate) => candidate.id === request.sessionId);
        const row = snapshot?.rows.find(
          (candidate) => candidate.id === session?.worktreeId,
        );
        if (session === undefined || row === undefined) {
          return dashboardExecution(staleTargetResult());
        }
        options.paneEffects.openPane(worktreePaneId(row.id), {
          cwd: row.path,
          role: "shell",
          worktreeId: row.id,
        });
        return dashboardExecution({ kind: "success" });
      },
    },
    dismissal: {
      dismissDashboard: () => {
        options.store.actions.closeOverlay();
        return dashboardExecution({ kind: "success" });
      },
      exitRenderer: () => {
        options.store.actions.closeOverlay();
        return dashboardExecution({ kind: "success" });
      },
    },
  };
}

function settleNativeActivation(
  store: StationStore,
  result: ManagedLaunchResult,
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
  return { kind: "failure", error: result.error, disposition: "remove-immediately" };
}

function managedSessionExecution(
  completion: Promise<ManagedLaunchResult>,
): DashboardExecutionHandle {
  return dashboardExecution(
    completion.then((result): DashboardExecutionResult => {
      if (result.kind === "success") {
        return { kind: "success" };
      }
      if (result.kind === "notice") {
        return result;
      }
      return {
        kind: "failure",
        error: result.error,
        disposition: result.stage === "launch" ? "retain-failed" : "remove-immediately",
      };
    }),
    { optimistic: "pending-create", successDisposition: "wait-for-canonical" },
  );
}

function managedSessionFailure(error: SafeError): DashboardExecutionHandle {
  return dashboardExecution(
    { kind: "failure", error, disposition: "remove-immediately" },
    { optimistic: "pending-create", successDisposition: "wait-for-canonical" },
  );
}

function staleTargetResult(): DashboardExecutionResult {
  return { kind: "notice", notice: { kind: "info", message: STALE_TARGET_NOTICE } };
}
