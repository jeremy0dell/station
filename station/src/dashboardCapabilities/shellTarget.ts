import type { StationClientStateSource } from "@station/client";
import type { ProjectView, WorktreeRow } from "@station/contracts";
import type { ClientNotice, OpenDashboardShellRequest } from "@station/dashboard-core";

/** Shared stale-identity feedback for renderer shell adapters. */
export const STALE_DASHBOARD_TARGET_NOTICE = {
  kind: "info",
  message: "That dashboard item is no longer available.",
} as const satisfies ClientNotice;

/** Canonical entity selected for renderer-owned shell execution. */
export type DashboardShellTarget =
  | { kind: "project"; project: ProjectView }
  | { kind: "session"; worktree: WorktreeRow };

/** Resolve a stable shell identity against the latest canonical client state. */
export function resolveDashboardShellTarget(
  source: StationClientStateSource,
  request: OpenDashboardShellRequest,
): DashboardShellTarget | undefined {
  const snapshot = source.getState().snapshot;
  if (request.kind === "project") {
    const project = snapshot?.projects.find((candidate) => candidate.id === request.projectId);
    return project === undefined ? undefined : { kind: "project", project };
  }
  const session = snapshot?.sessions.find((candidate) => candidate.id === request.sessionId);
  const worktree = snapshot?.rows.find((candidate) => candidate.id === session?.worktreeId);
  return session === undefined || worktree === undefined
    ? undefined
    : { kind: "session", worktree };
}
