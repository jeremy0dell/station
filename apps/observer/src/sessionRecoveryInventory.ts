import type {
  ObserverRecoveryInventory,
  ObserverRecoveryInventoryHandle,
  ObserverRecoveryInventorySession,
  SessionRecoveryHandle,
} from "@station/contracts";
import { compareCodeUnitStrings, ObserverRecoveryInventorySchema } from "@station/contracts";
import type { SessionStore } from "./persistence/ports.js";
import type {
  ObserverRecoveryInventoryPersistenceSnapshot,
  PersistedSession,
} from "./persistence/types.js";

/**
 * USE CASE
 *
 * Projects one coherent persistence snapshot into provider-neutral, redacted recovery evidence
 * without dispatching commands, reconciling providers, or writing durable state.
 */
export async function inspectObserverRecoveryInventory(input: {
  persistence: Pick<SessionStore, "readRecoveryInventory">;
}): Promise<ObserverRecoveryInventory> {
  const snapshot = await input.persistence.readRecoveryInventory();
  return observerRecoveryInventoryFromPersistence(snapshot);
}

/** Projects an already captured persistence snapshot without issuing another persistence read. */
export function observerRecoveryInventoryFromPersistence(
  snapshot: ObserverRecoveryInventoryPersistenceSnapshot,
): ObserverRecoveryInventory {
  const sessions = snapshot.sessions.map(recoveryInventorySession).sort(compareId);
  const recoveryHandles = snapshot.recoveryHandles.map(recoveryInventoryHandle).sort(compareId);
  return ObserverRecoveryInventorySchema.parse({
    schemaVersion: 1,
    sessions,
    recoveryHandles,
  });
}

function recoveryInventorySession(session: PersistedSession): ObserverRecoveryInventorySession {
  const result: ObserverRecoveryInventorySession = {
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

function recoveryInventoryHandle(handle: SessionRecoveryHandle): ObserverRecoveryInventoryHandle {
  const result: ObserverRecoveryInventoryHandle = {
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
  return compareCodeUnitStrings(left.id, right.id);
}
