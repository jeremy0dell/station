// Deterministic STATION-view scenarios for layout work, golden-frame tests, and
// the mock source (many-projects, attention-and-failures, disconnected).
// Fixture data self-identifies through contract channels (snapshot alerts), not code branches.
import type {
  ProjectView,
  ProviderHealth,
  SessionView,
  WorktreeRow,
  StationSnapshot,
} from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import type { StationState } from "../../sources/types.js";
import { mockObserverSnapshot } from "../../sources/fixtures/mockObserverSnapshot.js";

export const SCENARIO_NOW = "2026-06-12T12:00:00.000Z";
const SCENARIO_NOW_MS = Date.parse(SCENARIO_NOW);

export type StationScenarioName =
  | "baseline"
  | "many-projects"
  | "attention-and-failures"
  | "disconnected";

export const STATION_SCENARIO_NAMES: readonly StationScenarioName[] = [
  "baseline",
  "many-projects",
  "attention-and-failures",
  "disconnected",
];

/** A scenario is exactly what a StationStateSource serves. */
export function scenarioState(name: StationScenarioName): StationState {
  switch (name) {
    case "baseline":
      return {
        snapshot: mockObserverSnapshot,
        connection: { state: "connected", since: Date.parse(mockObserverSnapshot.generatedAt) },
      };
    case "many-projects":
      return {
        snapshot: manyProjectsSnapshot(),
        connection: { state: "connected", since: SCENARIO_NOW_MS },
      };
    case "attention-and-failures":
      return {
        snapshot: attentionAndFailuresSnapshot(),
        connection: { state: "connected", since: SCENARIO_NOW_MS },
      };
    case "disconnected":
      // Last good snapshot retained; the observer has been gone for a while.
      return {
        snapshot: manyProjectsSnapshot(),
        connection: {
          state: "displayOnly",
          since: SCENARIO_NOW_MS - 95_000,
          lastError: {
            tag: "ProtocolError",
            code: "PROTOCOL_CONNECT_FAILED",
            message: "Could not connect to observer socket /tmp/station-station.sock.",
          },
        },
      };
  }
}

export function manyProjectsSnapshot(): StationSnapshot {
  return snapshotFromRows(
    [
      scenarioRow({ id: "wt_station_working", project: STATION, branch: "station-overlay", state: "working", additions: 412, deletions: 96, pr: { number: 76, state: "open" }, checks: "running" }),
      scenarioRow({ id: "wt_station_idle", project: STATION, branch: "pty-buffer", state: "idle", additions: 0, deletions: 0, pr: { number: 73, state: "merged" }, checks: "pass" }),
      scenarioRow({ id: "wt_station_idle2", project: STATION, branch: "cli-help-man", state: "idle", additions: 14, deletions: 6, pr: { number: 70, state: "open" }, checks: "pass" }),
      scenarioRow({ id: "wt_station_starting", project: STATION, branch: "session-resume", state: "starting" }),
      scenarioRow({ id: "wt_station_none", project: STATION, branch: "docs-cleanup", state: "none" }),
      scenarioRow({ id: "wt_obs_working", project: OBSERVER, branch: "provider-hooks", state: "working", additions: 32, deletions: 8, pr: { number: 16, state: "open" }, checks: "running" }),
      scenarioRow({ id: "wt_obs_idle", project: OBSERVER, branch: "trace-bundle", state: "idle", additions: 1, deletions: 1, pr: { number: 4, state: "open" }, checks: "pass" }),
      scenarioRow({ id: "wt_obs_exited", project: OBSERVER, branch: "batch-export", state: "exited", additions: 0, deletions: 0, pr: { number: 8, state: "open" }, checks: "pass" }),
      scenarioRow({ id: "wt_scripts_idle", project: SCRIPTS, branch: "api-cache", state: "idle", additions: 14, deletions: 6, pr: { number: 5, state: "open" }, checks: { state: "fail", failed: 1 } }),
      scenarioRow({ id: "wt_scripts_unknown", project: SCRIPTS, branch: "metadata-refresh", state: "unknown", additions: 3, deletions: 1, pr: { number: 10, state: "open" } }),
      scenarioRow({ id: "wt_scripts_none", project: SCRIPTS, branch: "old-experiment", state: "none", dirty: true }),
    ],
    {
      projects: [STATION, OBSERVER, SCRIPTS, EMPTY],
      alerts: [
        {
          id: "alert_station_mock",
          severity: "info",
          message: "Static many-projects fixture — not live observer data.",
          createdAt: SCENARIO_NOW,
        },
      ],
    },
  );
}

