import type { ProviderId, SafeError } from "@station/contracts";
import {
  createNewSessionNameToken,
  generatedSessionBranch,
  resolveNewSessionProjectAvailability,
} from "../../flows/newSession.js";
import { safeErrorToToast } from "../../services/errors/errors.js";
import { buildCreateSessionCommand } from "../commandBuilders.js";
import { addPendingCreateSessionRow } from "../localRows.js";
import { addTuiToast } from "../toasts.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

export type QuickSessionIntent = {
  projectId: string;
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
  state: TuiState,
  projectId: string,
): QuickSessionResolution {
  if (state.snapshot === undefined) return { kind: "missing" };
  const resolution = resolveNewSessionProjectAvailability(
    state.snapshot.projects.find((candidate) => candidate.id === projectId),
  );
  if (resolution.kind !== "available") return resolution;
  const project = resolution.project;
  const token = createNewSessionNameToken();
  return {
    kind: "submit",
    projectId: project.id,
    branch: generatedSessionBranch(project.id, token),
    harnessProvider: project.defaults.harness,
    token,
  };
}

/** Builds the immediate configured-terminal transition for a resolved quick-session intent. */
export function submitQuickSession(state: TuiState, projectId: string): TuiTransition {
  const resolution = resolveQuickSessionIntent(state, projectId);
  if (resolution.kind === "missing") return { state };
  if (resolution.kind === "blocked") {
    return { state: addTuiToast(state, safeErrorToToast(resolution.error)) };
  }
  const project = state.snapshot?.projects.find(
    (candidate) => candidate.id === resolution.projectId,
  );
  if (project === undefined) return { state };

  const { branch, harnessProvider, token } = resolution;
  const localId = `create:${project.id}:${token}`;
  const command = buildCreateSessionCommand({ project, branch, harnessProvider });
  if (command.type !== "session.create") {
    return { state };
  }

  return {
    state: addPendingCreateSessionRow(state, {
      localId,
      projectId: project.id,
      branch,
      harnessProvider,
      createdAt: new Date().toISOString(),
    }),
    operations: [
      {
        type: "createSession",
        localId,
        projectId: project.id,
        branch,
        harnessProvider,
        command,
      },
    ],
  };
}
