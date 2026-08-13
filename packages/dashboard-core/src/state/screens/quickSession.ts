import type { ProviderId, SafeError, SessionGroupId } from "@station/contracts";
import {
  createNewSessionNameToken,
  generatedSessionBranch,
  resolveNewSessionProjectAvailability,
} from "../../flows/newSession.js";
import { safeErrorToToast } from "../../services/errors/errors.js";
import type { CreateQuickSessionInGroupOperation } from "../operations/types.js";
import { addTuiToast } from "../toasts.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardState, DashboardStateView } from "../types.js";

export type QuickSessionIntent = {
  projectId: string;
  title: string;
  branch: string;
  harnessProvider: ProviderId;
  token: string;
};

export type QuickSessionResolution =
  | ({ kind: "submit" } & QuickSessionIntent)
  | { kind: "blocked"; error: SafeError }
  | { kind: "missing" };

export type QuickSessionInGroupResolution =
  | { kind: "submit"; operation: CreateQuickSessionInGroupOperation }
  | { kind: "blocked"; error: SafeError }
  | { kind: "missing" };

/** Resolves a quick session as submit, blocked with its exact provider error, or missing. */
export function resolveQuickSessionIntent(
  state: DashboardStateView,
  projectId: string,
): QuickSessionResolution {
  if (state.snapshot === undefined) return { kind: "missing" };
  const resolution = resolveNewSessionProjectAvailability(
    state.snapshot.projects.find((candidate) => candidate.id === projectId),
  );
  if (resolution.kind !== "available") return resolution;
  const project = resolution.project;
  const token = createNewSessionNameToken();
  const branch = generatedSessionBranch(project.id, token);
  return {
    kind: "submit",
    projectId: project.id,
    title: branch,
    branch,
    harnessProvider: project.defaults.harness,
    token,
  };
}

/**
 * Resolves Quick Session availability and emits the same semantic operation for
 * pointer, direct-key, and focused activation paths.
 */
export function submitQuickSession(state: DashboardState, projectId: string): TuiTransition {
  const resolution = resolveQuickSessionIntent(state, projectId);
  if (resolution.kind === "missing") return { state };
  if (resolution.kind === "blocked") {
    return { state: addTuiToast(state, safeErrorToToast(resolution.error)) };
  }
  const project = state.snapshot?.projects.find(
    (candidate) => candidate.id === resolution.projectId,
  );
  if (project === undefined) return { state };

  const { title, branch, harnessProvider, token } = resolution;
  return {
    state,
    operations: [
      {
        type: "quickCreateManagedSession",
        localId: `create:${project.id}:${token}`,
        project,
        title,
        hiddenBranch: branch,
        harness: harnessProvider,
      },
    ],
  };
}

/** Resolves an existing Group header action into one ordinary Quick Session placement operation. */
export function resolveQuickSessionInGroupOperation(
  state: DashboardStateView,
  groupId: SessionGroupId,
  fallbackCell: CreateQuickSessionInGroupOperation["fallbackCell"],
): QuickSessionInGroupResolution {
  const group = state.snapshot?.sessionGroups.find((candidate) => candidate.id === groupId);
  if (group === undefined) return { kind: "missing" };
  const resolution = resolveQuickSessionIntent(state, group.projectId);
  if (resolution.kind !== "submit") return resolution;
  const project = state.snapshot?.projects.find(
    (candidate) => candidate.id === resolution.projectId,
  );
  if (project === undefined) return { kind: "missing" };
  return {
    kind: "submit",
    operation: {
      type: "quickCreateSessionInGroup",
      localId: `create:${project.id}:${resolution.token}`,
      project,
      groupId,
      title: resolution.title,
      hiddenBranch: resolution.branch,
      harness: resolution.harnessProvider,
      fallbackCell,
    },
  };
}

/** Validates and submits the Quick Session action owned by an existing Group header. */
export function submitQuickSessionInGroup(
  state: DashboardState,
  groupId: SessionGroupId,
): TuiTransition {
  const resolution = resolveQuickSessionInGroupOperation(state, groupId, "quickSession");
  if (resolution.kind === "missing") return { state };
  if (resolution.kind === "blocked") {
    return { state: addTuiToast(state, safeErrorToToast(resolution.error)) };
  }
  const collapsedGroupIds = new Set(state.collapsedGroupIds);
  collapsedGroupIds.delete(groupId);
  return {
    state:
      collapsedGroupIds.size === state.collapsedGroupIds.size
        ? state
        : { ...state, collapsedGroupIds },
    operations: [resolution.operation],
  };
}
