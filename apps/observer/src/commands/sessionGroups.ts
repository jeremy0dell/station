import { randomUUID } from "node:crypto";
import type {
  SafeError,
  SessionGroupId,
  SessionGroupView,
  StationCommand,
  StationEvent,
} from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type { EventJournal, EventRecordOptions, SessionGroupStore } from "../persistence/index.js";
import type { ObserverCore } from "../reconcile/core.js";
import type { ObserverEventBus } from "../runtime/eventBus.js";
import { nowIso } from "../utils/time.js";
import { throwIfAborted } from "./cancellation.js";
import type { CommandHandler, CommandHandlerContext } from "./queue.js";

type SessionGroupCommand = Extract<StationCommand, { type: `sessionGroup.${string}` }>;

export type SessionGroupCommandIdFactory = {
  sessionGroupId(): SessionGroupId;
};

export type CreateSessionGroupCommandHandlersOptions = {
  core: ObserverCore;
  persistence: SessionGroupStore & EventJournal;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  idFactory?: Partial<SessionGroupCommandIdFactory> | undefined;
};

/**
 * USE CASE
 *
 * Validates, durably mutates, projects, and publishes project-local Session Group intent.
 */
export function createSessionGroupCommandHandlers(
  options: CreateSessionGroupCommandHandlersOptions,
): Record<SessionGroupCommand["type"], CommandHandler> {
  const sessionGroupId = options.idFactory?.sessionGroupId ?? (() => `grp_${randomUUID()}`);
  const handle: CommandHandler = async (context) => {
    const command = sessionGroupCommand(context);
    const projectId = command.payload.projectId;
    const events: Array<
      Extract<StationEvent, { type: "sessionGroup.updated" | "sessionGroup.removed" }>
    > = [];

    await options.core.commitSessionGroupMutation(projectId, async (snapshot) => {
      throwIfAborted(context.signal);
      if (!options.core.getProjects().some((project) => project.id === projectId)) {
        throw projectMissingError(projectId);
      }

      const before = await options.persistence.listSessionGroups();
      const beforeById = new Map(before.map((group) => [group.id, group]));
      const target =
        command.type === "sessionGroup.create"
          ? undefined
          : requireProjectGroup(beforeById, command.payload.groupId, projectId);
      validateCommandSessions(command, snapshot, beforeById);

      const at = nowIso(options.clock);
      context.beginCommit();
      const result = await mutateSessionGroups({
        command,
        persistence: options.persistence,
        at,
        sessionGroupId,
      });
      if (!result.ok) {
        throw sessionGroupConflict(result.reason, command);
      }

      for (const group of result.groups) {
        if (beforeById.get(group.id)?.version === group.version) continue;
        events.push({
          type: "sessionGroup.updated",
          at,
          commandId: context.commandId,
          group,
          traceId: context.trace.traceId,
          spanId: context.trace.spanId,
        });
      }
      if (command.type === "sessionGroup.delete" && target !== undefined) {
        events.push({
          type: "sessionGroup.removed",
          at,
          commandId: context.commandId,
          projectId: target.projectId,
          groupId: target.id,
          traceId: context.trace.traceId,
          spanId: context.trace.spanId,
        });
      }
      for (const event of events) {
        await persistEvent(options, event);
      }

      return (await options.persistence.listSessionGroups()).filter(
        (group) => group.projectId === projectId,
      );
    });

    for (const event of events) {
      options.eventBus?.publish(event);
    }
  };

  return {
    "sessionGroup.create": handle,
    "sessionGroup.rename": handle,
    "sessionGroup.updateMembership": handle,
    "sessionGroup.delete": handle,
  };
}

function sessionGroupCommand(context: CommandHandlerContext): SessionGroupCommand {
  switch (context.command.type) {
    case "sessionGroup.create":
    case "sessionGroup.rename":
    case "sessionGroup.updateMembership":
    case "sessionGroup.delete":
      return context.command;
    default:
      throw new Error(`Expected a Session Group command, received ${context.command.type}.`);
  }
}

async function mutateSessionGroups(input: {
  command: SessionGroupCommand;
  persistence: SessionGroupStore;
  at: string;
  sessionGroupId: () => SessionGroupId;
}) {
  const { command, persistence, at } = input;
  switch (command.type) {
    case "sessionGroup.create": {
      const createInput: Parameters<SessionGroupStore["createSessionGroup"]>[0] = {
        id: input.sessionGroupId(),
        projectId: command.payload.projectId,
        name: command.payload.name,
        createdAt: at,
      };
      if (command.payload.initialSessionIds !== undefined) {
        createInput.initialMembers = command.payload.initialSessionIds.map((sessionId) => ({
          sessionId,
          projectId: command.payload.projectId,
          expectedGroupId: null,
        }));
      }
      return persistence.createSessionGroup(createInput);
    }
    case "sessionGroup.rename":
      return persistence.renameSessionGroup({
        id: command.payload.groupId,
        expectedVersion: command.payload.expectedVersion,
        name: command.payload.name,
        updatedAt: at,
      });
    case "sessionGroup.updateMembership": {
      const membershipInput: Parameters<SessionGroupStore["updateSessionGroupMembership"]>[0] = {
        id: command.payload.groupId,
        expectedVersion: command.payload.expectedVersion,
        updatedAt: at,
      };
      if (command.payload.add !== undefined) {
        membershipInput.add = command.payload.add.map((expectation) => ({
          ...expectation,
          projectId: command.payload.projectId,
        }));
      }
      if (command.payload.remove !== undefined) {
        membershipInput.remove = command.payload.remove.map((expectation) => ({
          ...expectation,
          projectId: command.payload.projectId,
        }));
      }
      return persistence.updateSessionGroupMembership(membershipInput);
    }
    case "sessionGroup.delete":
      return persistence.deleteSessionGroup({
        id: command.payload.groupId,
        expectedVersion: command.payload.expectedVersion,
        updatedAt: at,
      });
  }
}

