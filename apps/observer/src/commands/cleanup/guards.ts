import type {
  ProjectView,
  ProviderProjectConfig,
  RemoveWorktreePayload,
  SafeError,
  SessionView,
  WorktreeObservation,
  WorktreeRemovalRefusalDiagnosticDetail,
  WorktreeRemovalRefusalReason,
  WorktreeRow,
} from "@station/contracts";
import { isRunningAgentState, normalizeObservedPath, sameObservedPath } from "@station/contracts";

export type VerifiedWorktreeRemovalTarget = WorktreeObservation & {
  registrationIdentity: string;
};

export type WorktreeRemovalTargetResolution =
  | { ok: true; target: VerifiedWorktreeRemovalTarget }
  | {
      ok: false;
      error: SafeError;
      refusalReason: WorktreeRemovalRefusalReason;
      canonicalPath: string;
      observedBranch: string;
    };

export function resolveWorktreeRemovalTarget(input: {
  payload: RemoveWorktreePayload;
  snapshotRow: WorktreeRow;
  project: ProviderProjectConfig;
  currentWorktrees: readonly WorktreeObservation[];
}): WorktreeRemovalTargetResolution {
  const canonicalExpectedPath = normalizeObservedPath(input.payload.expectedPath);
  if (
    !sameObservedPath(input.snapshotRow.path, canonicalExpectedPath) ||
    input.snapshotRow.branch !== input.payload.expectedBranch ||
    input.snapshotRow.registrationIdentity !== input.payload.expectedRegistrationIdentity
  ) {
    return staleRemovalRefusal({
      payload: input.payload,
      refusalReason: "snapshot_changed",
      canonicalPath: normalizeObservedPath(input.snapshotRow.path),
      observedBranch: input.snapshotRow.branch,
      message: "The selected worktree changed in the observer snapshot before removal began.",
    });
  }

  const projectWorktrees = input.currentWorktrees.filter(
    (candidate) => candidate.projectId === input.project.id,
  );
  const identityMatches = projectWorktrees.filter(
    (candidate) => candidate.id === input.payload.worktreeId,
  );
  const pathMatches = projectWorktrees.filter((candidate) =>
    sameObservedPath(candidate.path, canonicalExpectedPath),
  );

  if (identityMatches.length > 1 || pathMatches.length > 1) {
    return removalRefusal({
      payload: input.payload,
      code: "WORKTREE_REMOVE_TARGET_AMBIGUOUS",
      message: "Station could not uniquely re-resolve the selected worktree.",
      hint: "Refresh the dashboard and reselect the worktree; no cleanup was performed.",
      refusalReason: "ambiguous_identity",
      canonicalPath: canonicalExpectedPath,
      observedBranch: input.payload.expectedBranch,
    });
  }

  const target = identityMatches[0];
  if (target === undefined) {
    const pathMatch = pathMatches[0];
    return staleRemovalRefusal({
      payload: input.payload,
      refusalReason: pathMatch === undefined ? "missing_target" : "identity_changed",
      canonicalPath: normalizeObservedPath(pathMatch?.path ?? canonicalExpectedPath),
      observedBranch: pathMatch?.branch ?? input.payload.expectedBranch,
      message:
        pathMatch === undefined
          ? "The selected worktree is no longer present in current provider evidence."
          : "The selected path now belongs to a different worktree identity.",
    });
  }

  const canonicalCurrentPath = normalizeObservedPath(target.path);
  if (!sameObservedPath(canonicalCurrentPath, canonicalExpectedPath)) {
    return staleRemovalRefusal({
      payload: input.payload,
      refusalReason: "path_changed",
      canonicalPath: canonicalCurrentPath,
      observedBranch: target.branch,
      message: "The selected worktree path changed after it was selected.",
    });
  }
  if (pathMatches[0]?.id !== target.id) {
    return staleRemovalRefusal({
      payload: input.payload,
      refusalReason: "identity_changed",
      canonicalPath: canonicalCurrentPath,
      observedBranch: target.branch,
      message: "The selected path no longer resolves to the same worktree identity.",
    });
  }
  if (target.state !== "exists") {
    return staleRemovalRefusal({
      payload: input.payload,
      refusalReason: "missing_target",
      canonicalPath: canonicalCurrentPath,
      observedBranch: target.branch,
      message: "The selected worktree is no longer an existing checkout.",
    });
  }
  if (target.branch !== input.payload.expectedBranch) {
    return staleRemovalRefusal({
      payload: input.payload,
      refusalReason: "branch_changed",
      canonicalPath: canonicalCurrentPath,
      observedBranch: target.branch,
      message: `The selected worktree changed from branch '${input.payload.expectedBranch}' to '${target.branch}'.`,
    });
  }
  if (target.registrationIdentity === undefined) {
    return staleRemovalRefusal({
      payload: input.payload,
      refusalReason: "registration_unverified",
      canonicalPath: canonicalCurrentPath,
      observedBranch: target.branch,
      message: "Station could not verify the selected checkout's Git registration.",
    });
  }
  const registrationIdentity = target.registrationIdentity;
  if (registrationIdentity !== input.payload.expectedRegistrationIdentity) {
    return staleRemovalRefusal({
      payload: input.payload,
      refusalReason: "registration_changed",
      canonicalPath: canonicalCurrentPath,
      observedBranch: target.branch,
      message: "The selected path now belongs to a different Git checkout registration.",
    });
  }

  if (target.isPrimaryCheckout === true || sameObservedPath(target.path, input.project.root)) {
    return removalRefusal({
      payload: input.payload,
      code: "WORKTREE_ROOT_REMOVAL_NOT_ALLOWED",
      message: "The project root checkout cannot be removed as a worktree.",
      hint: "Close the session without removing the checkout, or choose a managed worktree.",
      refusalReason: "primary_checkout",
      canonicalPath: canonicalCurrentPath,
      observedBranch: target.branch,
    });
  }

  const configuredDefaultBranch = input.project.defaultBranch ?? input.project.worktrunk.base;
  const defaultBranchCandidates =
    configuredDefaultBranch === undefined
      ? []
      : configuredDefaultBranchCandidates(configuredDefaultBranch);
  if (defaultBranchCandidates.includes(target.branch)) {
    return removalRefusal({
      payload: input.payload,
      code: "WORKTREE_DEFAULT_BRANCH_REMOVAL_NOT_ALLOWED",
      message: `The selected checkout currently owns the repository default branch '${target.branch}'.`,
      hint: "Move the default branch back to its protected checkout, refresh, and reselect the disposable worktree.",
      refusalReason: "default_branch",
      canonicalPath: canonicalCurrentPath,
      observedBranch: target.branch,
    });
  }
  if (defaultBranchCandidates.length === 0) {
    return removalRefusal({
      payload: input.payload,
      code: "WORKTREE_REMOVE_PROTECTION_UNVERIFIED",
      message: "Station could not verify which checkout owns the repository default branch.",
      hint: "Configure the project's default branch, refresh, and retry.",
      refusalReason: "protection_unverified",
      canonicalPath: canonicalCurrentPath,
      observedBranch: target.branch,
    });
  }

  return { ok: true, target: { ...target, registrationIdentity } };
}

