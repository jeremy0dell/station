import {
  type HarnessCapabilities,
  type ProjectView,
  type ProviderHealth,
  type SessionView,
  STATION_SCHEMA_VERSION,
  type StationSnapshot,
  type WorktreeRow,
} from "@station/contracts";

export const fixtureNow = "2026-05-20T12:00:00.000Z";

const defaultCapabilities: HarnessCapabilities = {
  canLaunch: true,
  canDiscoverRuns: true,
  canEmitEvents: true,
  canClassifyStatus: true,
  canReceivePrompt: false,
  canResume: true,
  canStop: true,
  canRunNonInteractive: true,
  canExposeApprovalState: true,
  supportsModifiedEnterSoftNewline: false,
};

export function createDashboardSnapshot(): StationSnapshot {
  return snapshotFromRows([
    row({
      id: "wt_web_attention",
      projectId: "web",
      branch: "checkout-copy",
      state: "needs_attention",
    }),
    row({ id: "wt_web_stuck", projectId: "web", branch: "slow-tests", state: "stuck" }),
    row({ id: "wt_web_working", projectId: "web", branch: "cache-refactor", state: "working" }),
    row({ id: "wt_web_idle", projectId: "web", branch: "fix-nav-mobile", state: "idle" }),
    row({ id: "wt_web_unknown", projectId: "web", branch: "ghost-signal", state: "unknown" }),
    row({ id: "wt_web_exited", projectId: "web", branch: "done-run", state: "exited" }),
    row({ id: "wt_web_no_agent", projectId: "web", branch: "feature-auth", state: "none" }),
    row({ id: "wt_api_working", projectId: "api", branch: "queue-worker", state: "working" }),
  ]);
}

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

export function createExternalAgentSnapshot(): StationSnapshot {
  const snapshot = createDashboardSnapshot();
  const externalRow = snapshot.rows.find((candidate) => candidate.id === "wt_web_idle");
  if (externalRow?.agent === undefined) {
    throw new Error("Fixture row wt_web_idle must have an agent.");
  }
  const rowWithoutStationOwnership: WorktreeRow = {
    ...externalRow,
    agent: { ...externalRow.agent },
  };
  delete rowWithoutStationOwnership.terminal;
  delete rowWithoutStationOwnership.agent?.sessionId;

  return {
    ...snapshot,
    providerHealth: {
      ...snapshot.providerHealth,
      codex: {
        providerId: "codex",
        providerType: "harness",
        status: "healthy",
        lastCheckedAt: fixtureNow,
        capabilities: { ...defaultCapabilities, canStop: false },
      },
    },
    rows: snapshot.rows.map((candidate) =>
      candidate.id === rowWithoutStationOwnership.id ? rowWithoutStationOwnership : candidate,
    ),
    sessions: snapshot.sessions.filter(
      (session) => session.worktreeId !== rowWithoutStationOwnership.id,
    ),
  };
}

export function createZeroWorktreeSnapshot(): StationSnapshot {
  return snapshotFromRows([]);
}

export function createNoProjectsSnapshot(): StationSnapshot {
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
    projects: [],
    rows: [],
    sessions: [],
    counts: {
      projects: 0,
      worktrees: 0,
      agents: 0,
      working: 0,
      idle: 0,
      attention: 0,
      unknown: 0,
    },
    alerts: [],
  };
}

export function row(input: {
  id: string;
  projectId: "web" | "api";
  branch: string;
  state: WorktreeRow["agent"] extends { state: infer T } ? T | "none" : never;
  dirty?: boolean;
}): WorktreeRow {
  const display = displayForState(input.state);
  const built: WorktreeRow = {
    id: input.id,
    projectId: input.projectId,
    projectLabel: input.projectId,
    branch: input.branch,
    path: `/tmp/station/${input.projectId}/worktrees/${input.branch.replaceAll("/", "-")}`,
    registrationIdentity: `git-registration:${input.id}`,
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
      focusable: true,
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
  if (candidate.terminal.focusable !== undefined) terminal.focusable = candidate.terminal.focusable;
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

function displayForState(
  state: NonNullable<WorktreeRow["agent"]>["state"] | "none",
): WorktreeRow["display"] {
  if (state === "needs_attention") {
    return {
      statusLabel: "needs attention",
      sortPriority: 10,
      alert: true,
      reason: reasonForState(state),
    };
  }
  if (state === "stuck") {
    return { statusLabel: "stuck", sortPriority: 20, alert: true, reason: reasonForState(state) };
  }
  if (state === "working") {
    return {
      statusLabel: "working",
      sortPriority: 30,
      alert: false,
      reason: reasonForState(state),
    };
  }
  if (state === "idle") {
    return { statusLabel: "idle", sortPriority: 40, alert: false, reason: reasonForState(state) };
  }
  if (state === "unknown") {
    return {
      statusLabel: "unknown",
      sortPriority: 50,
      alert: false,
      reason: reasonForState(state),
    };
  }
  if (state === "exited") {
    return { statusLabel: "exited", sortPriority: 60, alert: false, reason: reasonForState(state) };
  }
  return {
    statusLabel: "no agent",
    sortPriority: 70,
    alert: false,
    reason: "No harness run is associated with this worktree.",
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
    worktrees: rows.length,
    agents: rows.filter((candidate) => candidate.agent !== undefined).length,
    working: rows.filter((candidate) => candidate.display.statusLabel === "working").length,
    idle: rows.filter((candidate) => candidate.display.statusLabel === "idle").length,
    attention: rows.filter((candidate) => candidate.display.statusLabel === "needs attention")
      .length,
    unknown: rows.filter((candidate) => candidate.display.statusLabel === "unknown").length,
  };
}

function countsForProject(rows: readonly WorktreeRow[]): ProjectView["counts"] {
  const counts = countsForRows(rows);
  return {
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
    providerId,
    providerType: providerId === "tmux" ? "terminal" : "harness",
    status: "healthy",
    lastCheckedAt: fixtureNow,
  };
}
