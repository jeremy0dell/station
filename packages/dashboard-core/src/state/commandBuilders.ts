import type {
  ProjectView,
  ProviderId,
  SafeError,
  SessionGroupId,
  SessionGroupPlacementIntent,
  SessionId,
  SourceSessionGroupPlacementIntent,
  StationCommand,
  WorktreeId,
  WorktreeRow,
} from "@station/contracts";
import { isRunningAgentState, normalizeObservedPath } from "@station/contracts";

type TerminalLayout = NonNullable<
  Extract<StationCommand, { type: "session.create" }>["payload"]["terminal"]["layout"]
>;

export type CleanupActionKind =
  | "close-harness"
  | "close-terminal"
  | "close-all"
  | "remove-worktree";

export type CreateSessionCommandInput = {
  project: ProjectView;
  title: string;
  branch: string;
  harnessProvider: ProviderId;
  initialPrompt?: string;
  group?: SessionGroupPlacementIntent;
};

export type RenameSessionCommandInput = {
  sessionId: SessionId;
  title: string;
};

export type ForkSessionCommandInput = {
  project: ProjectView;
  sourceWorktreeId: WorktreeId;
  title: string;
  branch: string;
  base?: string;
  copyDirty?: boolean;
  group?: SourceSessionGroupPlacementIntent;
  // Omit to let the observer inherit the source worktree's harness.
  harnessProvider?: ProviderId;
  initialPrompt?: string;
};

export type SetProjectDefaultHarnessCommandInput = {
  projectId: ProjectView["id"];
  harness: ProviderId;
};

export type RemoveProjectCommandInput = {
  projectId: ProjectView["id"];
};

export type CreateSessionGroupCommandInput = {
  projectId: ProjectView["id"];
  name: string;
};

export type RenameSessionGroupCommandInput = {
  projectId: ProjectView["id"];
  groupId: SessionGroupId;
  expectedVersion: number;
  name: string;
};

export type UpdateSessionGroupMembershipCommandInput = {
  projectId: ProjectView["id"];
  groupId: SessionGroupId;
  expectedVersion: number;
  sessionId: SessionId;
  expectedGroupId?: SessionGroupId | null;
};

export type UpdateSessionGroupMembershipDeltaCommandInput = {
  projectId: ProjectView["id"];
  groupId: SessionGroupId;
  expectedVersion: number;
  add: readonly { sessionId: SessionId; expectedGroupId: SessionGroupId | null }[];
  remove: readonly { sessionId: SessionId; expectedGroupId: SessionGroupId | null }[];
};

export type DeleteSessionGroupCommandInput = {
  projectId: ProjectView["id"];
  groupId: SessionGroupId;
  expectedVersion: number;
};

export type MoveSessionToGroupCommandInput = {
  projectId: ProjectView["id"];
  sessionId: SessionId;
  currentGroup: { id: SessionGroupId; version: number } | undefined;
  destinationGroup: { id: SessionGroupId; version: number } | undefined;
};

export function buildStartAgentCommand(
  row: WorktreeRow,
  project: ProjectView,
): Extract<StationCommand, { type: "session.startAgent" }> {
  return {
    type: "session.startAgent",
    payload: {
      projectId: project.id,
      worktreeId: row.id,
      terminal: {
        provider: project.defaults.terminal,
        layout: commandLayout(project.defaults.layout),
        focus: false,
      },
    },
  };
}

export function buildResumeAgentCommand(
  row: WorktreeRow,
  project: ProjectView,
): Extract<StationCommand, { type: "session.resumeAgent" }> {
  if (row.recovery === undefined) {
    throw new Error(`No recovery handle is available for worktree ${row.id}.`);
  }
  return {
    type: "session.resumeAgent",
    payload: {
      projectId: project.id,
      worktreeId: row.id,
      recoveryHandleId: row.recovery.handleId,
      terminal: {
        provider: project.defaults.terminal,
        layout: commandLayout(project.defaults.layout),
        focus: false,
      },
    },
  };
}

export function cleanupForceRequired(row: WorktreeRow, action: CleanupActionKind): boolean {
  const running = isRunningAgentState(row.agent?.state);
  if (action === "remove-worktree") {
    return row.worktree.dirty === true || running;
  }
  return running;
}

/** Builds a provenance-qualified removal and refuses rows without Git registration identity. */
export function buildRemoveWorktreeCommand(row: WorktreeRow, force: boolean): StationCommand {
  if (row.registrationIdentity === undefined) {
    throw {
      tag: "CommandValidationError",
      code: "WORKTREE_REMOVE_REGISTRATION_UNVERIFIED",
      message: "Station cannot verify this checkout's Git registration.",
      hint: "Refresh the dashboard before trying to remove the checkout.",
      projectId: row.projectId,
      worktreeId: row.id,
    } satisfies SafeError;
  }
  const payload: Extract<StationCommand, { type: "worktree.remove" }>["payload"] = {
    projectId: row.projectId,
    worktreeId: row.id,
    expectedPath: normalizeObservedPath(row.path),
    expectedBranch: row.branch,
    expectedRegistrationIdentity: row.registrationIdentity,
  };
  if (force) {
    payload.force = true;
  }
  return {
    type: "worktree.remove",
    payload,
  };
}