export function assertWorktreeRemovalAllowed(
  row: WorktreeRow,
  force: boolean,
  project?: ProjectView | undefined,
  current?: WorktreeObservation | undefined,
): void {
  if (project !== undefined && sameObservedPath(current?.path ?? row.path, project.root)) {
    const error: SafeError = {
      tag: "CommandValidationError",
      code: "WORKTREE_ROOT_REMOVAL_NOT_ALLOWED",
      message: "The project root checkout cannot be removed as a worktree.",
      hint: "Close the session without removing the checkout, or choose a managed worktree.",
      projectId: row.projectId,
      worktreeId: row.id,
    };
    if (row.agent?.sessionId !== undefined) error.sessionId = row.agent.sessionId;
    throw error;
  }

  if ((current?.dirty ?? row.worktree.dirty) === true && !force) {
    const error: SafeError = {
      tag: "CommandValidationError",
      code: "WORKTREE_DIRTY_REQUIRES_FORCE",
      message: "This worktree has uncommitted changes and cannot be removed without force.",
      hint: "Review the worktree changes, or confirm the removal with force.",
      projectId: row.projectId,
      worktreeId: row.id,
    };
    throw error;
  }

  if (isRunningAgentState(row.agent?.state) && !force) {
    const error: SafeError = {
      tag: "CommandValidationError",
      code: "WORKTREE_AGENT_ACTIVE_REQUIRES_FORCE",
      message: "This worktree has an active agent and cannot be removed without force.",
      hint: "Close the agent first, or confirm the removal with force.",
      projectId: row.projectId,
      worktreeId: row.id,
    };
    if (row.agent?.sessionId !== undefined) error.sessionId = row.agent.sessionId;
    throw error;
  }
}

