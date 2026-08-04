import type { SqlDatabase } from "../sqlite/driver.js";
import { type SqliteWorktreeDisplayTitleRow, worktreeDisplayTitleFromRow } from "./rows.js";
import type { PersistedWorktreeDisplayTitle } from "./types.js";

export function listWorktreeDisplayTitles(database: SqlDatabase): PersistedWorktreeDisplayTitle[] {
  const rows = database
    .prepare(
      `
        SELECT project_id, worktree_id, title, created_at, updated_at
        FROM worktree_display_titles
        ORDER BY project_id ASC, worktree_id ASC
      `,
    )
    .all() as SqliteWorktreeDisplayTitleRow[];
  return rows.map(worktreeDisplayTitleFromRow);
}

export function readWorktreeDisplayTitle(
  database: SqlDatabase,
  input: { projectId: string; worktreeId: string },
): PersistedWorktreeDisplayTitle | undefined {
  const row = database
    .prepare(
      `
        SELECT project_id, worktree_id, title, created_at, updated_at
        FROM worktree_display_titles
        WHERE project_id = ? AND worktree_id = ?
      `,
    )
    .get(input.projectId, input.worktreeId) as SqliteWorktreeDisplayTitleRow | undefined;
  return row === undefined ? undefined : worktreeDisplayTitleFromRow(row);
}

export function insertMissingWorktreeDisplayTitles(
  database: SqlDatabase,
  titles: readonly PersistedWorktreeDisplayTitle[],
): void {
  const insert = database.prepare(
    `
      INSERT INTO worktree_display_titles
        (project_id, worktree_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, worktree_id) DO NOTHING
    `,
  );
  for (const title of titles) {
    insert.run(title.projectId, title.worktreeId, title.title, title.createdAt, title.updatedAt);
  }
}

export function upsertWorktreeDisplayTitle(
  database: SqlDatabase,
  input: PersistedWorktreeDisplayTitle,
): PersistedWorktreeDisplayTitle {
  database
    .prepare(
      `
        INSERT INTO worktree_display_titles
          (project_id, worktree_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, worktree_id) DO UPDATE SET
          title = excluded.title,
          updated_at = excluded.updated_at
      `,
    )
    .run(input.projectId, input.worktreeId, input.title, input.createdAt, input.updatedAt);
  const title = readWorktreeDisplayTitle(database, input);
  if (title === undefined) {
    throw new Error(`Failed to persist worktree display title for ${input.worktreeId}.`);
  }
  return title;
}

export function deleteWorktreeDisplayTitle(
  database: SqlDatabase,
  input: { projectId: string; worktreeId: string },
): number {
  const result = database
    .prepare(
      `
        DELETE FROM worktree_display_titles
        WHERE project_id = ? AND worktree_id = ?
      `,
    )
    .run(input.projectId, input.worktreeId);
  return Number(result.changes);
}

export function synchronizeSessionTitleProjections(
  database: SqlDatabase,
  title: PersistedWorktreeDisplayTitle,
): void {
  database
    .prepare(
      `
        UPDATE sessions
        SET title = ?
        WHERE project_id = ? AND worktree_id = ?
      `,
    )
    .run(title.title, title.projectId, title.worktreeId);
}