function validateCommandSessions(
  command: SessionGroupCommand,
  snapshot: ReturnType<ObserverCore["getSnapshot"]>,
  groups: ReadonlyMap<string, SessionGroupView>,
): void {
  const sessionIds =
    command.type === "sessionGroup.create"
      ? (command.payload.initialSessionIds ?? [])
      : command.type === "sessionGroup.updateMembership"
        ? [...(command.payload.add ?? []), ...(command.payload.remove ?? [])].map(
            (expectation) => expectation.sessionId,
          )
        : [];
  const sessions = new Map(snapshot.sessions.map((session) => [session.id, session]));
  for (const sessionId of sessionIds) {
    const session = sessions.get(sessionId);
    if (session === undefined) {
      throw sessionMissingError(sessionId, command.payload.projectId);
    }
    if (session.projectId !== command.payload.projectId) {
      throw sessionProjectMismatchError(sessionId, command.payload.projectId);
    }
  }

  if (command.type !== "sessionGroup.updateMembership") return;
  for (const expectation of command.payload.add ?? []) {
    if (expectation.expectedGroupId === null) continue;
    requireProjectGroup(groups, expectation.expectedGroupId, command.payload.projectId);
  }
}

function requireProjectGroup(
  groups: ReadonlyMap<string, SessionGroupView>,
  groupId: SessionGroupId,
  projectId: string,
): SessionGroupView {
  const group = groups.get(groupId);
  if (group === undefined) {
    throw groupMissingError(groupId, projectId);
  }
  if (group.projectId !== projectId) {
    throw groupProjectMismatchError(groupId, projectId);
  }
  return group;
}

async function persistEvent(
  options: CreateSessionGroupCommandHandlersOptions,
  event: Extract<StationEvent, { type: "sessionGroup.updated" | "sessionGroup.removed" }>,
): Promise<void> {
  const recordOptions: EventRecordOptions = {
    commandId: event.commandId,
    createdAt: event.at,
  };
  if (event.traceId !== undefined) recordOptions.traceId = event.traceId;
  if (event.spanId !== undefined) recordOptions.spanId = event.spanId;
  await options.persistence.recordEvent(event, recordOptions);
}

function sessionGroupConflict(
  reason: "already_exists" | "not_found" | "stale_version" | "unexpected_assignment",
  command: SessionGroupCommand,
): SafeError {
  const projectId = command.payload.projectId;
  switch (reason) {
    case "already_exists":
      return {
        tag: "CommandConflictError",
        code: "SESSION_GROUP_ID_COLLISION",
        message: "The Observer generated a Session Group id that already exists.",
        hint: "Retry the command to generate a new Group id.",
        projectId,
      };
    case "not_found":
      return groupMissingError(
        command.type === "sessionGroup.create" ? "generated" : command.payload.groupId,
        projectId,
      );
    case "stale_version":
      return {
        tag: "CommandConflictError",
        code: "SESSION_GROUP_VERSION_CONFLICT",
        message: "The Session Group changed after this command was prepared.",
        hint: "Refresh the canonical Group state and retry with its current version.",
        projectId,
      };
    case "unexpected_assignment":
      return {
        tag: "CommandConflictError",
        code: "SESSION_GROUP_ASSIGNMENT_CONFLICT",
        message: "A session's current Group assignment did not match the command expectation.",
        hint: "Refresh the canonical Group state before retrying the membership change.",
        projectId,
      };
  }
}

function projectMissingError(projectId: string): SafeError {
  return {
    tag: "CommandValidationError",
    code: "PROJECT_NOT_FOUND",
    message: "No configured project matches the requested project id.",
    hint: "Refresh Station and retry with a configured project.",
    projectId,
  };
}

function groupMissingError(groupId: string, projectId: string): SafeError {
  return {
    tag: "CommandValidationError",
    code: "SESSION_GROUP_NOT_FOUND",
    message: `No durable Session Group matches ${groupId}.`,
    hint: "Refresh the canonical Group state and retry with a current Group id.",
    projectId,
  };
}

function groupProjectMismatchError(groupId: string, projectId: string): SafeError {
  return {
    tag: "CommandValidationError",
    code: "SESSION_GROUP_PROJECT_MISMATCH",
    message: `Session Group ${groupId} does not belong to the requested project.`,
    hint: "Use only Groups from the session's configured project.",
    projectId,
  };
}

function sessionMissingError(sessionId: string, projectId: string): SafeError {
  return {
    tag: "CommandValidationError",
    code: "SESSION_NOT_FOUND",
    message: "No current canonical session matches the requested session id.",
    hint: "Refresh Station and retry with a current session.",
    sessionId,
    projectId,
  };
}

function sessionProjectMismatchError(sessionId: string, projectId: string): SafeError {
  return {
    tag: "CommandValidationError",
    code: "SESSION_GROUP_SESSION_PROJECT_MISMATCH",
    message: "The referenced session does not belong to the requested Group project.",
    hint: "Group only sessions from the same configured project.",
    sessionId,
    projectId,
  };
}
