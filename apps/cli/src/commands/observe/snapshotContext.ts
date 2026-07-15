import type {
  CommandId,
  SessionView,
  StationEvent,
  StationSnapshot,
  WorktreeRow,
} from "@station/contracts";

export type ObserveSnapshotContext = {
  projects: Map<string, StationSnapshot["projects"][number]>;
  rows: Map<string, WorktreeRow>;
  sessions: Map<string, SessionView>;
  commandTypes: Map<string, string>;
};

export function createObserveSnapshotContext(snapshot?: StationSnapshot): ObserveSnapshotContext {
  const context: ObserveSnapshotContext = {
    projects: new Map(),
    rows: new Map(),
    sessions: new Map(),
    commandTypes: new Map(),
  };
  if (snapshot !== undefined) {
    loadSnapshotContext(context, snapshot);
  }
  return context;
}

export function loadSnapshotContext(
  context: ObserveSnapshotContext,
  snapshot: StationSnapshot,
): void {
  context.projects.clear();
  context.rows.clear();
  context.sessions.clear();
  for (const project of snapshot.projects) {
    context.projects.set(project.id, project);
  }
  for (const row of snapshot.rows) {
    context.rows.set(row.id, row);
  }
  for (const session of snapshot.sessions) {
    context.sessions.set(session.id, session);
  }
}

export function applyEventToSnapshotContext(
  context: ObserveSnapshotContext,
  event: StationEvent,
): void {
  switch (event.type) {
    case "worktree.added":
      context.rows.set(event.row.id, event.row);
      break;
    case "worktree.updated": {
      const current = context.rows.get(event.worktreeId);
      if (current !== undefined) {
        context.rows.set(event.worktreeId, applyWorktreePatch(current, event.patch));
      }
      break;
    }
    case "worktree.agentStateChanged": {
      const current = context.rows.get(event.worktreeId);
      if (current !== undefined) {
        if (event.agent === undefined) {
          const { agent: _agent, ...rowWithoutAgent } = current;
          context.rows.set(event.worktreeId, rowWithoutAgent);
        } else {
          context.rows.set(event.worktreeId, { ...current, agent: event.agent });
        }
      }
      break;
    }
    case "worktree.removed":
      context.rows.delete(event.worktreeId);
      break;
    case "session.created":
      context.sessions.set(event.session.id, event.session);
      break;
    case "session.updated": {
      const current = context.sessions.get(event.sessionId);
      if (current !== undefined) {
        context.sessions.set(event.sessionId, applySessionPatch(current, event.patch));
      }
      break;
    }
    case "session.removed":
      context.sessions.delete(event.sessionId);
      break;
    case "command.accepted":
    case "command.started":
      context.commandTypes.set(event.commandId, event.command.type);
      break;
    default:
      break;
  }
}

export function applyEventBeforeFormatting(event: StationEvent): boolean {
  return event.type !== "worktree.removed" && event.type !== "session.removed";
}

export function worktreeLabel(context: ObserveSnapshotContext, worktreeId: string): string {
  const row = context.rows.get(worktreeId);
  return row === undefined ? worktreeId : rowLabel(row);
}

export function sessionLabel(context: ObserveSnapshotContext, sessionId: string): string {
  const session = context.sessions.get(sessionId);
  return session?.title ?? sessionId;
}

export function sessionWorktreeLabel(
  context: ObserveSnapshotContext,
  sessionId: string,
): string | undefined {
  const session = context.sessions.get(sessionId);
  if (session === undefined) {
    return undefined;
  }
  return worktreeLabel(context, session.worktreeId);
}

export function commandTypeLabel(
  context: ObserveSnapshotContext,
  commandId: CommandId,
): string | undefined {
  return context.commandTypes.get(commandId);
}

export function rowLabel(row: WorktreeRow): string {
  return `${row.projectLabel} ${row.branch}`;
}

function applyWorktreePatch(
  current: WorktreeRow,
  patch: Extract<StationEvent, { type: "worktree.updated" }>["patch"],
): WorktreeRow {
  const next: WorktreeRow = { ...current };
  if (patch.id !== undefined) next.id = patch.id;
  if (patch.projectId !== undefined) next.projectId = patch.projectId;
  if (patch.projectLabel !== undefined) next.projectLabel = patch.projectLabel;
  if (patch.branch !== undefined) next.branch = patch.branch;
  if (patch.path !== undefined) next.path = patch.path;
  if (patch.worktree !== undefined) next.worktree = patch.worktree;
  if (patch.terminal !== undefined) next.terminal = patch.terminal;
  if (patch.agent !== undefined) next.agent = patch.agent;
  if (patch.display !== undefined) next.display = patch.display;
  return next;
}

function applySessionPatch(
  current: SessionView,
  patch: Extract<StationEvent, { type: "session.updated" }>["patch"],
): SessionView {
  const next: SessionView = { ...current };
  if (patch.id !== undefined) next.id = patch.id;
  if (patch.origin !== undefined) next.origin = patch.origin;
  if (patch.projectId !== undefined) next.projectId = patch.projectId;
  if (patch.worktreeId !== undefined) next.worktreeId = patch.worktreeId;
  if (patch.createdAt !== undefined) next.createdAt = patch.createdAt;
  if (patch.updatedAt !== undefined) next.updatedAt = patch.updatedAt;
  if (patch.harness !== undefined) next.harness = patch.harness;
  if (patch.terminal !== undefined) next.terminal = patch.terminal;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.tags !== undefined) next.tags = patch.tags;
  return next;
}
