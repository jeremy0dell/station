import {
  type HarnessCapabilities,
  type ProjectView,
  type ProviderHealth,
  type SessionGroupView,
  type SessionView,
  STATION_SCHEMA_VERSION,
  type StationSnapshot,
  type WorktreeRow,
  worktreeDisplayForAgentState,
} from "@station/contracts";

export const fixtureNow = "2026-05-20T12:00:00.000Z";

const defaultCapabilities: HarnessCapabilities = {
  canLaunch: true,
  canDiscoverRuns: true,
  canEmitEvents: true,
  canReceivePrompt: false,
  canResume: true,
  canStop: true,
  canRunNonInteractive: true,
  canExposeApprovalState: true,
  supportsModifiedEnterSoftNewline: false,
};

export function createCommandSnapshot(
  state: "none" | "idle" = "idle",
  options: { dirty?: boolean } = {},
): StationSnapshot {
  return snapshotFromRows([
    row({
      id: state === "none" ? "wt_web_no_agent" : "wt_web_idle",
      projectId: "web",
      branch: state === "none" ? "feature-start" : "fix-nav-mobile",
      state,
      ...(options.dirty === undefined ? {} : { dirty: options.dirty }),
    }),
  ]);
}

export function createZeroWorktreeSnapshot(): StationSnapshot {
  return snapshotFromRows([]);
}

export function sessionGroup(
  input: {
    id?: SessionGroupView["id"];
    projectId?: SessionGroupView["projectId"];
    name?: string;
    sessionIds?: SessionGroupView["sessionIds"];
    parentGroupId?: SessionGroupView["parentGroupId"];
    version?: number;
    createdAt?: string;
    updatedAt?: string;
  } = {},
): SessionGroupView {
  const built: SessionGroupView = {
    id: input.id ?? "grp_web_1",
    projectId: input.projectId ?? "web",
    name: input.name ?? "Active work",
    sessionIds: input.sessionIds ?? [],
    version: input.version ?? 1,
    createdAt: input.createdAt ?? fixtureNow,
    updatedAt: input.updatedAt ?? fixtureNow,
  };
  if (input.parentGroupId !== undefined) built.parentGroupId = input.parentGroupId;
  return built;
}

export function row(input: {
  id: string;
  projectId: "web" | "api";
  branch: string;
  title?: string;
  state: NonNullable<WorktreeRow["agent"]>["state"] | "none";
  dirty?: boolean;
}): WorktreeRow {
  const display = worktreeDisplayForAgentState(input.state);
  display.reason =
    input.state === "none"
      ? "No harness run is associated with this worktree."
      : reasonForState(input.state);
  const built: WorktreeRow = {
    id: input.id,
    projectId: input.projectId,
    projectLabel: input.projectId,
    title: input.title ?? input.branch,
    branch: input.branch,
    path: `/tmp/station/${input.projectId}/worktrees/${input.branch.replaceAll("/", "-")}`,
    worktree: {
      state: "exists",
      source: "worktrunk",
      dirty: input.dirty ?? false,
      ahead: 0,
      behind: 0,
    },
    display,
  };

  if (input.state !== "none") {
    built.terminal = {
      provider: "tmux",
      state: "open",
      externallyFocusable: true,
      closeable: true,
      hasWorkspace: true,
      hasPrimaryAgentEndpoint: true,
      confidence: input.state === "unknown" ? "low" : "high",
      reason: "Fixture terminal.",
      observedAt: fixtureNow,
    };
    built.agent = {
      harness: input.projectId === "api" ? "opencode" : "codex",
      state: input.state,
      runId: `run_${input.id}`,
      sessionId: `ses_${input.id}`,
      confidence: input.state === "unknown" ? "low" : "high",
      reason: reasonForState(input.state),
      updatedAt: fixtureNow,
    };
  }

  return built;
}

function snapshotFromRows(rows: WorktreeRow[]): StationSnapshot {
  const projects = [projectView("web", rows), projectView("api", rows)];
  const sessions = rows.flatMap((candidate) =>
    candidate.agent?.sessionId === undefined ? [] : [sessionForRow(candidate)],
  );
  const counts = countsForRows(rows);
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    generatedAt: fixtureNow,
    observer: {
      pid: 4242,
      startedAt: "2026-05-20T11:55:00.000Z",
      version: "0.0.0",
      healthy: true,
    },
    providerHealth: {},
    harnesses: [
      { id: "codex", label: "codex" },
      { id: "opencode", label: "opencode" },
    ],
    projects,
    rows,
    sessions,
    sessionGroups: [],
    counts: {
      projects: projects.length,
      ...counts,
    },
    alerts: [],
  };
}