export function buildCreateSessionCommand(input: CreateSessionCommandInput): StationCommand {
  const payload: Extract<StationCommand, { type: "session.create" }>["payload"] = {
    projectId: input.project.id,
    title: input.title,
    branch: input.branch,
    harness: {
      provider: input.harnessProvider,
      mode: "interactive",
    },
    terminal: {
      provider: input.project.defaults.terminal,
      layout: commandLayout(input.project.defaults.layout),
      focus: false,
    },
  };
  if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
    payload.initialPrompt = input.initialPrompt;
  }
  if (input.group !== undefined) {
    payload.group = input.group;
  }
  return {
    type: "session.create",
    payload,
  };
}

export function buildForkSessionCommand(input: ForkSessionCommandInput): StationCommand {
  const payload: Extract<StationCommand, { type: "session.fork" }>["payload"] = {
    projectId: input.project.id,
    sourceWorktreeId: input.sourceWorktreeId,
    title: input.title,
    branch: input.branch,
    terminal: {
      provider: input.project.defaults.terminal,
      layout: commandLayout(input.project.defaults.layout),
      focus: false,
    },
  };
  if (input.base !== undefined) {
    payload.base = input.base;
  }
  if (input.copyDirty !== undefined) {
    payload.copyDirty = input.copyDirty;
  }
  if (input.group !== undefined) {
    payload.group = input.group;
  }
  if (input.harnessProvider !== undefined) {
    payload.harness = { provider: input.harnessProvider };
  }
  if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
    payload.initialPrompt = input.initialPrompt;
  }
  return {
    type: "session.fork",
    payload,
  };
}

export function buildRenameSessionCommand(input: RenameSessionCommandInput): StationCommand {
  return {
    type: "session.rename",
    payload: {
      sessionId: input.sessionId,
      title: input.title,
    },
  };
}

export function buildSetProjectDefaultHarnessCommand(
  input: SetProjectDefaultHarnessCommandInput,
): Extract<StationCommand, { type: "project.setDefaultHarness" }> {
  return {
    type: "project.setDefaultHarness",
    payload: {
      projectId: input.projectId,
      harness: input.harness,
    },
  };
}

export function buildRemoveProjectCommand(
  input: RemoveProjectCommandInput,
): Extract<StationCommand, { type: "project.remove" }> {
  return {
    type: "project.remove",
    payload: {
      projectId: input.projectId,
    },
  };
}

export function buildCreateSessionGroupCommand(
  input: CreateSessionGroupCommandInput,
): Extract<StationCommand, { type: "sessionGroup.create" }> {
  return {
    type: "sessionGroup.create",
    payload: {
      projectId: input.projectId,
      name: input.name.trim(),
    },
  };
}

export function buildRenameSessionGroupCommand(
  input: RenameSessionGroupCommandInput,
): Extract<StationCommand, { type: "sessionGroup.rename" }> {
  return {
    type: "sessionGroup.rename",
    payload: {
      projectId: input.projectId,
      groupId: input.groupId,
      expectedVersion: input.expectedVersion,
      name: input.name.trim(),
    },
  };
}

export function buildUpdateSessionGroupMembershipCommand(
  input: UpdateSessionGroupMembershipCommandInput,
): Extract<StationCommand, { type: "sessionGroup.updateMembership" }> {
  return {
    type: "sessionGroup.updateMembership",
    payload: {
      projectId: input.projectId,
      groupId: input.groupId,
      expectedVersion: input.expectedVersion,
      add: [{ sessionId: input.sessionId, expectedGroupId: input.expectedGroupId ?? null }],
    },
  };
}

/** Builds one atomic add/remove delta without emitting empty payload collections. */
export function buildUpdateSessionGroupMembershipDeltaCommand(
  input: UpdateSessionGroupMembershipDeltaCommandInput,
): Extract<StationCommand, { type: "sessionGroup.updateMembership" }> {
  const payload: Extract<StationCommand, { type: "sessionGroup.updateMembership" }>["payload"] = {
    projectId: input.projectId,
    groupId: input.groupId,
    expectedVersion: input.expectedVersion,
  };
  if (input.add.length > 0) payload.add = [...input.add];
  if (input.remove.length > 0) payload.remove = [...input.remove];
  return { type: "sessionGroup.updateMembership", payload };
}

export function buildDeleteSessionGroupCommand(
  input: DeleteSessionGroupCommandInput,
): Extract<StationCommand, { type: "sessionGroup.delete" }> {
  return {
    type: "sessionGroup.delete",
    payload: {
      projectId: input.projectId,
      groupId: input.groupId,
      expectedVersion: input.expectedVersion,
    },
  };
}

/** Builds the single optimistic-concurrency command for Group reassignment or ungrouping. */
export function buildMoveSessionToGroupCommand(
  input: MoveSessionToGroupCommandInput,
): Extract<StationCommand, { type: "sessionGroup.updateMembership" }> | undefined {
  if (input.currentGroup?.id === input.destinationGroup?.id) return undefined;
  if (input.destinationGroup !== undefined) {
    return buildUpdateSessionGroupMembershipCommand({
      projectId: input.projectId,
      groupId: input.destinationGroup.id,
      expectedVersion: input.destinationGroup.version,
      sessionId: input.sessionId,
      expectedGroupId: input.currentGroup?.id ?? null,
    });
  }
  if (input.currentGroup === undefined) return undefined;
  return {
    type: "sessionGroup.updateMembership",
    payload: {
      projectId: input.projectId,
      groupId: input.currentGroup.id,
      expectedVersion: input.currentGroup.version,
      remove: [{ sessionId: input.sessionId, expectedGroupId: input.currentGroup.id }],
    },
  };
}

function commandLayout(layout: string): TerminalLayout {
  if (layout === "default" || layout === "agent-only" || layout === "agent-build-shell") {
    return layout;
  }
  return "default";
}
