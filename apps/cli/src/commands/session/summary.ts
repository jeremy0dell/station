import type {
  AgentState,
  ProjectId,
  ProviderId,
  SafeError,
  SessionId,
  SessionView,
  StationSnapshot,
  TerminalAttachment,
} from "@station/contracts";

export type SessionSummary = {
  sessionId: SessionId;
  origin: SessionView["origin"];
  title: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  projectId: ProjectId;
  projectLabel: string;
  worktreeId: SessionView["worktreeId"];
  worktreeTitle: string;
  branch: string;
  path: string;
  harness: SessionView["harness"];
  status: SessionView["status"];
  terminal?: TerminalAttachment;
};

export type SessionFilters = {
  project?: ProjectId;
  provider?: ProviderId;
  status?: AgentState;
  origin?: SessionView["origin"];
  query?: string;
};

export type SessionWorktreeSummary = {
  projectId: ProjectId;
  worktreeId: SessionView["worktreeId"];
  title: string;
  branch: string;
  path: string;
};

export function summarizeSessions(snapshot: StationSnapshot): SessionSummary[] {
  return snapshot.sessions.map((session) => summarizeSession(snapshot, session));
}

export function summarizeSession(snapshot: StationSnapshot, session: SessionView): SessionSummary {
  const project = snapshot.projects.find((candidate) => candidate.id === session.projectId);
  if (project === undefined) {
    throw missingSessionProjectError(session);
  }
  const worktree = snapshot.rows.find(
    (candidate) => candidate.projectId === session.projectId && candidate.id === session.worktreeId,
  );
  if (worktree === undefined) {
    throw missingSessionWorktreeError(session);
  }

  const summary: SessionSummary = {
    sessionId: session.id,
    origin: session.origin,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    tags: [...session.tags],
    projectId: project.id,
    projectLabel: project.label,
    worktreeId: worktree.id,
    worktreeTitle: worktree.title,
    branch: worktree.branch,
    path: worktree.path,
    harness: copyHarness(session.harness),
    status: { ...session.status },
  };
  if (session.terminal !== undefined) {
    summary.terminal = { ...session.terminal };
  }
  return summary;
}

export function findSessionSummary(
  snapshot: StationSnapshot,
  sessionId: SessionId,
): SessionSummary {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) {
    throw sessionNotFoundError(sessionId);
  }
  return summarizeSession(snapshot, session);
}

export function findOptionalSessionSummary(
  snapshot: StationSnapshot,
  sessionId: SessionId,
): SessionSummary | undefined {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  return session === undefined ? undefined : summarizeSession(snapshot, session);
}

export function filterSessionSummaries(
  summaries: readonly SessionSummary[],
  filters: SessionFilters,
): SessionSummary[] {
  const query = filters.query?.toLowerCase();
  return summaries.filter((session) => {
    if (filters.project !== undefined && session.projectId !== filters.project) return false;
    if (filters.provider !== undefined && session.harness.provider !== filters.provider)
      return false;
    if (filters.status !== undefined && session.status.value !== filters.status) return false;
    if (filters.origin !== undefined && session.origin !== filters.origin) return false;
    if (query === undefined) return true;
    return searchableSessionFields(session).some((value) => value.toLowerCase().includes(query));
  });
}

export function findSessionWorktreeSummary(
  snapshot: StationSnapshot,
  target: Pick<SessionSummary, "projectId" | "worktreeId" | "sessionId">,
): SessionWorktreeSummary | undefined {
  const worktree = snapshot.rows.find(
    (candidate) => candidate.projectId === target.projectId && candidate.id === target.worktreeId,
  );
  if (worktree === undefined) return undefined;
  return {
    projectId: worktree.projectId,
    worktreeId: worktree.id,
    title: worktree.title,
    branch: worktree.branch,
    path: worktree.path,
  };
}

function copyHarness(harness: SessionView["harness"]): SessionView["harness"] {
  const copied: SessionView["harness"] = {
    provider: harness.provider,
    mode: harness.mode,
    capabilities: { ...harness.capabilities },
  };
  if (harness.pid !== undefined) copied.pid = harness.pid;
  if (harness.runId !== undefined) copied.runId = harness.runId;
  return copied;
}

function searchableSessionFields(session: SessionSummary): string[] {
  return [
    session.sessionId,
    session.title,
    session.projectId,
    session.projectLabel,
    session.worktreeId,
    session.branch,
    session.harness.provider,
  ];
}

function sessionNotFoundError(sessionId: SessionId): SafeError {
  return {
    tag: "SessionCliError",
    code: "SESSION_NOT_FOUND",
    message: `No current session has the exact id ${sessionId}.`,
    hint: "Use `stn session list` and pass one complete session ID. Titles, branches, prefixes, and display indexes are not accepted.",
    sessionId,
  };
}

function missingSessionProjectError(session: SessionView): SafeError {
  return {
    tag: "SessionCliError",
    code: "SESSION_PROJECT_RELATIONSHIP_MISSING",
    message: `Session ${session.id} references project ${session.projectId}, which is missing from the snapshot.`,
    hint: "Run `stn snapshot --json` and inspect the current Observer graph before retrying.",
    sessionId: session.id,
    projectId: session.projectId,
  };
}

function missingSessionWorktreeError(session: SessionView): SafeError {
  return {
    tag: "SessionCliError",
    code: "SESSION_WORKTREE_RELATIONSHIP_MISSING",
    message: `Session ${session.id} references worktree ${session.worktreeId}, which is missing from its project snapshot.`,
    hint: "Run `stn snapshot --json` and inspect the current Observer graph before retrying.",
    sessionId: session.id,
    projectId: session.projectId,
    worktreeId: session.worktreeId,
  };
}