/** First-run: no projects configured at all. */
export function noProjectsSnapshot(): StationSnapshot {
  return snapshotFromRows([], { projects: [] });
}

export function attentionAndFailuresSnapshot(): StationSnapshot {
  return snapshotFromRows(
    [
      scenarioRow({ id: "wt_station_attention", project: STATION, branch: "hook-scope", state: "needs_attention", additions: 8, deletions: 2, pr: { number: 12, state: "open" }, checks: { state: "fail", failed: 2 } }),
      scenarioRow({ id: "wt_station_stuck", project: STATION, branch: "popup-latency", state: "stuck", additions: 120, deletions: 44, pr: { number: 13, state: "open" }, checks: "running" }),
      scenarioRow({ id: "wt_station_working", project: STATION, branch: "pr-info", state: "working", additions: 0, deletions: 0, pr: { number: 11, state: "open" }, checks: "pass" }),
      scenarioRow({ id: "wt_station_unknown", project: STATION, branch: "metadata-refresh", state: "unknown", additions: 3, deletions: 1 }),
      scenarioRow({ id: "wt_obs_attention", project: OBSERVER, branch: "sqlite-cleanup", state: "needs_attention", additions: 19, deletions: 2, pr: { number: 6, state: "open" }, checks: { state: "fail", failed: 1 } }),
      scenarioRow({ id: "wt_obs_exited", project: OBSERVER, branch: "done-run", state: "exited", dirty: true }),
    ],
    {
      projects: [STATION, OBSERVER],
      providerHealth: {
        codex: {
          providerId: "codex",
          providerType: "harness",
          status: "degraded",
          lastCheckedAt: SCENARIO_NOW,
        },
      },
      alerts: [
        {
          id: "alert_attention_fixture",
          severity: "warn",
          message: "Static attention-and-failures fixture — not live observer data.",
          createdAt: SCENARIO_NOW,
        },
        {
          id: "alert_provider_degraded",
          severity: "warn",
          message: "Harness provider codex is degraded.",
          createdAt: SCENARIO_NOW,
        },
      ],
    },
  );
}

type ScenarioProject = {
  id: string;
  label: string;
  harness: "codex" | "opencode";
};

const STATION: ScenarioProject = { id: "station", label: "station", harness: "codex" };
const OBSERVER: ScenarioProject = { id: "observer", label: "observer", harness: "opencode" };
const SCRIPTS: ScenarioProject = { id: "scripts", label: "scripts", harness: "opencode" };
const EMPTY: ScenarioProject = { id: "empty-project", label: "empty-project", harness: "codex" };

type AgentScenarioState =
  | "none"
  | "starting"
  | "idle"
  | "working"
  | "needs_attention"
  | "stuck"
  | "unknown"
  | "exited";

type ScenarioRowInput = {
  id: string;
  project: ScenarioProject;
  branch: string;
  state: AgentScenarioState;
  dirty?: boolean;
  additions?: number;
  deletions?: number;
  pr?: { number: number; state: "open" | "merged" | "draft" | "closed" | "unknown" };
  checks?: "pass" | "running" | { state: "fail"; failed: number };
};

