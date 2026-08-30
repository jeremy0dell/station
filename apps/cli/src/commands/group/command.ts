import type {
  AcceptedCommandReceipt,
  SafeError,
  SessionGroupCreateCommandResult,
  SessionGroupId,
  SessionId,
  StationSnapshot,
} from "@station/contracts";
import {
  CreateSessionGroupCommandSchema,
  DeleteSessionGroupCommandSchema,
  RenameSessionGroupCommandSchema,
  ReparentSessionGroupCommandSchema,
  SessionGroupCreateCommandResultSchema,
  UpdateSessionGroupMembershipCommandSchema,
} from "@station/contracts";
import type { ObserverProcessDeps } from "../../observerProcess.js";
import { executeTypedObserverCommand, type TypedObserverCommandOptions } from "../command.js";
import { loadObserverSnapshot, type ObserverSnapshotLoadOptions } from "../snapshot.js";
import type { ParsedGroupArgs } from "./args.js";
import { parseGroupArgs } from "./args.js";
import { type GroupConvergenceExpectation, loadGroupConvergence } from "./convergence.js";
import type { GroupCommandOptions } from "./options.js";
import type {
  CompletedGroupOutcome,
  CreateGroupCommand,
  GroupCommandResult,
  GroupMutationCommand,
  GroupSuccessOutcome,
  MembershipGroupCommand,
  ReparentGroupCommand,
} from "./result.js";
import {
  assertParentProject,
  assertProject,
  assertSessionProject,
  findGroup,
  findSession,
  projectGroups,
  sessionMemberships,
} from "./summary.js";

type GroupMutationContext = {
  snapshot: StationSnapshot;
  options: GroupCommandOptions;
  timeoutMs: number;
  deps: ObserverProcessDeps;
};

/**
 * ADAPTER
 *
 * Projects canonical project-local Groups from one typed snapshot and translates exact CLI
 * mutations into recorded Observer commands with optimistic version and membership preconditions.
 */
