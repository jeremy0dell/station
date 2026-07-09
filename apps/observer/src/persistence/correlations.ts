import type {
  HarnessRunObservation,
  ProviderProjectConfig,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import {
  HarnessRunObservationSchema,
  TerminalTargetObservationSchema,
  WorktreeObservationSchema,
} from "@station/contracts";
import type { SqlDatabase } from "../sqlite/driver.js";
import { maxIso, optionalJson } from "./json.js";
import { insertProviderObservation } from "./observations.js";
import { providerObservationExpiresAt } from "./retention.js";
import {
  harnessRunFromRow,
  projectFromRow,
  type SqliteHarnessRunRow,
  type SqliteProjectRow,
  type SqliteSessionRow,
  type SqliteTerminalTargetRow,
  type SqliteWorktreeRow,
  sessionFromRow,
  terminalTargetFromRow,
  worktreeFromRow,
} from "./rows.js";
import { stripTerminalProviderData } from "./terminalObservations.js";
import type {
  ObserverIdFactory,
  PersistedHarnessRun,
  PersistedProject,
  PersistedSession,
  PersistedTerminalTarget,
  PersistedWorktree,
  PersistReconcileResultInput,
} from "./types.js";

type ProjectPersistenceInput = {
  id: string;
  label: string;
  root: string;
  repo?: string;
};

export function persistReconcileResult(
  database: SqlDatabase,
  input: PersistReconcileResultInput,
  options: { observedAt: string; idFactory: ObserverIdFactory },
): void {
  for (const project of input.projects) {
    upsertProject(database, projectPersistenceInput(project), options.observedAt);
  }
  for (const worktree of input.worktrees.map((value) => WorktreeObservationSchema.parse(value))) {
    upsertWorktree(database, worktree);
    insertProviderObservation(database, {
      id: options.idFactory.observationId(),
      provider: worktree.provider,
      providerType: "worktree",
      entityKind: "worktree",
      entityKey: worktree.id,
      payload: worktree,
      observedAt: worktree.observedAt,
      expiresAt: expiresAtFor(input, worktree.observedAt),
      coalesceUnchanged: true,
    });
  }
  for (const target of input.terminalTargets.map((value) =>
    stripTerminalProviderData(TerminalTargetObservationSchema.parse(value)),
  )) {
    upsertTerminalTarget(database, target);
    insertProviderObservation(database, {
      id: options.idFactory.observationId(),
      provider: target.provider,
      providerType: "terminal",
      entityKind: "terminal_target",
      entityKey: target.id,
      payload: target,
      observedAt: target.observedAt,
      expiresAt: expiresAtFor(input, target.observedAt),
      coalesceUnchanged: true,
    });
  }
  for (const run of input.harnessRuns.map((value) => HarnessRunObservationSchema.parse(value))) {
    upsertHarnessRun(database, run);
    insertProviderObservation(database, {
      id: options.idFactory.observationId(),
      provider: run.provider,
      providerType: "harness",
      entityKind: "harness_run",
      entityKey: run.id,
      payload: run,
      observedAt: run.observedAt,
      expiresAt: expiresAtFor(input, run.observedAt),
      coalesceUnchanged: true,
    });
  }
  if (input.providerHealth !== undefined) {
    for (const health of Object.values(input.providerHealth)) {
      insertProviderObservation(database, {
        id: options.idFactory.observationId(),
        provider: health.providerId,
        providerType: "observer",
        entityKind: "provider_health",
        entityKey: health.providerId,
        payload: health,
        observedAt: health.lastCheckedAt,
        expiresAt: expiresAtFor(input, health.lastCheckedAt),
        coalesceUnchanged: true,
      });
    }
  }
  upsertSessions(database, input.terminalTargets, input.harnessRuns, input.worktrees);
}

function expiresAtFor(input: PersistReconcileResultInput, observedAt: string): string | undefined {
  if (input.providerObservationRetentionDays !== undefined) {
    return providerObservationExpiresAt(observedAt, input.providerObservationRetentionDays);
  }
  return input.expiresAt;
}

export function listProjects(database: SqlDatabase): PersistedProject[] {
  return (database.prepare("SELECT * FROM projects ORDER BY id").all() as SqliteProjectRow[]).map(
    projectFromRow,
  );
}

export function listWorktrees(database: SqlDatabase): PersistedWorktree[] {
  return (database.prepare("SELECT * FROM worktrees ORDER BY id").all() as SqliteWorktreeRow[]).map(
    worktreeFromRow,
  );
}

export function listTerminalTargets(database: SqlDatabase): PersistedTerminalTarget[] {
  return (
    database
      .prepare("SELECT * FROM terminal_targets ORDER BY id")
      .all() as SqliteTerminalTargetRow[]
  ).map(terminalTargetFromRow);
}

export function listHarnessRuns(database: SqlDatabase): PersistedHarnessRun[] {
  return (
    database.prepare("SELECT * FROM harness_runs ORDER BY id").all() as SqliteHarnessRunRow[]
  ).map(harnessRunFromRow);
}

export function listSessions(database: SqlDatabase): PersistedSession[] {
  return (database.prepare("SELECT * FROM sessions ORDER BY id").all() as SqliteSessionRow[]).map(
    sessionFromRow,
  );
}

export function renameSession(
  database: SqlDatabase,
  input: { sessionId: string; title: string },
): PersistedSession | undefined {
  database.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(input.title, input.sessionId);
  const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(input.sessionId) as
    | SqliteSessionRow
    | undefined;
  return row === undefined ? undefined : sessionFromRow(row);
}

export function seedSessionTitle(
  database: SqlDatabase,
  input: {
    sessionId: string;
    projectId: string;
    worktreeId: string;
    title: string;
    createdAt: string;
    lastSeenAt: string;
  },
): PersistedSession {
  database
    .prepare(
      `
        INSERT INTO sessions
          (id, project_id, worktree_id, title, created_at, ended_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          worktree_id = excluded.worktree_id,
          title = COALESCE(sessions.title, excluded.title),
          last_seen_at = excluded.last_seen_at
      `,
    )
    .run(
      input.sessionId,
      input.projectId,
      input.worktreeId,
      input.title,
      input.createdAt,
      input.lastSeenAt,
    );

  const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(input.sessionId) as
    | SqliteSessionRow
    | undefined;
  if (row === undefined) {
    throw new Error(`Failed to seed session title for ${input.sessionId}.`);
  }
  return sessionFromRow(row);
}

export function deleteSessionTitleSeed(database: SqlDatabase, sessionId: string): number {
  const result = database.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  return Number(result.changes);
}

function upsertProject(
  database: SqlDatabase,
  project: ProjectPersistenceInput,
  lastSeenAt: string,
): void {
  database
    .prepare(
      `
        INSERT INTO projects (id, label, root, repo, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          root = excluded.root,
          repo = excluded.repo,
          last_seen_at = excluded.last_seen_at
      `,
    )
    .run(project.id, project.label, project.root, project.repo ?? null, lastSeenAt);
}

function projectPersistenceInput(project: ProviderProjectConfig): ProjectPersistenceInput {
  return {
    id: project.id,
    label: project.label,
    root: project.root,
  };
}

function upsertWorktree(database: SqlDatabase, worktree: WorktreeObservation): void {
  database
    .prepare(
      `
        INSERT INTO worktrees
          (id, project_id, path, branch, source, state, dirty, provider, provider_data_json, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          path = excluded.path,
          branch = excluded.branch,
          source = excluded.source,
          state = excluded.state,
          dirty = excluded.dirty,
          provider = excluded.provider,
          provider_data_json = excluded.provider_data_json,
          last_seen_at = excluded.last_seen_at
      `,
    )
    .run(
      worktree.id,
      worktree.projectId,
      worktree.path,
      worktree.branch,
      worktree.source,
      worktree.state,
      worktree.dirty === undefined ? null : Number(worktree.dirty),
      worktree.provider,
      optionalJson(worktree.providerData),
      worktree.observedAt,
    );
}

function upsertTerminalTarget(database: SqlDatabase, target: TerminalTargetObservation): void {
  database
    .prepare(
      `
        INSERT INTO terminal_targets
          (id, session_id, project_id, worktree_id, provider, state, provider_key, provider_data_json, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_id = excluded.session_id,
          project_id = excluded.project_id,
          worktree_id = excluded.worktree_id,
          provider = excluded.provider,
          state = excluded.state,
          provider_key = excluded.provider_key,
          provider_data_json = excluded.provider_data_json,
          last_seen_at = excluded.last_seen_at
      `,
    )
    .run(
      target.id,
      target.sessionId ?? null,
      target.projectId ?? null,
      target.worktreeId ?? null,
      target.provider,
      target.state,
      target.id,
      null,
      target.observedAt,
    );
}

function upsertHarnessRun(database: SqlDatabase, run: HarnessRunObservation): void {
  database
    .prepare(
      `
        INSERT INTO harness_runs
          (id, session_id, project_id, worktree_id, harness, pid, external_run_id, state, confidence, reason, provider_data_json, last_event_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_id = excluded.session_id,
          project_id = excluded.project_id,
          worktree_id = excluded.worktree_id,
          harness = excluded.harness,
          pid = excluded.pid,
          external_run_id = excluded.external_run_id,
          state = excluded.state,
          confidence = excluded.confidence,
          reason = excluded.reason,
          provider_data_json = excluded.provider_data_json,
          last_event_at = excluded.last_event_at,
          last_seen_at = excluded.last_seen_at
      `,
    )
    .run(
      run.id,
      run.sessionId ?? null,
      run.projectId ?? null,
      run.worktreeId ?? null,
      run.provider,
      run.pid ?? null,
      run.id,
      run.state,
      run.confidence,
      run.reason,
      optionalJson(run.providerData),
      run.observedAt,
      run.observedAt,
    );
}

function upsertSessions(
  database: SqlDatabase,
  terminalTargets: TerminalTargetObservation[],
  harnessRuns: HarnessRunObservation[],
  worktrees: WorktreeObservation[],
): void {
  // Sessions are reconstructed from two partial truths: terminal bindings identify
  // the workspace, while harness runs supply agent state.
  const worktreesById = new Map(worktrees.map((worktree) => [worktree.id, worktree]));
  const sessions = new Map<string, PersistedSession>();

  for (const target of terminalTargets) {
    if (
      target.sessionId === undefined ||
      target.projectId === undefined ||
      target.worktreeId === undefined
    ) {
      continue;
    }
    const session: PersistedSession = {
      id: target.sessionId,
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      terminalProvider: target.provider,
      state: target.state,
      createdAt: target.observedAt,
      lastSeenAt: target.observedAt,
    };
    const title = sessionTitleForWorktree(worktreesById, target.worktreeId);
    if (title !== undefined) {
      session.title = title;
    }
    sessions.set(target.sessionId, session);
  }

  for (const run of harnessRuns) {
    if (
      run.sessionId === undefined ||
      run.projectId === undefined ||
      run.worktreeId === undefined
    ) {
      continue;
    }
    const existing = sessions.get(run.sessionId);
    const session: PersistedSession = {
      id: run.sessionId,
      projectId: run.projectId,
      worktreeId: run.worktreeId,
      harness: run.provider,
      state: run.state,
      createdAt: existing?.createdAt ?? run.observedAt,
      lastSeenAt: maxIso(existing?.lastSeenAt, run.observedAt),
    };
    const title = sessionTitleForWorktree(worktreesById, run.worktreeId);
    if (title !== undefined) {
      session.title = title;
    } else if (existing?.title !== undefined) {
      session.title = existing.title;
    }
    if (existing?.terminalProvider !== undefined) {
      session.terminalProvider = existing.terminalProvider;
    }
    sessions.set(run.sessionId, session);
  }

  for (const session of sessions.values()) {
    database
      .prepare(
        `
          INSERT INTO sessions
            (id, project_id, worktree_id, title, harness, terminal_provider, state, created_at, ended_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
          ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            worktree_id = excluded.worktree_id,
            title = COALESCE(sessions.title, excluded.title),
            harness = COALESCE(excluded.harness, sessions.harness),
            terminal_provider = COALESCE(excluded.terminal_provider, sessions.terminal_provider),
            state = excluded.state,
            last_seen_at = excluded.last_seen_at
        `,
      )
      .run(
        session.id,
        session.projectId,
        session.worktreeId,
        session.title ?? null,
        session.harness ?? null,
        session.terminalProvider ?? null,
        session.state ?? null,
        session.createdAt,
        session.lastSeenAt,
      );
  }
}

function sessionTitleForWorktree(
  worktreesById: ReadonlyMap<string, WorktreeObservation>,
  worktreeId: string,
): string | undefined {
  return worktreesById.get(worktreeId)?.branch;
}
