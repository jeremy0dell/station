import { randomUUID } from "node:crypto";
import type {
  SafeError,
  SessionGroupCreateCommandResult,
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
import {
  sessionGroupIdCollisionError,
  sessionGroupMembershipAssignmentConflictError,
  sessionGroupMissingError,
  sessionGroupProjectMismatchError,
} from "./errors.js";
import type {
  CommandHandler,
  CommandHandlerContext,
  CommandResultHandler,
  ObserverCommandHandlers,
} from "./queue.js";

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
 * Validates, durably mutates, projects, and publishes project-local Session Group
 * intent, returning the exact identity and version created by create commands.
 */
export function createSessionGroupCommandHandlers(
  options: CreateSessionGroupCommandHandlersOptions,
): Pick<ObserverCommandHandlers, SessionGroupCommand["type"]> {
  const sessionGroupId = options.idFactory?.sessionGroupId ?? (() => `grp_${randomUUID()}`);
  const handle = async (
    context: CommandHandlerContext,
  ): Promise<SessionGroupCreateCommandResult | undefined> => {
    const command = sessionGroupCommand(context);
    const projectId = command.payload.projectId;
    const createdGroupId = command.type === "sessionGroup.create" ? sessionGroupId() : undefined;
    let createdResult: SessionGroupCreateCommandResult | undefined;
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
      validateReparentCommand(command, target, beforeById);

      const at = nowIso(options.clock);
      context.beginCommit();
      const result = await mutateSessionGroups({
        command,
        persistence: options.persistence,
        at,
        ...(createdGroupId === undefined ? {} : { createdGroupId }),
      });
      if (!result.ok) {
        throw sessionGroupConflict(result.reason, command);
      }
      if (command.type === "sessionGroup.create" && createdGroupId !== undefined) {
        const created = result.groups.find((group) => group.id === createdGroupId);
        if (created === undefined) {
          throw createdSessionGroupMissingError(projectId);
        }
        createdResult = {
          type: "sessionGroup.create",
          projectId,
          groupId: created.id,
          version: created.version,
        };
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
    return createdResult;
  };

  const handleCreate: CommandResultHandler<"sessionGroup.create"> = async (context) => {
    const result = await handle(context);
    if (result === undefined) {
      throw createdSessionGroupMissingError(sessionGroupCommand(context).payload.projectId);
    }
    return result;
  };
  const handleWithoutResult: CommandHandler = async (context) => {
    await handle(context);
  };

  return {
    "sessionGroup.create": handleCreate,
    "sessionGroup.rename": handleWithoutResult,
    "sessionGroup.updateMembership": handleWithoutResult,
    "sessionGroup.reparent": handleWithoutResult,
    "sessionGroup.delete": handleWithoutResult,
  };
}

function sessionGroupCommand(context: CommandHandlerContext): SessionGroupCommand {
  switch (context.command.type) {
    case "sessionGroup.create":
    case "sessionGroup.rename":
    case "sessionGroup.updateMembership":
    case "sessionGroup.reparent":
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
  createdGroupId?: SessionGroupId;
}) {
  const { command, persistence, at } = input;
  switch (command.type) {
    case "sessionGroup.create": {
      if (input.createdGroupId === undefined) {
        throw createdSessionGroupMissingError(command.payload.projectId);
      }
      const createInput: Parameters<SessionGroupStore["createSessionGroup"]>[0] = {
        id: input.createdGroupId,
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
    case "sessionGroup.reparent": {
      const reparentInput: Parameters<SessionGroupStore["reparentSessionGroup"]>[0] = {
        id: command.payload.groupId,
        expectedVersion: command.payload.expectedVersion,
        updatedAt: at,
      };
      if (command.payload.parentGroupId !== undefined) {
        reparentInput.parentGroupId = command.payload.parentGroupId;
      }
      return persistence.reparentSessionGroup(reparentInput);
    }
    case "sessionGroup.delete":
      return persistence.deleteSessionGroup({
        id: command.payload.groupId,
        expectedVersion: command.payload.expectedVersion,
        updatedAt: at,
      });
  }
}

function createdSessionGroupMissingError(projectId: string): SafeError {
  return {
    tag: "CommandExecutionError",
    code: "SESSION_GROUP_CREATE_RESULT_MISSING",
    message: "The Session Group store did not return the created Group.",
    projectId,
  };
}

function validateReparentCommand(
  command: SessionGroupCommand,
  target: SessionGroupView | undefined,
  groups: ReadonlyMap<string, SessionGroupView>,
): void {
  if (command.type !== "sessionGroup.reparent" || command.payload.parentGroupId === undefined) {
    return;
  }
  if (target === undefined) {
    throw sessionGroupMissingError(command.payload.groupId, command.payload.projectId);
  }
  if (command.payload.parentGroupId === target.id) {
    throw groupParentSelfError(target.projectId);
  }

  let ancestor = requireProjectGroup(
    groups,
    command.payload.parentGroupId,
    command.payload.projectId,
  );
  const visited = new Set<SessionGroupId>();
  while (true) {
    // Reaching the target rejects the proposed edge; revisiting anything else exposes prior corruption.
    if (ancestor.id === target.id) throw groupParentCycleError(target.projectId);
    if (visited.has(ancestor.id)) throw groupParentGraphInvalidError(target.projectId);
    visited.add(ancestor.id);
    if (ancestor.parentGroupId === undefined) return;
    const parent = groups.get(ancestor.parentGroupId);
    if (parent === undefined || parent.projectId !== target.projectId) {
      throw groupParentGraphInvalidError(target.projectId);
    }
    ancestor = parent;
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
    throw sessionGroupMissingError(groupId, projectId);
  }
  if (group.projectId !== projectId) {
    throw sessionGroupProjectMismatchError(groupId, projectId);
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
      return sessionGroupIdCollisionError(projectId);
    case "not_found":
      return sessionGroupMissingError(
        command.type === "sessionGroup.create"
          ? "generated"
          : command.type === "sessionGroup.reparent"
            ? (command.payload.parentGroupId ?? command.payload.groupId)
            : command.payload.groupId,
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
      return sessionGroupMembershipAssignmentConflictError(projectId);
  }
}

function groupParentSelfError(projectId: string): SafeError {
  return {
    tag: "CommandValidationError",
    code: "SESSION_GROUP_PARENT_SELF",
    message: "A Session Group cannot be its own parent.",
    hint: "Choose another Group in the same project or move this Group to the project root.",
    projectId,
  };
}

function groupParentCycleError(projectId: string): SafeError {
  return {
    tag: "CommandValidationError",
    code: "SESSION_GROUP_PARENT_CYCLE",
    message: "The requested parent would create a Session Group cycle.",
    hint: "Choose a Group outside the target Group's descendants.",
    projectId,
  };
}

function groupParentGraphInvalidError(projectId: string): SafeError {
  return {
    tag: "CommandValidationError",
    code: "SESSION_GROUP_PARENT_GRAPH_INVALID",
    message: "The requested parent belongs to an invalid persisted Group ancestry.",
    hint: "Reconcile the Observer to repair Group parentage, then refresh and retry.",
    projectId,
  };
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
