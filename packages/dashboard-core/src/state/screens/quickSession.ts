import type { ProviderId } from "@station/contracts";
import { createNewSessionNameToken, generatedSessionBranch } from "../../flows/newSession.js";
import { buildCreateSessionCommand } from "../commandBuilders.js";
import { addPendingCreateSessionRow } from "../localRows.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

export type QuickSessionIntent = {
  projectId: string;
  branch: string;
  harnessProvider: ProviderId;
  token: string;
};

/** Resolves the project-owned defaults for a quick session before terminal-specific execution. */
export function resolveQuickSessionIntent(
  state: TuiState,
  projectId: string,
): QuickSessionIntent | undefined {
  const project = state.snapshot?.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined || project.health.status === "unavailable") return undefined;
  const token = createNewSessionNameToken();
  return {
    projectId: project.id,
    branch: generatedSessionBranch(project.id, token),
    harnessProvider: project.defaults.harness,
    token,
  };
}

/** Builds the immediate configured-terminal transition for a resolved quick-session intent. */
export function submitQuickSession(state: TuiState, projectId: string): TuiTransition {
  const intent = resolveQuickSessionIntent(state, projectId);
  if (intent === undefined) return { state };
  const project = state.snapshot?.projects.find((candidate) => candidate.id === intent.projectId);
  if (project === undefined) return { state };

  const { branch, harnessProvider, token } = intent;
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
