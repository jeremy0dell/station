import type {
  ProjectView,
  ProviderId,
  SessionId,
  SessionView,
  StationCommand,
  TerminalFocusOrigin,
  WorktreeRow,
} from "@station/contracts";
import { isRunningAgentState } from "@station/contracts";

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
  branch: string;
  harnessProvider: ProviderId;
  initialPrompt?: string;
};

export type RenameSessionCommandInput = {
  sessionId: SessionId;
  title: string;
};

export type SetProjectDefaultHarnessCommandInput = {
  projectId: ProjectView["id"];
  harness: ProviderId;
};

export type BuildFocusCommandOptions = {
  origin?: TerminalFocusOrigin;
};

export function buildFocusCommand(
  row: WorktreeRow,
  options: BuildFocusCommandOptions = {},
): Extract<StationCommand, { type: "terminal.focus" }> {
  const payload: Extract<StationCommand, { type: "terminal.focus" }>["payload"] = {};
  if (row.agent?.sessionId !== undefined) {
    payload.sessionId = row.agent.sessionId;
  } else {
    payload.worktreeId = row.id;
  }
  if (options.origin !== undefined) {
    payload.origin = options.origin;
  }
  return {
    type: "terminal.focus",
    payload,
  };
}

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

export function buildCleanupCommand(
  row: WorktreeRow,
  action: CleanupActionKind,
  force: boolean,
): StationCommand {
  if (action === "close-harness") {
    return buildSessionCloseCommand(row, "harness", force);
  }
  if (action === "close-terminal") {
    return buildTerminalCloseCommand(row, force);
  }
  if (action === "close-all") {
    return buildSessionCloseCommand(row, "all", force);
  }
  return buildRemoveWorktreeCommand(row, force);
}

export function buildRemoveWorktreeCommand(row: WorktreeRow, force: boolean): StationCommand {
  const payload: Extract<StationCommand, { type: "worktree.remove" }>["payload"] = {
    projectId: row.projectId,
    worktreeId: row.id,
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
  return {
    type: "session.create",
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

export function buildReconcileCommand(reason?: string): StationCommand {
  return {
    type: "observer.reconcile",
    payload: reason === undefined ? {} : { reason },
  };
}

export function canSendPromptToRow(row: WorktreeRow, sessions: readonly SessionView[]): boolean {
  const sessionId = row.agent?.sessionId;
  if (sessionId === undefined) {
    return false;
  }
  const session = sessions.find((candidate) => candidate.id === sessionId);
  return session?.harness.capabilities.canReceivePrompt === true;
}

export function buildSendPromptCommand(
  row: WorktreeRow,
  sessions: readonly SessionView[],
  prompt: string,
): StationCommand {
  if (!canSendPromptToRow(row, sessions)) {
    throw new Error("The target harness cannot receive prompts safely.");
  }
  const sessionId = row.agent?.sessionId;
  if (sessionId === undefined) {
    throw new Error("The target row has no session.");
  }
  return {
    type: "session.sendPrompt",
    payload: {
      sessionId,
      prompt,
      delivery: "harness-native",
    },
  };
}

function commandLayout(layout: string): TerminalLayout {
  if (layout === "default" || layout === "agent-only" || layout === "agent-build-shell") {
    return layout;
  }
  return "default";
}

function buildSessionCloseCommand(
  row: WorktreeRow,
  mode: Extract<StationCommand, { type: "session.close" }>["payload"]["mode"],
  force: boolean,
): StationCommand {
  const sessionId = row.agent?.sessionId;
  if (sessionId === undefined) {
    throw new Error("The target row has no session.");
  }
  const payload: Extract<StationCommand, { type: "session.close" }>["payload"] = {
    sessionId,
    mode,
  };
  if (force) {
    payload.force = true;
  }
  return {
    type: "session.close",
    payload,
  };
}

function buildTerminalCloseCommand(row: WorktreeRow, force: boolean): StationCommand {
  const payload: Extract<StationCommand, { type: "terminal.close" }>["payload"] = {};
  if (row.agent?.sessionId !== undefined) {
    payload.sessionId = row.agent.sessionId;
  } else {
    payload.worktreeId = row.id;
  }
  if (force) {
    payload.force = true;
  }
  return {
    type: "terminal.close",
    payload,
  };
}