function projectView(projectId: "web" | "api", rows: readonly WorktreeRow[]): ProjectView {
  const projectRows = rows.filter((candidate) => candidate.projectId === projectId);
  return {
    id: projectId,
    label: projectId,
    root: `/tmp/station/${projectId}`,
    defaults: {
      harness: projectId === "api" ? "opencode" : "codex",
      terminal: "tmux",
      layout: "agent-build-shell",
    },
    health: healthyProvider(projectId === "api" ? "opencode" : "codex"),
    counts: countsForProject(projectRows),
  };
}

function sessionForRow(candidate: WorktreeRow): SessionView {
  if (candidate.agent === undefined || candidate.terminal === undefined) {
    throw new Error("Cannot create a session for a row without an agent and terminal.");
  }
  const terminal: SessionView["terminal"] = {
    provider: candidate.terminal.provider,
    state: candidate.terminal.state,
  };
  if (candidate.terminal.externallyFocusable !== undefined)
    terminal.externallyFocusable = candidate.terminal.externallyFocusable;
  if (candidate.terminal.closeable !== undefined) terminal.closeable = candidate.terminal.closeable;
  if (candidate.terminal.hasWorkspace !== undefined) {
    terminal.hasWorkspace = candidate.terminal.hasWorkspace;
  }
  if (candidate.terminal.hasPrimaryAgentEndpoint !== undefined) {
    terminal.hasPrimaryAgentEndpoint = candidate.terminal.hasPrimaryAgentEndpoint;
  }
  if (candidate.terminal.confidence !== undefined)
    terminal.confidence = candidate.terminal.confidence;
  if (candidate.terminal.reason !== undefined) terminal.reason = candidate.terminal.reason;
  if (candidate.terminal.observedAt !== undefined)
    terminal.observedAt = candidate.terminal.observedAt;
  return {
    id: candidate.agent.sessionId ?? `ses_${candidate.id}`,
    origin: "station",
    projectId: candidate.projectId,
    worktreeId: candidate.id,
    createdAt: "2026-05-20T11:59:00.000Z",
    updatedAt: fixtureNow,
    harness: {
      provider: candidate.agent.harness,
      mode: "interactive",
      runId: candidate.agent.runId,
      capabilities: defaultCapabilities,
    },
    terminal,
    status: {
      value: candidate.agent.state,
      confidence: candidate.agent.confidence,
      reason: candidate.agent.reason,
      source: "harness_event",
      updatedAt: fixtureNow,
    },
    title: candidate.branch,
    tags: [candidate.agent.harness, candidate.terminal.provider],
  };
}

function reasonForState(state: NonNullable<WorktreeRow["agent"]>["state"]): string {
  if (state === "needs_attention") return "Agent needs approval.";
  if (state === "stuck") return "No progress was observed recently.";
  if (state === "working") return "Harness reported active generation.";
  if (state === "idle") return "Harness reported the turn completed.";
  if (state === "unknown") return "Observer cannot classify this run confidently.";
  if (state === "exited") return "Harness process exited.";
  return "Harness run is starting.";
}

function countsForRows(rows: readonly WorktreeRow[]) {
  return {
    sessions: rows.filter((candidate) => candidate.agent?.sessionId !== undefined).length,
    worktrees: rows.length,
    agents: rows.filter((candidate) => candidate.agent !== undefined).length,
    working: rows.filter((candidate) => candidate.agent?.state === "working").length,
    idle: rows.filter((candidate) => candidate.agent?.state === "idle").length,
    attention: rows.filter((candidate) => candidate.agent?.state === "needs_attention").length,
    unknown: rows.filter((candidate) => candidate.agent?.state === "unknown").length,
  };
}

function countsForProject(rows: readonly WorktreeRow[]): ProjectView["counts"] {
  const counts = countsForRows(rows);
  return {
    sessions: counts.sessions,
    worktrees: counts.worktrees,
    agents: counts.agents,
    working: counts.working,
    idle: counts.idle,
    attention: counts.attention,
    unknown: counts.unknown,
  };
}

function healthyProvider(providerId: string): ProviderHealth {
  return {
    provider: providerId,
    providerType: providerId === "tmux" ? "terminal" : "harness",
    status: "healthy",
    lastCheckedAt: fixtureNow,
  };
}
