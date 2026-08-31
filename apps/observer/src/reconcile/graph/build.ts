import type { SessionView, StationSnapshot, WorktreeRow } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { countsForSnapshot } from "../snapshotCounts.js";
import type { ObserverGraphInput } from "./evidence.js";
import { chooseHarnessRun, chooseTerminal } from "./observations.js";
import { projectOrphanedRuntimeState } from "./orphans.js";
import { alertsFromProviderHealth, unknownProviderHealth } from "./providerHealth.js";
import {
  type BuildSessionInput,
  buildSessions,
  newestRetainedSessionByWorktree,
  sessionWorktreeKey,
} from "./sessions.js";
import {
  attachTurnReadiness,
  type BuildWorktreeRowInput,
  buildWorktreeRow,
  compareRows,
  recoveryActionForRow,
} from "./worktreeRows.js";

/**
 * POLICY
 *
 * Correlates provider observations with canonical worktree title input and durable session records.
 * Branch names remain only the defensive title fallback when persistence is unavailable.
 */
export function buildStationSnapshot(input: ObserverGraphInput): StationSnapshot {
  const projectsById = new Map(input.projects.map((project) => [project.id, project]));
  const configuredWorktrees = input.worktrees.filter(
    (worktree) => projectsById.has(worktree.projectId) && worktree.state === "exists",
  );
  const worktreesById = new Map(configuredWorktrees.map((worktree) => [worktree.id, worktree]));
  const harnessRuns = input.harnessRuns;
  const harnessRunsById = new Map(harnessRuns.map((run) => [run.id, run]));
  const sessionMetadataById = new Map(
    input.sessionMetadata?.map((session) => [session.id, session]),
  );
  const titleByWorktree = new Map(
    input.worktreeDisplayTitles?.map((title) => [
      sessionWorktreeKey(title.projectId, title.worktreeId),
      title.title,
    ]),
  );
  const retainedSessionByWorktree = newestRetainedSessionByWorktree(input.sessionMetadata ?? []);
  const turnReadinessBySessionId = new Map(
    input.turnReadiness?.map((readiness) => [readiness.sessionId, readiness]),
  );
  const providerAlerts = alertsFromProviderHealth(input.providerHealth, input.generatedAt);
  const alerts = [...providerAlerts, ...(input.alerts ?? [])];
  const allRows: WorktreeRow[] = [];
  const sessions: SessionView[] = [];

  for (const project of input.projects) {
    const rowsForProject = configuredWorktrees
      .filter((worktree) => worktree.projectId === project.id)
      .map((worktree) => {
        const terminal = chooseTerminal(worktree, input.terminalTargets);
        const harnessRun = chooseHarnessRun(worktree, terminal, harnessRuns);
        const terminalCapabilities =
          terminal === undefined
            ? undefined
            : input.providerHealth[terminal.provider]?.capabilities;
        const title =
          titleByWorktree.get(sessionWorktreeKey(project.id, worktree.id)) ?? worktree.branch;
        const rowInput: BuildWorktreeRowInput = {
          project,
          worktree,
          title,
        };
        if (terminal !== undefined) rowInput.terminal = terminal;
        if (harnessRun !== undefined) rowInput.harnessRun = harnessRun;
        if (terminalCapabilities !== undefined)
          rowInput.terminalCapabilities = terminalCapabilities;
        const row = buildWorktreeRow(rowInput);
        attachTurnReadiness(row, turnReadinessBySessionId);
        const retainedSession = retainedSessionByWorktree.get(
          sessionWorktreeKey(project.id, worktree.id),
        );
        const recovery = recoveryActionForRow({
          row,
          recoveryHandles: input.recoveryHandles ?? [],
          harnessCapabilities: input.harnessCapabilities ?? {},
          sessionMetadata: input.sessionMetadata ?? [],
          retainedSession,
          featureFlags: input.featureFlags,
        });
        if (recovery !== undefined) {
          row.recovery = recovery;
        }

        const sessionInput: BuildSessionInput = {
          project,
          worktree,
          title,
          harnessCapabilities: input.harnessCapabilities ?? {},
          sessionMetadataById,
        };
        if (terminal !== undefined) sessionInput.terminal = terminal;
        if (harnessRun !== undefined) sessionInput.harnessRun = harnessRun;
        if (terminalCapabilities !== undefined) {
          sessionInput.terminalCapabilities = terminalCapabilities;
        }
        if (retainedSession !== undefined) {
          sessionInput.retainedSession = retainedSession;
        }
        sessions.push(...buildSessions(sessionInput));

        return row;
      })
      .sort(compareRows);

    allRows.push(...rowsForProject);
  }

  const projects = input.projects.map((project) => {
    const rows = allRows.filter((row) => row.projectId === project.id);
    const projectSessions = sessions.filter((session) => session.projectId === project.id);
    return {
      id: project.id,
      label: project.label,
      root: project.root,
      defaults: project.defaults,
      health: input.providerHealth[input.worktreeProviderId] ?? unknownProviderHealth(input),
      counts: countsForSnapshot(rows, projectSessions),
    };
  });

  const counts = {
    projects: input.projects.length,
    ...countsForSnapshot(allRows, sessions),
  };

  const observerHealthy =
    input.observer.healthy ??
    (!alerts.some((alert) => alert.severity === "error") &&
      Object.values(input.providerHealth).every((health) => health.status !== "unavailable"));

  const snapshot: StationSnapshot = {
    schemaVersion: STATION_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    observer: {
      pid: input.observer.pid,
      startedAt: input.observer.startedAt,
      version: input.observer.version,
      healthy: observerHealthy,
    },
    providerHealth: input.providerHealth,
    projects,
    rows: allRows,
    sessions,
    sessionGroups: [],
    counts,
    alerts,
    ...(input.featureFlags === undefined ? {} : { featureFlags: input.featureFlags }),
    ...projectOrphanedRuntimeState(
      input,
      harnessRuns,
      worktreesById,
      projectsById,
      harnessRunsById,
    ),
  };
  if (input.harnesses !== undefined) {
    snapshot.harnesses = input.harnesses;
  }
  return snapshot;
}
