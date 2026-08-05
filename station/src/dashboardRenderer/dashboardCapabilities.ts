import { toSafeError, type ObserverService, type StationClientStateSource } from "@station/client";
import {
  createObserverActivationCapabilities,
  createObserverManagedSessionCapabilities,
  dashboardExecution,
} from "@station/dashboard-core";
import type {
  DashboardCapabilities,
  DashboardExecutionResult,
  OpenDashboardShellRequest,
} from "@station/dashboard-core";
import {
  resolveDashboardShellTarget,
  STALE_DASHBOARD_TARGET_NOTICE,
} from "../dashboardCapabilities/shellTarget.js";
import type { PopupRuntime } from "./popupRuntime.js";

/** Standalone composition inputs for semantic dashboard execution. */
export type CreateStandaloneDashboardCapabilitiesOptions = {
  clientState: StationClientStateSource;
  observerService: ObserverService;
  popupRuntime: PopupRuntime;
  exitRenderer(exitCode: number): void;
};

/**
 * Compose standalone dashboard capabilities from Observer execution, canonical
 * client state, popup renderer authority, and process lifecycle control.
 */
export function createDashboardCapabilities(
  options: CreateStandaloneDashboardCapabilitiesOptions,
): DashboardCapabilities {
  const onFocusSuccess = options.popupRuntime.exitOnFocusSuccess
    ? async (): Promise<void> => {
        options.exitRenderer(0);
      }
    : undefined;
  const activationOptions: Parameters<typeof createObserverActivationCapabilities>[0] = {
    source: options.clientState,
    service: options.observerService,
    clientLabel: "station",
    waitForFocusCompletion:
      options.popupRuntime.persistentPopup || options.popupRuntime.exitOnFocusSuccess,
  };
  if (options.popupRuntime.focusOrigin !== undefined) {
    activationOptions.focusOrigin = options.popupRuntime.focusOrigin;
  }
  if (options.popupRuntime.resolveFocusTarget !== undefined) {
    activationOptions.resolveFocusTarget = options.popupRuntime.resolveFocusTarget;
  }
  if (onFocusSuccess !== undefined) {
    activationOptions.onFocusSuccess = onFocusSuccess;
  }

  const managedOptions: Parameters<typeof createObserverManagedSessionCapabilities>[0] = {
    service: options.observerService,
    clientLabel: "station",
  };
  if (options.popupRuntime.focusOrigin !== undefined) {
    managedOptions.focusOrigin = options.popupRuntime.focusOrigin;
  }
  if (options.popupRuntime.resolveFocusTarget !== undefined) {
    managedOptions.resolveFocusTarget = options.popupRuntime.resolveFocusTarget;
  }

  return {
    activation: createObserverActivationCapabilities(activationOptions),
    managedSessions: createObserverManagedSessionCapabilities(managedOptions),
    shell: {
      open: (request) => dashboardExecution(openShell(options, request)),
    },
    dismissal: {
      dismissDashboard: () => {
        const dismiss = options.popupRuntime.dismissDashboard;
        return dismiss === undefined
          ? dashboardExecution({ kind: "success" })
          : dashboardExecution(runRendererEffect(dismiss, "station"));
      },
      exitRenderer: ({ exitCode }) => {
        const dismiss = options.popupRuntime.persistentPopup
          ? options.popupRuntime.dismissDashboard
          : undefined;
        if (dismiss !== undefined) {
          return dashboardExecution(runRendererEffect(dismiss, "station"));
        }
        options.exitRenderer(exitCode);
        return dashboardExecution({ kind: "success" });
      },
    },
  };
}

async function openShell(
  options: CreateStandaloneDashboardCapabilitiesOptions,
  request: OpenDashboardShellRequest,
): Promise<DashboardExecutionResult> {
  const target = resolveDashboardShellTarget(options.clientState, request);
  if (target === undefined) {
    return { kind: "notice", notice: STALE_DASHBOARD_TARGET_NOTICE };
  }
  const cwd = target.kind === "project" ? target.project.root : target.worktree.path;
  const open = options.popupRuntime.openShell;
  if (open === undefined) {
    return {
      kind: "failure",
      disposition: "remove-immediately",
      error: {
        tag: "TuiRendererControlError",
        code: "TUI_SHELL_UNAVAILABLE",
        message: "Opening a shell is unavailable outside native Station or a tmux popup.",
      },
    };
  }
  try {
    await open(cwd);
    return { kind: "success" };
  } catch (error: unknown) {
    return {
      kind: "failure",
      disposition: "remove-immediately",
      error: toSafeError(error, { clientLabel: "station" }),
    };
  }
}

async function runRendererEffect(
  effect: () => Promise<void>,
  clientLabel: string,
): Promise<DashboardExecutionResult> {
  try {
    await effect();
    return { kind: "success" };
  } catch (error: unknown) {
    return {
      kind: "failure",
      disposition: "remove-immediately",
      error: toSafeError(error, { clientLabel }),
    };
  }
}