function scenarioRow(input: ScenarioRowInput): WorktreeRow {
  const built: WorktreeRow = {
    id: input.id,
    projectId: input.project.id,
    projectLabel: input.project.label,
    branch: input.branch,
    path: `/Users/example/.worktrees/${input.project.id}/${input.branch.replaceAll("/", "-")}`,
    worktree: {
      state: "exists",
      source: "worktrunk",
      dirty: input.dirty ?? false,
      ahead: 0,
      behind: 0,
      ...(input.additions === undefined || input.deletions === undefined
        ? {}
        : {
            changeSummary: {
              kind: "branch_diff" as const,
              additions: input.additions,
              deletions: input.deletions,
              source: "git",
              checkedAt: SCENARIO_NOW,
            },
          }),
      ...(input.pr === undefined
        ? {}
        : {
            pr: {
              number: input.pr.number,
              state: input.pr.state,
              url: `https://github.com/example/${input.project.id}/pull/${input.pr.number}`,
              checkedAt: SCENARIO_NOW,
            },
          }),
      ...(input.checks === undefined ? {} : { checks: scenarioChecks(input.checks) }),
    },
    display: displayForState(input.state),
  };

  if (input.state !== "none") {
    const confidence = input.state === "unknown" ? "low" : "high";
    built.terminal = {
      provider: "tmux",
      state: "open",
      focusable: true,
      closeable: true,
      hasWorkspace: true,
      hasPrimaryAgentEndpoint: true,
      confidence,
      reason: "Scenario terminal.",
      observedAt: SCENARIO_NOW,
    };
    built.agent = {
      harness: input.project.harness,
      state: input.state,
      runId: `run_${input.id}`,
      sessionId: `ses_${input.id}`,
      confidence,
      reason: reasonForState(input.state),
      updatedAt: SCENARIO_NOW,
    };
  }

  return built;
}

function scenarioChecks(
  checks: NonNullable<ScenarioRowInput["checks"]>,
): NonNullable<WorktreeRow["worktree"]["checks"]> {
  if (checks === "pass") {
    return { state: "pass", total: 3, passed: 3, source: "github", checkedAt: SCENARIO_NOW };
  }
  if (checks === "running") {
    return { state: "running", total: 3, pending: 2, source: "github", checkedAt: SCENARIO_NOW };
  }
  return {
    state: "fail",
    total: 3,
    failed: checks.failed,
    source: "github",
    checkedAt: SCENARIO_NOW,
  };
}

type SnapshotExtras = {
  projects: readonly ScenarioProject[];
  providerHealth?: Record<string, ProviderHealth>;
  alerts?: StationSnapshot["alerts"];
};

function snapshotFromRows(rows: WorktreeRow[], extras: SnapshotExtras): StationSnapshot {
  const projects = extras.projects.map((project) => projectView(project, rows));
  const sessions = rows.flatMap((candidate) =>
    candidate.agent?.sessionId === undefined ? [] : [sessionForRow(candidate)],
  );
  const counts = countsForRows(rows);
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    generatedAt: SCENARIO_NOW,
    observer: {
      pid: 4242,
      startedAt: "2026-06-12T11:55:00.000Z",
      version: "0.0.0-station-scenario",
      healthy: true,
    },
    providerHealth: extras.providerHealth ?? {},
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
    alerts: extras.alerts ?? [],
  } satisfies StationSnapshot;
}

function projectView(project: ScenarioProject, rows: readonly WorktreeRow[]): ProjectView {
  const projectRows = rows.filter((candidate) => candidate.projectId === project.id);
  return {
    id: project.id,
    label: project.label,
    root: `/Users/example/Developer/${project.id}`,
    defaults: {
      harness: project.harness,
      terminal: "tmux",
      layout: "agent-build-shell",
    },
    health: {
      providerId: "worktrunk",
      providerType: "worktree",
      status: "healthy",
      lastCheckedAt: SCENARIO_NOW,
    },
    counts: countsForRows(projectRows),
  };
}