export async function runGroupCommand(
  args: string[] | ParsedGroupArgs,
  options: GroupCommandOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<GroupCommandResult> {
  const parsed = Array.isArray(args) ? parseGroupArgs(args) : args;
  if (parsed.action === "list") {
    const snapshot = await loadObserverSnapshot(snapshotLoadOptions(options), deps);
    return {
      action: "list",
      filters: parsed.filters,
      groups: projectGroups(snapshot, parsed.filters.project),
    };
  }
  if (parsed.action === "get") {
    const snapshot = await loadObserverSnapshot(snapshotLoadOptions(options), deps);
    return { action: "get", group: findGroup(snapshot, parsed.groupId) };
  }

  const timeoutMs = parsed.timeoutMs ?? options.timeoutMs ?? 30_000;
  const snapshot = await loadObserverSnapshot(snapshotLoadOptions(options, timeoutMs), deps);
  const context = { snapshot, options, timeoutMs, deps };
  switch (parsed.action) {
    case "create":
      return runCreateGroup(parsed, context);
    case "rename":
      return runRenameGroup(parsed, context);
    case "members.add":
    case "members.remove":
      return runMembershipGroup(parsed, context);
    case "reparent":
      return runReparentGroup(parsed, context);
    case "delete":
      return runDeleteGroup(parsed, context);
  }
}

async function runCreateGroup(
  parsed: Extract<ParsedGroupArgs, { action: "create" }>,
  context: GroupMutationContext,
): Promise<Extract<GroupCommandResult, { action: "create" }>> {
  const { snapshot } = context;
  assertProject(snapshot, parsed.projectId);
  const memberships = sessionMemberships(snapshot);
  assertDistinctSessions(parsed.sessionIds);
  for (const sessionId of parsed.sessionIds) {
    const session = findSession(snapshot, sessionId);
    assertSessionProject(session.projectId, parsed.projectId, sessionId);
    if (memberships.has(sessionId)) throw sessionAlreadyGroupedError(sessionId);
  }

  const payload: CreateGroupCommand["payload"] = {
    projectId: parsed.projectId,
    name: parsed.name,
  };
  if (parsed.sessionIds.length > 0) payload.initialSessionIds = [...parsed.sessionIds];
  const command = CreateSessionGroupCommandSchema.parse({ type: "sessionGroup.create", payload });
  const outcome = await executeGroupCommand(command, context);
  if (outcome.status !== "succeeded") return { action: "create", outcome };

  const created = parseCreatedResult(outcome, command);
  return {
    action: "create",
    outcome,
    created,
    convergence: await loadConvergence(
      {
        action: "create",
        projectId: parsed.projectId,
        groupId: created.groupId,
        name: parsed.name,
        sessionIds: parsed.sessionIds,
        version: created.version,
      },
      context,
    ),
  };
}

async function runRenameGroup(
  parsed: Extract<ParsedGroupArgs, { action: "rename" }>,
  context: GroupMutationContext,
): Promise<Extract<GroupCommandResult, { action: "rename" }>> {
  const target = findGroup(context.snapshot, parsed.groupId);
  const command = RenameSessionGroupCommandSchema.parse({
    type: "sessionGroup.rename",
    payload: {
      projectId: target.projectId,
      groupId: target.id,
      expectedVersion: target.version,
      name: parsed.name,
    },
  });
  const outcome = await executeGroupCommand(command, context);
  if (outcome.status !== "succeeded") return { action: "rename", target, outcome };
  return {
    action: "rename",
    target,
    outcome,
    convergence: await loadConvergence(
      {
        action: "rename",
        projectId: target.projectId,
        groupId: target.id,
        name: parsed.name,
        minimumVersion: target.version,
      },
      context,
    ),
  };
}

async function runMembershipGroup(
  parsed: Extract<ParsedGroupArgs, { action: "members.add" | "members.remove" }>,
  context: GroupMutationContext,
): Promise<Extract<GroupCommandResult, { action: "members.add" | "members.remove" }>> {
  const { snapshot } = context;
  const target = findGroup(snapshot, parsed.groupId);
  const memberships = sessionMemberships(snapshot);
  assertDistinctSessions(parsed.sessionIds);
  for (const sessionId of parsed.sessionIds) {
    const session = findSession(snapshot, sessionId);
    assertSessionProject(session.projectId, target.projectId, sessionId);
    if (parsed.action === "members.remove" && memberships.get(sessionId) !== target.id) {
      throw sessionNotDirectMemberError(sessionId, target.id);
    }
  }

  const payload: MembershipGroupCommand["payload"] = {
    projectId: target.projectId,
    groupId: target.id,
    expectedVersion: target.version,
  };
  if (parsed.action === "members.add") {
    payload.add = parsed.sessionIds.map((sessionId) => ({
      sessionId,
      expectedGroupId: memberships.get(sessionId) ?? null,
    }));
  } else {
    payload.remove = parsed.sessionIds.map((sessionId) => ({
      sessionId,
      expectedGroupId: target.id,
    }));
  }
  const command = UpdateSessionGroupMembershipCommandSchema.parse({
    type: "sessionGroup.updateMembership",
    payload,
  });
  const outcome = await executeGroupCommand(command, context);
  if (outcome.status !== "succeeded") {
    return parsed.action === "members.add"
      ? { action: "members.add", target, outcome }
      : { action: "members.remove", target, outcome };
  }
  const convergence = await loadConvergence(
    {
      action: parsed.action,
      projectId: target.projectId,
      groupId: target.id,
      sessionIds: parsed.sessionIds,
      minimumVersion: target.version,
    },
    context,
  );
  return parsed.action === "members.add"
    ? { action: "members.add", target, outcome, convergence }
    : { action: "members.remove", target, outcome, convergence };
}

async function runReparentGroup(
  parsed: Extract<ParsedGroupArgs, { action: "reparent" }>,
  context: GroupMutationContext,
): Promise<Extract<GroupCommandResult, { action: "reparent" }>> {
  const target = findGroup(context.snapshot, parsed.groupId);
  if (parsed.parentGroupId !== undefined) {
    const parent = findGroup(context.snapshot, parsed.parentGroupId);
    assertParentProject(parent.projectId, target.projectId, parent.id);
  }
  const payload: ReparentGroupCommand["payload"] = {
    projectId: target.projectId,
    groupId: target.id,
    expectedVersion: target.version,
  };
  if (parsed.parentGroupId !== undefined) payload.parentGroupId = parsed.parentGroupId;
  const command = ReparentSessionGroupCommandSchema.parse({
    type: "sessionGroup.reparent",
    payload,
  });
  const outcome = await executeGroupCommand(command, context);
  if (outcome.status !== "succeeded") return { action: "reparent", target, outcome };
  return {
    action: "reparent",
    target,
    outcome,
    convergence: await loadConvergence(
      {
        action: "reparent",
        projectId: target.projectId,
        groupId: target.id,
        ...(parsed.parentGroupId === undefined ? {} : { parentGroupId: parsed.parentGroupId }),
        minimumVersion: target.version,
      },
      context,
    ),
  };
}

async function runDeleteGroup(
  parsed: Extract<ParsedGroupArgs, { action: "delete" }>,
  context: GroupMutationContext,
): Promise<Extract<GroupCommandResult, { action: "delete" }>> {
  const { snapshot } = context;
  const target = findGroup(snapshot, parsed.groupId);
  const command = DeleteSessionGroupCommandSchema.parse({
    type: "sessionGroup.delete",
    payload: {
      projectId: target.projectId,
      groupId: target.id,
      expectedVersion: target.version,
    },
  });
  const outcome = await executeGroupCommand(command, context);
  if (outcome.status !== "succeeded") return { action: "delete", target, outcome };
  return {
    action: "delete",
    target,
    outcome,
    convergence: await loadConvergence(
      {
        action: "delete",
        projectId: target.projectId,
        groupId: target.id,
        directSessionIds: target.sessionIds,
        childGroupIds: snapshot.sessionGroups
          .filter((group) => group.parentGroupId === target.id)
          .map((group) => group.id),
        ...(target.parentGroupId === undefined ? {} : { parentGroupId: target.parentGroupId }),
      },
      context,
    ),
  };
}

async function executeGroupCommand<TCommand extends GroupMutationCommand>(
  command: TCommand,
  context: GroupMutationContext,
): Promise<CompletedGroupOutcome<TCommand>> {
  const outcome = await executeTypedObserverCommand(
    command,
    mutationExecutionOptions(context.options, context.timeoutMs),
    context.deps,
  );
  if (outcome.status === "accepted") throw missingCompletionError(outcome.receipt);
  return outcome;
}

function loadConvergence(expectation: GroupConvergenceExpectation, context: GroupMutationContext) {
  return loadGroupConvergence(
    expectation,
    snapshotLoadOptions(context.options, context.timeoutMs),
    context.deps,
  );
}

function snapshotLoadOptions(
  options: GroupCommandOptions,
  timeoutMs = options.timeoutMs,
): ObserverSnapshotLoadOptions {
  const loadOptions: ObserverSnapshotLoadOptions = {};
  if (options.config !== undefined) loadOptions.config = options.config;
  if (options.configPath !== undefined) loadOptions.configPath = options.configPath;
  if (timeoutMs !== undefined) loadOptions.timeoutMs = timeoutMs;
  return loadOptions;
}

function mutationExecutionOptions(
  options: GroupCommandOptions,
  timeoutMs: number,
): TypedObserverCommandOptions {
  const executionOptions: TypedObserverCommandOptions = { timeoutMs, waitForCompletion: true };
  if (options.config !== undefined) executionOptions.config = options.config;
  if (options.configPath !== undefined) executionOptions.configPath = options.configPath;
  return executionOptions;
}

function parseCreatedResult(
  outcome: GroupSuccessOutcome<CreateGroupCommand>,
  command: CreateGroupCommand,
): SessionGroupCreateCommandResult {
  const parsed = SessionGroupCreateCommandResultSchema.safeParse(outcome.record.result);
  if (parsed.success && parsed.data.projectId === command.payload.projectId) return parsed.data;

  const error: SafeError = {
    tag: "GroupCliError",
    code: "GROUP_CREATE_RESULT_INVALID",
    message: "The succeeded Group create command did not return its exact durable Group result.",
    hint: "Inspect the command record before retrying; the Group id must come from its typed result.",
    commandId: outcome.receipt.commandId,
  };
  if (outcome.receipt.traceId !== undefined) error.traceId = outcome.receipt.traceId;
  if (parsed.success) error.projectId = command.payload.projectId;
  throw error;
}

function missingCompletionError(receipt: AcceptedCommandReceipt): SafeError {
  const error: SafeError = {
    tag: "GroupCliError",
    code: "GROUP_COMMAND_COMPLETION_MISSING",
    message: "The Group command returned before its durable completion was available.",
    commandId: receipt.commandId,
  };
  if (receipt.traceId !== undefined) error.traceId = receipt.traceId;
  return error;
}

function assertDistinctSessions(sessionIds: readonly SessionId[]): void {
  const seen = new Set<SessionId>();
  for (const sessionId of sessionIds) {
    if (seen.has(sessionId)) throw duplicateSessionError(sessionId);
    seen.add(sessionId);
  }
}

function sessionAlreadyGroupedError(sessionId: SessionId): SafeError {
  return {
    tag: "GroupCliError",
    code: "GROUP_SESSION_ALREADY_GROUPED",
    message: `Session ${sessionId} is already directly assigned to a Session Group.`,
    hint: "Create the Group without this session or move it with `stn group members add`.",
    sessionId,
  };
}

function sessionNotDirectMemberError(sessionId: SessionId, groupId: SessionGroupId): SafeError {
  return {
    tag: "GroupCliError",
    code: "GROUP_SESSION_NOT_MEMBER",
    message: `Session ${sessionId} is not directly assigned to Group ${groupId}.`,
    hint: "Refresh Group membership before removing a session.",
    sessionId,
  };
}

function duplicateSessionError(sessionId: SessionId): SafeError {
  return {
    tag: "GroupCliError",
    code: "GROUP_SESSION_DUPLICATE",
    message: `Session ${sessionId} was supplied more than once.`,
    hint: "Supply each session id once per Group operation.",
    sessionId,
  };
}
