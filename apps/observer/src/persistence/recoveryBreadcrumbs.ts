import type { DatabaseSync } from "node:sqlite";
import { stringifyJson } from "./json.js";
import { recoveryBreadcrumbFromRow, type SqliteRecoveryBreadcrumbRow } from "./rows.js";
import type { PersistedRecoveryBreadcrumb } from "./types.js";

export function recordRecoveryBreadcrumb(
  database: DatabaseSync,
  input: {
    id: string;
    projectId: string;
    location: string;
    path: string;
    payload: unknown;
    worktreeId?: string;
    sessionId?: string;
    createdAt: string;
    lastSeenAt: string;
  },
): PersistedRecoveryBreadcrumb {
  database
    .prepare(
      `
        INSERT OR REPLACE INTO recovery_breadcrumbs
          (id, project_id, worktree_id, session_id, location, path, payload_json, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      input.id,
      input.projectId,
      input.worktreeId ?? null,
      input.sessionId ?? null,
      input.location,
      input.path,
      stringifyJson(input.payload),
      input.createdAt,
      input.lastSeenAt,
    );
  return readRecoveryBreadcrumb(database, input.id);
}

export function listRecoveryBreadcrumbs(database: DatabaseSync): PersistedRecoveryBreadcrumb[] {
  return (
    database
      .prepare("SELECT * FROM recovery_breadcrumbs ORDER BY last_seen_at, id")
      .all() as SqliteRecoveryBreadcrumbRow[]
  ).map(recoveryBreadcrumbFromRow);
}

function readRecoveryBreadcrumb(
  database: DatabaseSync,
  breadcrumbId: string,
): PersistedRecoveryBreadcrumb {
  return recoveryBreadcrumbFromRow(
    database
      .prepare("SELECT * FROM recovery_breadcrumbs WHERE id = ?")
      .get(breadcrumbId) as SqliteRecoveryBreadcrumbRow,
  );
}