export function assertSessionCloseAllowed(
  session: SessionView,
  row: WorktreeRow | undefined,
  force: boolean,
): void {
  if (!isSessionOrRowRunning(session, row) || force) {
    return;
  }
  const error: SafeError = {
    tag: "CommandValidationError",
    code: "SESSION_AGENT_ACTIVE_REQUIRES_FORCE",
    message: "This session has an active agent and cannot be closed without force.",
    hint: "Confirm the close operation with force to stop the active agent.",
    projectId: session.projectId,
    worktreeId: session.worktreeId,
    sessionId: session.id,
  };
  throw error;
}

export function assertTerminalCloseAllowed(
  row: WorktreeRow | undefined,
  session: SessionView | undefined,
  force: boolean,
): void {
  if (!isSessionOrRowRunning(session, row) || force) {
    return;
  }
  const error: SafeError = {
    tag: "CommandValidationError",
    code: "TERMINAL_CLOSE_AGENT_ACTIVE_REQUIRES_FORCE",
    message: "This terminal hosts an active agent and cannot be closed without force.",
    hint: "Confirm the close operation with force to stop or detach the active target.",
  };
  if (session?.projectId !== undefined) error.projectId = session.projectId;
  if (row?.projectId !== undefined) error.projectId = row.projectId;
  if (session?.worktreeId !== undefined) error.worktreeId = session.worktreeId;
  if (row?.id !== undefined) error.worktreeId = row.id;
  if (session?.id !== undefined) error.sessionId = session.id;
  if (row?.agent?.sessionId !== undefined) error.sessionId = row.agent.sessionId;
  throw error;
}

function isSessionOrRowRunning(
  session: SessionView | undefined,
  row: WorktreeRow | undefined,
): boolean {
  return isRunningAgentState(row?.agent?.state ?? session?.status.value);
}

function staleRemovalRefusal(input: {
  payload: RemoveWorktreePayload;
  message: string;
  refusalReason: WorktreeRemovalRefusalReason;
  canonicalPath: string;
  observedBranch: string;
}): WorktreeRemovalTargetResolution {
  return removalRefusal({
    ...input,
    code: "WORKTREE_REMOVE_STALE_SELECTION",
    hint: "Refresh the dashboard and reselect the worktree; no cleanup was performed.",
  });
}

function removalRefusal(input: {
  payload: RemoveWorktreePayload;
  code: string;
  message: string;
  hint: string;
  refusalReason: WorktreeRemovalRefusalReason;
  canonicalPath: string;
  observedBranch: string;
}): WorktreeRemovalTargetResolution {
  const detail: WorktreeRemovalRefusalDiagnosticDetail = {
    type: "worktree_removal_refusal",
    worktreeId: input.payload.worktreeId,
    canonicalPath: input.canonicalPath,
    observedBranch: input.observedBranch,
    refusalReason: input.refusalReason,
  };
  if (input.payload.projectId !== undefined) detail.projectId = input.payload.projectId;
  const error: SafeError & {
    diagnosticDetails: WorktreeRemovalRefusalDiagnosticDetail[];
  } = {
    tag: "CommandValidationError",
    code: input.code,
    message: input.message,
    hint: input.hint,
    worktreeId: input.payload.worktreeId,
    diagnosticDetails: [detail],
  };
  if (input.payload.projectId !== undefined) error.projectId = input.payload.projectId;
  return {
    ok: false,
    error,
    refusalReason: input.refusalReason,
    canonicalPath: input.canonicalPath,
    observedBranch: input.observedBranch,
  };
}

function configuredDefaultBranchCandidates(value: string): string[] {
  const configured = value.trim();
  if (configured === "") {
    return [];
  }
  if (configured.startsWith("refs/heads/")) {
    return [configured.slice("refs/heads/".length)].filter(Boolean);
  }
  const remoteRef = configured.match(/^refs\/remotes\/[^/]+\/(.+)$/)?.[1];
  if (remoteRef !== undefined) {
    return [remoteRef];
  }
  const slash = configured.indexOf("/");
  if (slash < 1 || slash === configured.length - 1) {
    return [configured];
  }
  return [...new Set([configured, configured.slice(slash + 1)])];
}