function sessionForRow(candidate: WorktreeRow): SessionView {
  if (candidate.agent === undefined || candidate.terminal === undefined) {
    throw new Error("Cannot create a session for a row without an agent and terminal.");
  }
  return {
    id: candidate.agent.sessionId ?? `ses_${candidate.id}`,
    projectId: candidate.projectId,
    worktreeId: candidate.id,
    createdAt: "2026-06-12T11:59:00.000Z",
    updatedAt: SCENARIO_NOW,
    harness: {
      provider: candidate.agent.harness,
      mode: "interactive",
      runId: candidate.agent.runId,
      capabilities: {
        canLaunch: true,
        canDiscoverRuns: true,
        canEmitEvents: true,
        canClassifyStatus: true,
        canReceivePrompt: false,
        canResume: true,
        canStop: true,
        canRunNonInteractive: true,
        canExposeApprovalState: true,
        supportsModifiedEnterSoftNewline: candidate.agent.harness === "codex",
      },
    },
    terminal: {
      provider: candidate.terminal.provider,
      state: candidate.terminal.state,
      focusable: true,
      closeable: true,
      hasWorkspace: true,
      hasPrimaryAgentEndpoint: true,
      confidence: candidate.terminal.confidence,
      reason: candidate.terminal.reason,
      observedAt: SCENARIO_NOW,
    },
    status: {
      value: candidate.agent.state,
      confidence: candidate.agent.confidence,
      reason: candidate.agent.reason,
      source: "harness_event",
      updatedAt: SCENARIO_NOW,
    },
    title: candidate.branch,
    tags: [candidate.agent.harness, candidate.terminal.provider],
  };
}

function displayForState(state: AgentScenarioState): WorktreeRow["display"] {
  switch (state) {
    case "needs_attention":
      return { statusLabel: "needs attention", sortPriority: 10, alert: true, reason: reasonForState(state) };
    case "stuck":
      return { statusLabel: "stuck", sortPriority: 20, alert: true, reason: reasonForState(state) };
    case "working":
      return { statusLabel: "working", sortPriority: 30, alert: false, reason: reasonForState(state) };
    case "starting":
      return { statusLabel: "starting", sortPriority: 35, alert: false, reason: reasonForState(state) };
    case "idle":
      return { statusLabel: "idle", sortPriority: 40, alert: false, reason: reasonForState(state) };
    case "unknown":
      return { statusLabel: "unknown", sortPriority: 50, alert: false, reason: reasonForState(state) };
    case "exited":
      return { statusLabel: "exited", sortPriority: 60, alert: false, reason: reasonForState(state) };
    case "none":
      return {
        statusLabel: "no agent",
        sortPriority: 70,
        alert: false,
        reason: "No harness run is associated with this worktree.",
      };
  }
}

function reasonForState(state: Exclude<AgentScenarioState, "none">): string {
  switch (state) {
    case "needs_attention":
      return "Agent needs approval.";
    case "stuck":
      return "No progress was observed recently.";
    case "working":
      return "Harness reported active generation.";
    case "starting":
      return "Harness run is starting.";
    case "idle":
      return "Harness reported the turn completed.";
    case "unknown":
      return "Observer cannot classify this run confidently.";
    case "exited":
      return "Harness process exited.";
  }
}

function countsForRows(rows: readonly WorktreeRow[]) {
  return {
    worktrees: rows.length,
    agents: rows.filter((candidate) => candidate.agent !== undefined).length,
    working: rows.filter((candidate) => candidate.display.statusLabel === "working").length,
    idle: rows.filter((candidate) => candidate.display.statusLabel === "idle").length,
    attention: rows.filter((candidate) => candidate.display.statusLabel === "needs attention").length,
    unknown: rows.filter((candidate) => candidate.display.statusLabel === "unknown").length,
  };
}
