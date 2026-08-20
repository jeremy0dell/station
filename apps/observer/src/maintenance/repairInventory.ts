import type {
  ObserverRepairInventory,
  RepairRecoveryHandle,
  RepairRetainedSession,
  SessionRecoveryHandle,
} from "@station/contracts";
import { ObserverRepairInventorySchema } from "@station/contracts";
import type { SessionStore } from "../persistence/ports.js";
import type { PersistedSession } from "../persistence/types.js";

/**
 * USE CASE
 *
 * Reads one transactionally coherent session/recovery snapshot and projects only
 * provider-neutral, redacted repair evidence. It never reconciles or writes durable state.
 */
export async function inspectObserverRepairInventory(input: {
  persistence: Pick<SessionStore, "readRepairInventory">;
}): Promise<ObserverRepairInventory> {
  const snapshot = await input.persistence.readRepairInventory();
  const sessions = snapshot.sessions.map(repairSession).sort(compareId);
  const recoveryHandles = snapshot.recoveryHandles.map(repairHandle).sort(compareId);
  return ObserverRepairInventorySchema.parse({
    schemaVersion: 1,
    sessions,
    recoveryHandles,
  });
}

function repairSession(session: PersistedSession): RepairRetainedSession {
  const result: RepairRetainedSession = {
    id: session.id,
    projectId: session.projectId,
    worktreeId: session.worktreeId,
    lifecycle: session.lifecycle,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
  };
  if (session.harness !== undefined) result.harnessProvider = session.harness;
  if (session.terminalProvider !== undefined) result.terminalProvider = session.terminalProvider;
  if (session.endedAt !== undefined) result.endedAt = session.endedAt;
  return result;
}

function repairHandle(handle: SessionRecoveryHandle): RepairRecoveryHandle {
  const result: RepairRecoveryHandle = {
    id: handle.id,
    provider: handle.provider,
    projectId: handle.projectId,
    worktreeId: handle.worktreeId,
    targetKind: handle.target.kind,
    observedAt: handle.observedAt,
    lastSeenAt: handle.lastSeenAt,
  };
  if (handle.sessionId !== undefined) result.sessionId = handle.sessionId;
  return result;
}

function compareId<T extends { id: string }>(left: T, right: T): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}
