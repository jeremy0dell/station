import type {
  ObserverRepairInventory,
  RepairRecoveryHandle,
  RepairRetainedSession,
  SessionRecoveryHandle,
} from "@station/contracts";
import { ObserverRepairInventorySchema } from "@station/contracts";
import type { SessionStore } from "../persistence/ports.js";
import type { PersistedSession } from "../persistence/types.js";
import type { ProviderRegistry } from "../providers/registry.js";

/**
 * USE CASE
 *
 * Reads one transactionally coherent session/recovery snapshot and projects only
 * provider-neutral, redacted repair evidence. It never reconciles or writes durable state.
 */
export async function inspectObserverRepairInventory(input: {
  persistence: Pick<SessionStore, "readRepairInventory">;
  providers?: ProviderRegistry;
}): Promise<ObserverRepairInventory> {
  const snapshot = await input.persistence.readRepairInventory();
  const sessions = snapshot.sessions.map(repairSession).sort(compareId);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const recoveryHandles = snapshot.recoveryHandles
    .map((handle) => repairHandle(handle, sessionsById, input.providers))
    .sort(compareId);
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

function repairHandle(
  handle: SessionRecoveryHandle,
  sessions: ReadonlyMap<string, RepairRetainedSession>,
  providers: ProviderRegistry | undefined,
): RepairRecoveryHandle {
  const disposition = handleDisposition(handle, sessions, providers);
  const result: RepairRecoveryHandle = {
    id: handle.id,
    provider: handle.provider,
    projectId: handle.projectId,
    worktreeId: handle.worktreeId,
    targetKind: handle.target.kind,
    observedAt: handle.observedAt,
    lastSeenAt: handle.lastSeenAt,
    disposition,
    eligible: disposition === "viable",
  };
  if (handle.sessionId !== undefined) result.sessionId = handle.sessionId;
  if (disposition !== "viable") result.reasonCode = disposition;
  return result;
}

function handleDisposition(
  handle: SessionRecoveryHandle,
  sessions: ReadonlyMap<string, RepairRetainedSession>,
  providers: ProviderRegistry | undefined,
): RepairRecoveryHandle["disposition"] {
  if (handle.sessionId === undefined) return "missing-session";
  const session = sessions.get(handle.sessionId);
  if (session === undefined) return "missing-session";
  if (session.projectId !== handle.projectId || session.worktreeId !== handle.worktreeId) {
    return "worktree-mismatch";
  }
  if (session.lifecycle === "ended") return "ended-session";
  if (session.harnessProvider !== undefined && session.harnessProvider !== handle.provider) {
    return "provider-mismatch";
  }
  if (providers?.harnesses.get(handle.provider)?.capabilities().canResume !== true) {
    return "unsupported-provider";
  }
  return "viable";
}

function compareId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}
