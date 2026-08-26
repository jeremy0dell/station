import type { ProviderId, WorktreeObservation } from "@station/contracts";
import {
  HarnessRunObservationSchema,
  sameObservedPath,
  TerminalTargetObservationSchema,
  WorktreeObservationSchema,
} from "@station/contracts";
import type { SqlDatabase } from "../sqlite/driver.js";
import { resolveWorktreeDisplayTitle } from "../worktreeDisplayTitle.js";
import { insertProviderObservation } from "./observations.js";
import { providerObservationExpiresAt } from "./retention.js";
import { type SqliteSessionRow, sessionFromRow } from "./rows.js";
import type {
  ObserverIdFactory,
  PersistedSession,
  PersistedWorktreeDisplayTitle,
  PersistReconcileResultInput,
} from "./types.js";
import {
  deleteWorktreeDisplayTitle,
  insertMissingWorktreeDisplayTitles,
  listWorktreeDisplayTitles,
  readWorktreeDisplayTitle,
  synchronizeSessionTitleProjections,
  upsertWorktreeDisplayTitle,
} from "./worktreeDisplayTitles.js";

const END_OPEN_SESSION_SQL = `
  UPDATE sessions
  SET lifecycle = 'ended', ended_at = ?
  WHERE id = ? AND (lifecycle IS NULL OR lifecycle = 'open')
`;

const END_OPEN_WORKTREE_SESSIONS_SQL = `
  UPDATE sessions
  SET lifecycle = 'ended', ended_at = ?
  WHERE project_id = ? AND worktree_id = ?
    AND (lifecycle IS NULL OR lifecycle = 'open')
`;

