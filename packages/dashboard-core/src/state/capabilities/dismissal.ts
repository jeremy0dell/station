import type { DashboardExecutionHandle } from "./execution.js";

/** Renderer exit request carrying the process-style completion code selected by the dashboard. */
export type DashboardRendererExitRequest = { exitCode: number };

/** Renderer-selected authority for dashboard dismissal and renderer exit. */
export type DashboardDismissalCapabilities = {
  /** Dismiss the current dashboard claim or overlay without terminating its renderer. */
  dismissDashboard(): DashboardExecutionHandle;
  /** Exit or otherwise close the renderer surface according to renderer ownership. */
  exitRenderer(request: DashboardRendererExitRequest): DashboardExecutionHandle;
};
