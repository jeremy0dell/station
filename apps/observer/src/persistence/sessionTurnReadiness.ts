import type { SqlDatabase } from "../sqlite/driver.js";
import type { PersistedSessionTurnReadiness } from "./types.js";

type SqliteSessionTurnReadinessRow = {
  session_id: string;
  project_id: string;
  worktree_id: string;
  token: string;
  completed_at: string;
  created_at: string;
  updated_at: string;
};

export function upsertSessionTurnReadiness(
  database: SqlDatabase,
  input: PersistedSessionTurnReadiness,
): PersistedSessionTurnReadiness {
  database
    .prepare(
      `
        INSERT INTO session_turn_readiness
          (session_id, project_id, worktree_id, token, completed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          project_id = excluded.project_id,
          worktree_id = excluded.worktree_id,
          token = excluded.token,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at
        WHERE session_turn_readiness.completed_at < excluded.completed_at
      `,
    )
    .run(
      input.sessionId,
      input.projectId,
      input.worktreeId,
      input.token,
      input.completedAt,
      input.createdAt,
      input.updatedAt,
    );

  const row = readSessionTurnReadiness(database, input.sessionId);
  if (row === undefined) {
    throw new Error(`Failed to upsert turn readiness for session ${input.sessionId}.`);
  }
  return row;
}

export function readSessionTurnReadiness(
  database: SqlDatabase,
  sessionId: string,
): PersistedSessionTurnReadiness | undefined {
  const row = database
    .prepare("SELECT * FROM session_turn_readiness WHERE session_id = ?")
    .get(sessionId) as SqliteSessionTurnReadinessRow | undefined;
  return row === undefined ? undefined : readinessFromRow(row);
}

export function listSessionTurnReadiness(database: SqlDatabase): PersistedSessionTurnReadiness[] {
  const rows = database
    .prepare("SELECT * FROM session_turn_readiness ORDER BY completed_at DESC, session_id")
    .all() as SqliteSessionTurnReadinessRow[];
  return rows.map(readinessFromRow);
}

export function deleteSessionTurnReadiness(
  database: SqlDatabase,
  input: { sessionId: string; token?: string },
): number {
  const result =
    input.token === undefined
      ? database
          .prepare("DELETE FROM session_turn_readiness WHERE session_id = ?")
          .run(input.sessionId)
      : database
          .prepare("DELETE FROM session_turn_readiness WHERE session_id = ? AND token = ?")
          .run(input.sessionId, input.token);
  return Number(result.changes);
}

function readinessFromRow(row: SqliteSessionTurnReadinessRow): PersistedSessionTurnReadiness {
  return {
    sessionId: row.session_id,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    token: row.token,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
