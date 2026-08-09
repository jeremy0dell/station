import type { SessionGroupId, SessionGroupView } from "@station/contracts";
import type { SqlDatabase } from "../sqlite/driver.js";
import { type SqliteSessionGroupRow, sessionGroupFromRow } from "./rows.js";
import type { SessionGroupPersistenceState } from "./sessionGroups.js";

export function readSessionGroupState(database: SqlDatabase): SessionGroupPersistenceState {
  const membershipRows = database
    .prepare(
      "SELECT session_id, group_id, project_id FROM session_group_memberships ORDER BY session_id",
    )
    .all() as Array<{ session_id: string; group_id: string; project_id: string }>;
  const membershipsByGroup = new Map<string, string[]>();
  const assignments = new Map<string, { groupId: SessionGroupId; projectId: string }>();
  for (const row of membershipRows) {
    assignments.set(row.session_id, { groupId: row.group_id, projectId: row.project_id });
    const members = membershipsByGroup.get(row.group_id) ?? [];
    members.push(row.session_id);
    membershipsByGroup.set(row.group_id, members);
  }
  const rows = database
    .prepare(
      `SELECT id, project_id, name, parent_group_id, version, created_at, updated_at
       FROM session_groups ORDER BY project_id, id`,
    )
    .all() as Array<Omit<SqliteSessionGroupRow, "session_ids_json">>;
  const groups = new Map<SessionGroupId, SessionGroupView>();
  for (const row of rows) {
    const group = sessionGroupFromRow({
      ...row,
      session_ids_json: JSON.stringify(membershipsByGroup.get(row.id) ?? []),
    });
    groups.set(group.id, group);
  }
  if ([...assignments.values()].some((assignment) => !groups.has(assignment.groupId))) {
    throw new Error("Session Group membership references a missing Group.");
  }
  return { groups, assignments };
}

export function writeSessionGroupState(
  database: SqlDatabase,
  before: SessionGroupPersistenceState,
  after: SessionGroupPersistenceState,
): void {
  const deleteMembership = database.prepare(
    "DELETE FROM session_group_memberships WHERE session_id = ?",
  );
  const insertMembership = database.prepare(
    "INSERT INTO session_group_memberships (session_id, group_id, project_id) VALUES (?, ?, ?)",
  );
  for (const sessionId of new Set([...before.assignments.keys(), ...after.assignments.keys()])) {
    const previous = before.assignments.get(sessionId);
    const next = after.assignments.get(sessionId);
    if (previous?.groupId === next?.groupId && previous?.projectId === next?.projectId) continue;
    if (previous !== undefined) deleteMembership.run(sessionId);
    if (next !== undefined) insertMembership.run(sessionId, next.groupId, next.projectId);
  }

  const deleteGroup = database.prepare("DELETE FROM session_groups WHERE id = ?");
  for (const id of before.groups.keys()) {
    if (!after.groups.has(id)) deleteGroup.run(id);
  }
  const upsertGroup = database.prepare(`
    INSERT INTO session_groups
      (id, project_id, name, parent_group_id, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id,
      name = excluded.name,
      parent_group_id = excluded.parent_group_id,
      version = excluded.version,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `);
  for (const [id, group] of after.groups) {
    if (JSON.stringify(before.groups.get(id)) === JSON.stringify(group)) continue;
    upsertGroup.run(
      group.id,
      group.projectId,
      group.name,
      group.parentGroupId ?? null,
      group.version,
      group.createdAt,
      group.updatedAt,
    );
  }
}
