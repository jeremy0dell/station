import {
  isRunningAgentState,
  type ProviderProjectConfig,
  type RemoveWorktreePayload,
  type TraceContext,
  type WorktreeRow,
} from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { StationLogger } from "../../stationLogger.js";
import {
  assertWorktreeRemovalAllowed,
  resolveWorktreeRemovalTarget,
  resolveWorktreeRowOrThrow,
  type VerifiedWorktreeRemovalTarget,
} from "../cleanup/index.js";
import { findProjectOrThrow, runProviderMutation, throwIfAborted } from "../session/shared.js";

export type WorktreeRemovalValidation = {
  row: WorktreeRow;
  project: ProviderProjectConfig;
  target: VerifiedWorktreeRemovalTarget;
  previousSessionId: string | undefined;
  force: boolean;
  externalTerminalExitRequired: boolean;
};

export type WorktreeRemovalValidationOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  core: ObserverCore;
  clock?: RuntimeClock | undefined;
  logger?: StationLogger | undefined;
};

export type WorktreeRemovalValidationRuntime = {
  signal: AbortSignal;
  trace: TraceContext;
  commandId?: string | undefined;
};

/** Revalidate checkout identity and destructive guards before any terminal or harness mutation. */
export async function validateWorktreeRemoval(
  options: WorktreeRemovalValidationOptions,
  payload: RemoveWorktreePayload,
  runtime: WorktreeRemovalValidationRuntime,
): Promise<WorktreeRemovalValidation> {
  throwIfAborted(runtime.signal);
  const snapshot = options.core.getSnapshot();
  const row = resolveWorktreeRowOrThrow(snapshot, payload.worktreeId, payload.projectId);
  const projectView = snapshot.projects.find((candidate) => candidate.id === row.projectId);
  const project = findProjectOrThrow(options.getProjects(), row.projectId);
  const stationSession = snapshot.sessions.find(
    (session) => session.origin === "station" && session.worktreeId === row.id,
  );
  const previousSessionId = stationSession?.id ?? row.agent?.sessionId;
  const force = payload.force === true;
  const currentWorktrees = await runProviderMutation(
    {
      operation: `provider.${options.providers.worktree.id}.listWorktrees.removeRevalidation`,
      clock: options.clock,
      signal: runtime.signal,
      trace: runtime.trace,
      fallback: {
        tag: "WorktreeProviderError",
        code: "WORKTREE_REMOVE_REVALIDATION_FAILED",
        message: "Station could not refresh worktree evidence before removal.",
        provider: options.providers.worktree.id,
      },
    },
    () => options.providers.worktree.listWorktrees(project),
  );
  throwIfAborted(runtime.signal);
  const resolution = resolveWorktreeRemovalTarget({
    payload,
    snapshotRow: row,
    project,
    currentWorktrees,
  });
  if (!resolution.ok) {
    const attributes: Record<string, unknown> = {
      traceId: runtime.trace.traceId,
      projectId: row.projectId,
      worktreeId: row.id,
      canonicalPath: resolution.canonicalPath,
      observedBranch: resolution.observedBranch,
      refusalReason: resolution.refusalReason,
    };
    if (runtime.commandId !== undefined) attributes.commandId = runtime.commandId;
    await options.logger?.warn("Worktree removal refused.", attributes);
    throw resolution.error;
  }
  assertWorktreeRemovalAllowed(row, force, projectView, resolution.target);
  const externalTerminalExitRequired =
    stationSession !== undefined &&
    isRunningAgentState(row.agent?.state) &&
    row.terminal?.closeable !== true;
  return {
    row,
    project,
    target: resolution.target,
    previousSessionId,
    force,
    externalTerminalExitRequired,
  };
}

/** Refresh only canonical runtime state after a reserved renderer settlement. */
export function refreshReservedWorktreeRemoval(
  options: Pick<WorktreeRemovalValidationOptions, "core">,
  payload: RemoveWorktreePayload,
  validation: WorktreeRemovalValidation,
): WorktreeRemovalValidation {
  const snapshot = options.core.getSnapshot();
  const row = resolveWorktreeRowOrThrow(snapshot, payload.worktreeId, validation.project.id);
  const resolution = resolveWorktreeRemovalTarget({
    payload,
    snapshotRow: row,
    project: validation.project,
    currentWorktrees: [validation.target],
  });
  if (!resolution.ok) throw resolution.error;
  const projectView = snapshot.projects.find((candidate) => candidate.id === row.projectId);
  assertWorktreeRemovalAllowed(row, validation.force, projectView, validation.target);
  const stationSession = snapshot.sessions.find(
    (session) => session.origin === "station" && session.worktreeId === row.id,
  );
  return {
    ...validation,
    row,
    previousSessionId: stationSession?.id ?? row.agent?.sessionId ?? validation.previousSessionId,
    externalTerminalExitRequired:
      stationSession !== undefined &&
      isRunningAgentState(row.agent?.state) &&
      row.terminal?.closeable !== true,
  };
}
