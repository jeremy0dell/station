import { AgentStateSchema } from "@station/contracts";
import { decideSessionHarnessExecution } from "../harnessExecutionIdentity.js";
import type { SqlDatabase } from "../sqlite/driver.js";
import type { PersistedSessionHarnessExecution, SessionHarnessExecutionEvidence } from "./types.js";

type SqliteSessionHarnessExecutionRow = {
  provider: string;
  session_id: string;
  native_session_id: string;
  state: string;
  status_updated_at: string;
};

export function applySessionHarnessExecutionEvidence(
  database: SqlDatabase,
  evidence: SessionHarnessExecutionEvidence,
): boolean {
  const current =
    evidence.sessionId === undefined
      ? undefined
      : getSessionHarnessExecution(database, {
          provider: evidence.provider,
          sessionId: evidence.sessionId,
        });
  const decision = decideSessionHarnessExecution({ current, evidence });
  if (decision.binding !== undefined) upsertSessionHarnessExecution(database, decision.binding);
  return decision.mayDeriveState;
}

export function getSessionHarnessExecution(
  database: SqlDatabase,
  input: { provider: string; sessionId: string },
): PersistedSessionHarnessExecution | undefined {
  const row = database
    .prepare("SELECT * FROM session_harness_executions WHERE provider = ? AND session_id = ?")
    .get(input.provider, input.sessionId) as SqliteSessionHarnessExecutionRow | undefined;
  return row === undefined ? undefined : sessionHarnessExecutionFromRow(row);
}

export function listSessionHarnessExecutions(
  database: SqlDatabase,
): PersistedSessionHarnessExecution[] {
  return (
    database
      .prepare("SELECT * FROM session_harness_executions ORDER BY provider, session_id")
      .all() as SqliteSessionHarnessExecutionRow[]
  ).map(sessionHarnessExecutionFromRow);
}

function upsertSessionHarnessExecution(
  database: SqlDatabase,
  binding: PersistedSessionHarnessExecution,
): void {
  database
    .prepare(
      `
        INSERT INTO session_harness_executions
          (provider, session_id, native_session_id, state, status_updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, session_id) DO UPDATE SET
          native_session_id = excluded.native_session_id,
          state = excluded.state,
          status_updated_at = excluded.status_updated_at
      `,
    )
    .run(
      binding.provider,
      binding.sessionId,
      binding.nativeSessionId,
      binding.state,
      binding.statusUpdatedAt,
    );
}

function sessionHarnessExecutionFromRow(
  row: SqliteSessionHarnessExecutionRow,
): PersistedSessionHarnessExecution {
  return {
    provider: row.provider,
    sessionId: row.session_id,
    nativeSessionId: row.native_session_id,
    state: AgentStateSchema.parse(row.state),
    statusUpdatedAt: row.status_updated_at,
  };
}
