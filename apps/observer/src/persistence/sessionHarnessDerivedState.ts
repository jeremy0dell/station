import type {
  PersistedCommand,
  PersistedSessionHarnessExecution,
  PersistedSessionTurnReadiness,
} from "./types.js";

export function sessionHarnessExecutionEqual(
  left: PersistedSessionHarnessExecution | undefined,
  right: PersistedSessionHarnessExecution | undefined,
): boolean {
  return (
    left?.provider === right?.provider &&
    left?.sessionId === right?.sessionId &&
    left?.nativeSessionId === right?.nativeSessionId &&
    left?.state === right?.state &&
    left?.statusUpdatedAt === right?.statusUpdatedAt
  );
}

export function turnReadinessWasAcknowledged(
  commands: readonly PersistedCommand[],
  readiness: PersistedSessionTurnReadiness,
): boolean {
  return commands.some(
    (command) =>
      command.status === "succeeded" &&
      command.command.type === "session.acknowledgeTurn" &&
      command.command.payload.sessionId === readiness.sessionId &&
      command.command.payload.token === readiness.token,
  );
}

export function sessionTurnReadinessEqual(
  left: PersistedSessionTurnReadiness | undefined,
  right: PersistedSessionTurnReadiness | undefined,
): boolean {
  return (
    left?.sessionId === right?.sessionId &&
    left?.projectId === right?.projectId &&
    left?.worktreeId === right?.worktreeId &&
    left?.token === right?.token &&
    left?.completedAt === right?.completedAt &&
    left?.createdAt === right?.createdAt &&
    left?.updatedAt === right?.updatedAt
  );
}
