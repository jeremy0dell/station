/**
 * Role entrypoint: dashboard runtime composition and lifecycle.
 *
 * Construction, capabilities, execution, and the injected service contracts.
 * Renderer compositions build one externally sourced runtime through this
 * surface; internal mutable state and screen machinery stay behind the
 * state entrypoint and the package-internal modules.
 */

export type { TuiFolderService } from "../services/folderService.js";

export type {
  ClientNotice,
  ObserverService,
  StationClientCommandCompletion,
} from "../services/types.js";

export type { DashboardActions } from "../state/actions.js";
export type { DashboardFocusTarget } from "../state/capabilities/activation.js";
export { createObserverActivationCapabilities } from "../state/capabilities/activation.js";
export type {
  DashboardCapabilities,
  DashboardExecutionHandle,
  DashboardExecutionResult,
} from "../state/capabilities/execution.js";
export { dashboardExecution } from "../state/capabilities/execution.js";

export { createObserverManagedSessionCapabilities } from "../state/capabilities/managedSessions.js";

export type { OpenDashboardShellRequest } from "../state/capabilities/shell.js";
export type {
  DashboardRuntime,
  DashboardRuntimeOptions,
  DashboardStateSource,
} from "../state/runtime.js";
export { createDashboardRuntime } from "../state/runtime.js";
