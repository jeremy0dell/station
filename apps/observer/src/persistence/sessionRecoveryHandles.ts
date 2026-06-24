import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SessionRecoveryHandle } from "@station/contracts";
import { SessionRecoveryHandleSchema } from "@station/contracts";
import type { ListSessionRecoveryHandlesOptions } from "./types.js";

type SqliteSessionRecoveryHandleRow = {
  id: string;
  provider: string;
  project_id: string;
  worktree_id: string;
  session_id: string | null;
  target_kind: "native-session" | "session-file";
  target_value: string;
  cwd: string | null;
  terminal_target_id: string | null;
  harness_run_id: string | null;
  observed_at: string;
  last_seen_at: string;
};

export function upsertSessionRecoveryHandle(
  database: DatabaseSync,
  input: SessionRecoveryHandle,
): SessionRecoveryHandle {
  // Ingress report ids are per event. Recovery handles need a stable identity
  // for the same provider-native target so snapshots and TUI actions can refer
  // to one durable handle as hooks refresh last_seen_at.
  const handle = SessionRecoveryHandleSchema.parse({
    ...input,
    id: recoveryHandleId(input),
  });
  const targetValue = recoveryTargetValue(handle);

  // Providers may omit different correlation fields on repeated reports. Keep
  // previously observed metadata unless a newer report supplies a replacement,
  // while always refreshing the handle's owning worktree and liveness.
  database
    .prepare(
      `
        INSERT INTO session_recovery_handles
          (id, provider, project_id, worktree_id, session_id, target_kind, target_value, cwd, terminal_target_id, harness_run_id, observed_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, target_kind, target_value) DO UPDATE SET
          id = excluded.id,
          project_id = excluded.project_id,
          worktree_id = excluded.worktree_id,
          session_id = COALESCE(excluded.session_id, session_recovery_handles.session_id),
          cwd = COALESCE(excluded.cwd, session_recovery_handles.cwd),
          terminal_target_id = COALESCE(excluded.terminal_target_id, session_recovery_handles.terminal_target_id),
          harness_run_id = COALESCE(excluded.harness_run_id, session_recovery_handles.harness_run_id),
          observed_at = CASE
            WHEN session_recovery_handles.observed_at <= excluded.observed_at
            THEN session_recovery_handles.observed_at
            ELSE excluded.observed_at
          END,
          last_seen_at = excluded.last_seen_at
      `,
    )
    .run(
      handle.id,
      handle.provider,
      handle.projectId,
      handle.worktreeId,
      handle.sessionId ?? null,
      handle.target.kind,
      targetValue,
      handle.cwd ?? null,
      handle.terminalTargetId ?? null,
      handle.harnessRunId ?? null,
      handle.observedAt,
      handle.lastSeenAt,
    );

  const row = database
    .prepare("SELECT * FROM session_recovery_handles WHERE id = ?")
    .get(handle.id) as SqliteSessionRecoveryHandleRow | undefined;
  if (row === undefined) {
    throw new Error(`Failed to upsert session recovery handle ${handle.id}.`);
  }
  return handleFromRow(row);
}

export function getSessionRecoveryHandle(
  database: DatabaseSync,
  handleId: string,
): SessionRecoveryHandle | undefined {
  const row = database
    .prepare("SELECT * FROM session_recovery_handles WHERE id = ?")
    .get(handleId) as SqliteSessionRecoveryHandleRow | undefined;
  return row === undefined ? undefined : handleFromRow(row);
}

export function listSessionRecoveryHandles(
  database: DatabaseSync,
  options: ListSessionRecoveryHandlesOptions = {},
): SessionRecoveryHandle[] {
  const rows = database
    .prepare("SELECT * FROM session_recovery_handles ORDER BY last_seen_at DESC, id")
    .all() as SqliteSessionRecoveryHandleRow[];
  return rows.map(handleFromRow).filter((handle) => matchesOptions(handle, options));
}

function handleFromRow(row: SqliteSessionRecoveryHandleRow): SessionRecoveryHandle {
  const handle: SessionRecoveryHandle = {
    id: row.id,
    provider: row.provider,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    target:
      row.target_kind === "native-session"
        ? { kind: "native-session", id: row.target_value }
        : { kind: "session-file", path: row.target_value },
    observedAt: row.observed_at,
    lastSeenAt: row.last_seen_at,
  };
  if (row.session_id !== null) handle.sessionId = row.session_id;
  if (row.cwd !== null) handle.cwd = row.cwd;
  if (row.terminal_target_id !== null) handle.terminalTargetId = row.terminal_target_id;
  if (row.harness_run_id !== null) handle.harnessRunId = row.harness_run_id;
  return SessionRecoveryHandleSchema.parse(handle);
}

function matchesOptions(
  handle: SessionRecoveryHandle,
  options: ListSessionRecoveryHandlesOptions,
): boolean {
  if (options.projectId !== undefined && handle.projectId !== options.projectId) {
    return false;
  }
  if (options.worktreeId !== undefined && handle.worktreeId !== options.worktreeId) {
    return false;
  }
  if (options.provider !== undefined && handle.provider !== options.provider) {
    return false;
  }
  return true;
}

function recoveryHandleId(handle: SessionRecoveryHandle): string {
  // The deterministic key is intentionally narrow: no prompts, transcripts,
  // provider payloads, or diagnostics become part of durable recovery identity.
  const key = `${handle.provider}\u0000${handle.target.kind}\u0000${recoveryTargetValue(handle)}`;
  return `rec_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function recoveryTargetValue(handle: SessionRecoveryHandle): string {
  switch (handle.target.kind) {
    case "native-session":
      return handle.target.id;
    case "session-file":
      return handle.target.path;
  }
}