export function persistReconcileResult(
  database: SqlDatabase,
  input: PersistReconcileResultInput,
  options: { observedAt: string; idFactory: ObserverIdFactory },
): void {
  const worktrees = input.worktrees.map((value) => WorktreeObservationSchema.parse(value));
  for (const value of input.terminalTargets) TerminalTargetObservationSchema.parse(value);
  for (const value of input.harnessRuns) HarnessRunObservationSchema.parse(value);

  for (const worktree of worktrees) {
    rememberWorktreeIdentity(database, worktree);
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
  const resolvedTitles = resolveReconcileWorktreeDisplayTitles(database, input, options.observedAt);
  insertMissingWorktreeDisplayTitles(database, resolvedTitles);
}

function expiresAtFor(input: PersistReconcileResultInput, observedAt: string): string | undefined {
  if (input.providerObservationRetentionDays !== undefined) {
    return providerObservationExpiresAt(observedAt, input.providerObservationRetentionDays);
  }
  return input.expiresAt;
}

export function listSessions(database: SqlDatabase): PersistedSession[] {
  return (database.prepare("SELECT * FROM sessions ORDER BY id").all() as SqliteSessionRow[]).map(
    sessionFromRow,
  );
}

type RememberedHarnessSessionRow = {
  id: string;
  worktree_id: string;
  harness: ProviderId;
  created_at: string;
  last_seen_at: string;
  worktree_path: string | null;
};

export function findRememberedHarnessProviderForWorktree(
  database: SqlDatabase,
  input: { projectId: string; worktreeId: string; worktreePath: string },
): ProviderId | undefined {
  const rows = database
    .prepare(
      `
        SELECT
          sessions.id,
          sessions.worktree_id,
          sessions.harness,
          sessions.created_at,
          sessions.last_seen_at,
          worktrees.path AS worktree_path
        FROM sessions
        LEFT JOIN worktrees
          ON worktrees.id = sessions.worktree_id
          AND worktrees.project_id = sessions.project_id
        WHERE sessions.project_id = ?
          AND sessions.harness IS NOT NULL
        ORDER BY sessions.last_seen_at DESC, sessions.created_at DESC, sessions.id DESC
      `,
    )
    .all(input.projectId) as RememberedHarnessSessionRow[];

  const directMatch = rows.find((row) => row.worktree_id === input.worktreeId);
  if (directMatch !== undefined) {
    return directMatch.harness;
  }
  return rows.find(
    (row) => row.worktree_path !== null && sameObservedPath(row.worktree_path, input.worktreePath),
  )?.harness;
}

export function renameSession(
  database: SqlDatabase,
  input: { sessionId: string; title: string; renamedAt: string },
): PersistedSession | undefined {
  const existing = database.prepare("SELECT * FROM sessions WHERE id = ?").get(input.sessionId) as
    | SqliteSessionRow
    | undefined;
  if (existing === undefined) return undefined;

  const canonical = upsertWorktreeDisplayTitle(database, {
    projectId: existing.project_id,
    worktreeId: existing.worktree_id,
    title: input.title,
    createdAt: input.renamedAt,
    updatedAt: input.renamedAt,
  });
  synchronizeSessionTitleProjections(database, canonical);
  const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(input.sessionId) as
    | SqliteSessionRow
    | undefined;
  return row === undefined ? undefined : sessionFromRow(row);
}

export function markSessionsEnded(
  database: SqlDatabase,
  input: {
    subject:
      | { kind: "session"; sessionId: string }
      | { kind: "worktree"; projectId: string; worktreeId: string };
    endedAt: string;
  },
): number {
  const result =
    input.subject.kind === "session"
      ? database.prepare(END_OPEN_SESSION_SQL).run(input.endedAt, input.subject.sessionId)
      : database
          .prepare(END_OPEN_WORKTREE_SESSIONS_SQL)
          .run(input.endedAt, input.subject.projectId, input.subject.worktreeId);
  return Number(result.changes);
}

export function reopenSession(
  database: SqlDatabase,
  sessionId: string,
): PersistedSession | undefined {
  database
    .prepare("UPDATE sessions SET lifecycle = 'open', ended_at = NULL WHERE id = ?")
    .run(sessionId);
  const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
    | SqliteSessionRow
    | undefined;
  return row === undefined ? undefined : sessionFromRow(row);
}

export function seedSession(
  database: SqlDatabase,
  input: {
    sessionId: string;
    projectId: string;
    worktreeId: string;
    initialTitle: string;
    harness: ProviderId;
    terminalProvider: ProviderId;
    createdAt: string;
    lastSeenAt: string;
  },
): PersistedSession {
  const title = resolveWorktreeDisplayTitle({
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    branch: input.initialTitle,
    canonicalTitles: listCanonicalTitle(database, input),
    sessions: listSessions(database),
  });
  insertMissingWorktreeDisplayTitles(database, [
    {
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      title,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
  ]);
  const canonical = readWorktreeDisplayTitle(database, input);
  if (canonical === undefined) {
    throw new Error(`Failed to seed worktree display title for ${input.worktreeId}.`);
  }
  synchronizeSessionTitleProjections(database, canonical);

  database
    .prepare(
      `
        INSERT INTO sessions
          (id, project_id, worktree_id, title, harness, terminal_provider, created_at, ended_at, last_seen_at, lifecycle)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'open')
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          worktree_id = excluded.worktree_id,
          title = excluded.title,
          harness = excluded.harness,
          terminal_provider = excluded.terminal_provider,
          last_seen_at = excluded.last_seen_at,
          lifecycle = CASE
            WHEN sessions.lifecycle = 'ended' THEN 'ended'
            ELSE 'open'
          END
      `,
    )
    .run(
      input.sessionId,
      input.projectId,
      input.worktreeId,
      canonical.title,
      input.harness,
      input.terminalProvider,
      input.createdAt,
      input.lastSeenAt,
    );

  const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(input.sessionId) as
    | SqliteSessionRow
    | undefined;
  if (row === undefined) {
    throw new Error(`Failed to seed session for ${input.sessionId}.`);
  }
  return sessionFromRow(row);
}

export function discardSessionSeed(
  database: SqlDatabase,
  input: {
    sessionId: string;
    removedWorktree?: { projectId: string; worktreeId: string };
  },
): { discardedSessions: number; discardedWorktreeTitles: number } {
  const sessionResult = database.prepare("DELETE FROM sessions WHERE id = ?").run(input.sessionId);
  const discardedWorktreeTitles =
    input.removedWorktree === undefined
      ? 0
      : deleteWorktreeDisplayTitle(database, input.removedWorktree);
  return {
    discardedSessions: Number(sessionResult.changes),
    discardedWorktreeTitles,
  };
}

export function retireRemovedWorktreeSessionState(
  database: SqlDatabase,
  input: { projectId: string; worktreeId: string; endedAt: string },
): { endedSessions: number; deletedWorktreeTitles: number } {
  const endedSessions = markSessionsEnded(database, {
    subject: { kind: "worktree", projectId: input.projectId, worktreeId: input.worktreeId },
    endedAt: input.endedAt,
  });
  const deletedWorktreeTitles = deleteWorktreeDisplayTitle(database, input);
  return { endedSessions, deletedWorktreeTitles };
}

function resolveReconcileWorktreeDisplayTitles(
  database: SqlDatabase,
  input: PersistReconcileResultInput,
  observedAt: string,
): PersistedWorktreeDisplayTitle[] {
  if (input.worktreeDisplayTitles !== undefined) return input.worktreeDisplayTitles;

  const canonicalTitles = listWorktreeDisplayTitles(database);
  const sessions = listSessions(database);
  return input.worktrees
    .filter((worktree) => worktree.state === "exists")
    .map((worktree) => {
      const existing = canonicalTitles.find(
        (title) => title.projectId === worktree.projectId && title.worktreeId === worktree.id,
      );
      if (existing !== undefined) return existing;
      return {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        title: resolveWorktreeDisplayTitle({
          projectId: worktree.projectId,
          worktreeId: worktree.id,
          branch: worktree.branch,
          canonicalTitles,
          sessions,
        }),
        createdAt: observedAt,
        updatedAt: observedAt,
      };
    });
}

function listCanonicalTitle(
  database: SqlDatabase,
  input: { projectId: string; worktreeId: string },
): PersistedWorktreeDisplayTitle[] {
  const title = readWorktreeDisplayTitle(database, input);
  return title === undefined ? [] : [title];
}

function rememberWorktreeIdentity(database: SqlDatabase, worktree: WorktreeObservation): void {
  database
    .prepare(
      `
        INSERT INTO worktrees
          (id, project_id, path, provider, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `,
    )
    .run(worktree.id, worktree.projectId, worktree.path, worktree.provider, worktree.observedAt);
}
