import type { ProviderId, SafeError } from "@station/contracts";
import {
  createNewSessionNameToken,
  generatedSessionBranch,
  resolveNewSessionProjectAvailability,
} from "../../flows/newSession.js";
import { safeErrorToToast } from "../../services/errors/errors.js";
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
