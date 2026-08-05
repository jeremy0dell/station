import type { DashboardExecutionHandle } from "./execution.js";

/** Stable row- or project-scoped shell request resolved by the renderer authority. */
export type OpenDashboardShellRequest =
  | { kind: "project"; projectId: string }
  | { kind: "session"; sessionId: string };

/** Renderer-selected authority for opening dashboard shells. */
export type DashboardShellCapabilities = {
  open(request: OpenDashboardShellRequest): DashboardExecutionHandle;
};
