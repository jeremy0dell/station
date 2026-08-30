import type { StationConfig } from "@station/config";
import type {
  CommandExecutionOutcome,
  ProjectId,
  SafeError,
  SessionGroupCreateCommandResult,
  SessionGroupId,
  SessionGroupView,
  SessionId,
  StationCommand,
  StationSnapshot,
} from "@station/contracts";
import {
  CreateSessionGroupCommandSchema,
  DeleteSessionGroupCommandSchema,
  ProjectIdSchema,
  RenameSessionGroupCommandSchema,
  ReparentSessionGroupCommandSchema,
  SessionGroupCreateCommandResultSchema,
  SessionGroupIdSchema,
  SessionGroupNameSchema,
  SessionIdSchema,
  UpdateSessionGroupMembershipCommandSchema,
} from "@station/contracts";
import { publicSafeErrorFromUnknown } from "@station/runtime";
import { CliInputError, parsePositiveIntegerOption, parseRequiredOptionValue } from "../args.js";
import type { ObserverProcessDeps } from "../observerProcess.js";
import { escapeTerminalBytes } from "../terminalOutput.js";
import { executeTypedObserverCommand, type TypedObserverCommandOptions } from "./command.js";
import { loadObserverSnapshot, type ObserverSnapshotLoadOptions } from "./snapshot.js";

export type GroupCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
};

export type GroupFilters = {
  project?: ProjectId;
};

type GroupMutationCommand = Extract<
  StationCommand,
  {
    type:
      | "sessionGroup.create"
      | "sessionGroup.rename"
      | "sessionGroup.updateMembership"
      | "sessionGroup.reparent"
      | "sessionGroup.delete";
  }
>;
type CreateGroupCommand = Extract<StationCommand, { type: "sessionGroup.create" }>;
type RenameGroupCommand = Extract<StationCommand, { type: "sessionGroup.rename" }>;
type MembershipGroupCommand = Extract<StationCommand, { type: "sessionGroup.updateMembership" }>;
type ReparentGroupCommand = Extract<StationCommand, { type: "sessionGroup.reparent" }>;
type DeleteGroupCommand = Extract<StationCommand, { type: "sessionGroup.delete" }>;

type CompletedGroupOutcome<TCommand extends GroupMutationCommand> = Exclude<
  CommandExecutionOutcome<TCommand>,
  { status: "accepted" }
>;
type GroupFailureOutcome<TCommand extends GroupMutationCommand> = Exclude<
  CompletedGroupOutcome<TCommand>,
  { status: "succeeded" }
>;
type GroupSuccessOutcome<TCommand extends GroupMutationCommand> = Extract<
  CompletedGroupOutcome<TCommand>,
  { status: "succeeded" }
>;

type GroupMutationConvergence = {
  status: "confirmed" | "warning";
  projectId: ProjectId;
  groups?: SessionGroupView[];
  warning?: SafeError;
};

export type GroupCommandResult =
  | {
      action: "list";
      filters: GroupFilters;
      groups: SessionGroupView[];
    }
  | {
      action: "get";
      group: SessionGroupView;
    }
  | {
      action: "create";
      outcome: GroupFailureOutcome<CreateGroupCommand>;
    }
  | {
      action: "create";
      outcome: GroupSuccessOutcome<CreateGroupCommand>;
      created: SessionGroupCreateCommandResult;
      convergence: GroupMutationConvergence;
    }
  | {
      action: "rename";
      target: SessionGroupView;
      outcome: GroupFailureOutcome<RenameGroupCommand>;
    }
  | {
      action: "rename";
      target: SessionGroupView;
      outcome: GroupSuccessOutcome<RenameGroupCommand>;
      convergence: GroupMutationConvergence;
    }
  | {
      action: "members.add";
      target: SessionGroupView;
      outcome: GroupFailureOutcome<MembershipGroupCommand>;
    }
  | {
      action: "members.add";
      target: SessionGroupView;
      outcome: GroupSuccessOutcome<MembershipGroupCommand>;
      convergence: GroupMutationConvergence;
    }
  | {
      action: "members.remove";
      target: SessionGroupView;
      outcome: GroupFailureOutcome<MembershipGroupCommand>;
    }
  | {
      action: "members.remove";
      target: SessionGroupView;
      outcome: GroupSuccessOutcome<MembershipGroupCommand>;
      convergence: GroupMutationConvergence;
    }
  | {
      action: "reparent";
      target: SessionGroupView;
      outcome: GroupFailureOutcome<ReparentGroupCommand>;
    }
  | {
      action: "reparent";
      target: SessionGroupView;
      outcome: GroupSuccessOutcome<ReparentGroupCommand>;
      convergence: GroupMutationConvergence;
    }
  | {
      action: "delete";
      target: SessionGroupView;
      outcome: GroupFailureOutcome<DeleteGroupCommand>;
    }
  | {
      action: "delete";
      target: SessionGroupView;
      outcome: GroupSuccessOutcome<DeleteGroupCommand>;
      convergence: GroupMutationConvergence;
    };

type GroupOutputFormat = "json" | "text";

type ParsedGroupArgs =
  | { action: "list"; filters: GroupFilters; outputFormat: GroupOutputFormat }
  | { action: "get"; groupId: SessionGroupId; outputFormat: GroupOutputFormat }
  | {
      action: "create";
      projectId: ProjectId;
      name: string;
      sessionIds: SessionId[];
      outputFormat: GroupOutputFormat;
      timeoutMs?: number;
    }
  | {
      action: "rename";
      groupId: SessionGroupId;
      name: string;
      outputFormat: GroupOutputFormat;
      timeoutMs?: number;
    }
  | {
      action: "members.add" | "members.remove";
      groupId: SessionGroupId;
      sessionIds: SessionId[];
      outputFormat: GroupOutputFormat;
      timeoutMs?: number;
    }
  | {
      action: "reparent";
      groupId: SessionGroupId;
      parentGroupId?: SessionGroupId;
      outputFormat: GroupOutputFormat;
      timeoutMs?: number;
    }
  | {
      action: "delete";
      groupId: SessionGroupId;
      outputFormat: GroupOutputFormat;
      timeoutMs?: number;
    };

type GroupConvergenceExpectation =
  | {
      action: "create";
      projectId: ProjectId;
      groupId: SessionGroupId;
      name: string;
      sessionIds: readonly SessionId[];
      version: number;
    }
  | {
      action: "rename";
      projectId: ProjectId;
      groupId: SessionGroupId;
      name: string;
      minimumVersion: number;
    }
  | {
      action: "members.add" | "members.remove";
      projectId: ProjectId;
      groupId: SessionGroupId;
      sessionIds: readonly SessionId[];
      minimumVersion: number;
    }
  | {
      action: "reparent";
      projectId: ProjectId;
      groupId: SessionGroupId;
      parentGroupId?: SessionGroupId;
      minimumVersion: number;
    }
  | {
      action: "delete";
      projectId: ProjectId;
      groupId: SessionGroupId;
      directSessionIds: readonly SessionId[];
      childGroupIds: readonly SessionGroupId[];
      parentGroupId?: SessionGroupId;
    };

/**
 * ADAPTER
 *
 * Projects canonical project-local Groups from one typed snapshot and translates exact CLI
 * mutations into recorded Observer commands with optimistic version and membership preconditions.
 */
export async function runGroupCommand(
  args: string[],
  options: GroupCommandOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<GroupCommandResult> {
  const parsed = parseGroupArgs(args);
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
  switch (parsed.action) {
    case "create":
      return runCreateGroup(parsed, snapshot, options, timeoutMs, deps);
    case "rename":
      return runRenameGroup(parsed, snapshot, options, timeoutMs, deps);
    case "members.add":
      return runMembershipGroup(parsed, snapshot, "members.add", options, timeoutMs, deps);
    case "members.remove":
      return runMembershipGroup(parsed, snapshot, "members.remove", options, timeoutMs, deps);
    case "reparent":
      return runReparentGroup(parsed, snapshot, options, timeoutMs, deps);
    case "delete":
      return runDeleteGroup(parsed, snapshot, options, timeoutMs, deps);
  }
}

async function runCreateGroup(
  parsed: Extract<ParsedGroupArgs, { action: "create" }>,
  snapshot: StationSnapshot,
  options: GroupCommandOptions,
  timeoutMs: number,
  deps: ObserverProcessDeps,
): Promise<Extract<GroupCommandResult, { action: "create" }>> {
  assertProject(snapshot, parsed.projectId);
  const memberships = sessionMemberships(snapshot);
  const seen = new Set<SessionId>();
  for (const sessionId of parsed.sessionIds) {
    if (seen.has(sessionId)) throw duplicateSessionError(sessionId);
    seen.add(sessionId);
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
  const outcome = await executeGroupCommand(command, options, timeoutMs, deps);
  if (outcome.status === "accepted")
    throw missingCompletionError(outcome.receipt.commandId, outcome.receipt.traceId);
  if (outcome.status !== "succeeded") return { action: "create", outcome };

  const created = parseCreatedResult(
    outcome.record,
    outcome.receipt.commandId,
    outcome.receipt.traceId,
    command,
  );
  return {
    action: "create",
    outcome,
    created,
    convergence: await loadGroupConvergence(
      {
        action: "create",
        projectId: parsed.projectId,
        groupId: created.groupId,
        name: parsed.name,
        sessionIds: parsed.sessionIds,
        version: created.version,
      },
      snapshotLoadOptions(options, timeoutMs),
      deps,
    ),
  };
}

async function runRenameGroup(
  parsed: Extract<ParsedGroupArgs, { action: "rename" }>,
  snapshot: StationSnapshot,
  options: GroupCommandOptions,
  timeoutMs: number,
  deps: ObserverProcessDeps,
): Promise<Extract<GroupCommandResult, { action: "rename" }>> {
  const target = findGroup(snapshot, parsed.groupId);
  const command = RenameSessionGroupCommandSchema.parse({
    type: "sessionGroup.rename",
    payload: {
      projectId: target.projectId,
      groupId: target.id,
      expectedVersion: target.version,
      name: parsed.name,
    },
  });
  const outcome = await executeGroupCommand(command, options, timeoutMs, deps);
  if (outcome.status === "accepted")
    throw missingCompletionError(outcome.receipt.commandId, outcome.receipt.traceId);
  if (outcome.status !== "succeeded") return { action: "rename", target, outcome };
  return {
    action: "rename",
    target,
    outcome,
    convergence: await loadGroupConvergence(
      {
        action: "rename",
        projectId: target.projectId,
        groupId: target.id,
        name: parsed.name,
        minimumVersion: target.version,
      },
      snapshotLoadOptions(options, timeoutMs),
      deps,
    ),
  };
}

async function runMembershipGroup(
  parsed: Extract<ParsedGroupArgs, { action: "members.add" | "members.remove" }>,
  snapshot: StationSnapshot,
  action: "members.add" | "members.remove",
  options: GroupCommandOptions,
  timeoutMs: number,
  deps: ObserverProcessDeps,
): Promise<Extract<GroupCommandResult, { action: "members.add" | "members.remove" }>> {
  const target = findGroup(snapshot, parsed.groupId);
  const memberships = sessionMemberships(snapshot);
  const seen = new Set<SessionId>();
  for (const sessionId of parsed.sessionIds) {
    if (seen.has(sessionId)) throw duplicateSessionError(sessionId);
    seen.add(sessionId);
    const session = findSession(snapshot, sessionId);
    assertSessionProject(session.projectId, target.projectId, sessionId);
    const currentGroupId = memberships.get(sessionId);
    if (action === "members.remove" && currentGroupId !== target.id) {
      throw sessionNotDirectMemberError(sessionId, target.id);
    }
  }

  const payload: MembershipGroupCommand["payload"] = {
    projectId: target.projectId,
    groupId: target.id,
    expectedVersion: target.version,
  };
  if (action === "members.add") {
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
  const outcome = await executeGroupCommand(command, options, timeoutMs, deps);
  if (outcome.status === "accepted")
    throw missingCompletionError(outcome.receipt.commandId, outcome.receipt.traceId);
  if (outcome.status !== "succeeded") {
    return action === "members.add"
      ? { action: "members.add", target, outcome }
      : { action: "members.remove", target, outcome };
  }
  const convergence = await loadGroupConvergence(
    {
      action,
      projectId: target.projectId,
      groupId: target.id,
      sessionIds: parsed.sessionIds,
      minimumVersion: target.version,
    },
    snapshotLoadOptions(options, timeoutMs),
    deps,
  );
  return action === "members.add"
    ? { action: "members.add", target, outcome, convergence }
    : { action: "members.remove", target, outcome, convergence };
}

async function runReparentGroup(
  parsed: Extract<ParsedGroupArgs, { action: "reparent" }>,
  snapshot: StationSnapshot,
  options: GroupCommandOptions,
  timeoutMs: number,
  deps: ObserverProcessDeps,
): Promise<Extract<GroupCommandResult, { action: "reparent" }>> {
  const target = findGroup(snapshot, parsed.groupId);
  if (parsed.parentGroupId !== undefined) {
    const parent = findGroup(snapshot, parsed.parentGroupId);
    assertSessionProject(parent.projectId, target.projectId, parent.id, "parent Group");
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
  const outcome = await executeGroupCommand(command, options, timeoutMs, deps);
  if (outcome.status === "accepted")
    throw missingCompletionError(outcome.receipt.commandId, outcome.receipt.traceId);
  if (outcome.status !== "succeeded") return { action: "reparent", target, outcome };
  return {
    action: "reparent",
    target,
    outcome,
    convergence: await loadGroupConvergence(
      {
        action: "reparent",
        projectId: target.projectId,
        groupId: target.id,
        ...(parsed.parentGroupId === undefined ? {} : { parentGroupId: parsed.parentGroupId }),
        minimumVersion: target.version,
      },
      snapshotLoadOptions(options, timeoutMs),
      deps,
    ),
  };
}

async function runDeleteGroup(
  parsed: Extract<ParsedGroupArgs, { action: "delete" }>,
  snapshot: StationSnapshot,
  options: GroupCommandOptions,
  timeoutMs: number,
  deps: ObserverProcessDeps,
): Promise<Extract<GroupCommandResult, { action: "delete" }>> {
  const target = findGroup(snapshot, parsed.groupId);
  const command = DeleteSessionGroupCommandSchema.parse({
    type: "sessionGroup.delete",
    payload: {
      projectId: target.projectId,
      groupId: target.id,
      expectedVersion: target.version,
    },
  });
  const outcome = await executeGroupCommand(command, options, timeoutMs, deps);
  if (outcome.status === "accepted")
    throw missingCompletionError(outcome.receipt.commandId, outcome.receipt.traceId);
  if (outcome.status !== "succeeded") return { action: "delete", target, outcome };
  return {
    action: "delete",
    target,
    outcome,
    convergence: await loadGroupConvergence(
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
      snapshotLoadOptions(options, timeoutMs),
      deps,
    ),
  };
}

async function executeGroupCommand<TCommand extends GroupMutationCommand>(
  command: TCommand,
  options: GroupCommandOptions,
  timeoutMs: number,
  deps: ObserverProcessDeps,
): Promise<CommandExecutionOutcome<TCommand>> {
  return executeTypedObserverCommand(command, mutationExecutionOptions(options, timeoutMs), deps);
}

async function loadGroupConvergence(
  expectation: GroupConvergenceExpectation,
  options: ObserverSnapshotLoadOptions,
  deps: ObserverProcessDeps,
): Promise<GroupMutationConvergence> {
  try {
    const snapshot = await loadObserverSnapshot(options, deps);
    const groups = projectGroups(snapshot, expectation.projectId);
    if (groupExpectationConverged(expectation, groups)) {
      return { status: "confirmed", projectId: expectation.projectId, groups };
    }
    return {
      status: "warning",
      projectId: expectation.projectId,
      groups,
      warning: projectionMismatchError(expectation),
    };
  } catch (error) {
    const warning = publicSafeErrorFromUnknown(error, {
      tag: "GroupCliError",
      code: `GROUP_${convergenceAction(expectation)}_CONVERGENCE_REFRESH_FAILED`,
      message: "The Group command succeeded, but Station could not load the refreshed snapshot.",
    });
    if (warning.projectId === undefined) warning.projectId = expectation.projectId;
    if ("groupId" in expectation) {
      warning.hint ??= `Inspect the current Group with \`stn group get ${expectation.groupId} --json\`.`;
    }
    return { status: "warning", projectId: expectation.projectId, warning };
  }
}

function groupExpectationConverged(
  expectation: GroupConvergenceExpectation,
  groups: readonly SessionGroupView[],
): boolean {
  if (expectation.action === "delete") {
    if (groups.some((group) => group.id === expectation.groupId)) return false;
    if (
      expectation.childGroupIds.some((childGroupId) => {
        const child = groups.find((group) => group.id === childGroupId);
        return child === undefined || child.parentGroupId !== expectation.parentGroupId;
      })
    ) {
      return false;
    }
    return !groups.some((group) =>
      expectation.directSessionIds.some((sessionId) => group.sessionIds.includes(sessionId)),
    );
  }

  const group = groups.find((candidate) => candidate.id === expectation.groupId);
  if (group === undefined) return false;
  switch (expectation.action) {
    case "create":
      return (
        group.version >= expectation.version &&
        group.name === expectation.name &&
        group.parentGroupId === undefined &&
        sameSessionIds(group.sessionIds, expectation.sessionIds)
      );
    case "rename":
      return group.version >= expectation.minimumVersion && group.name === expectation.name;
    case "members.add":
      return (
        group.version >= expectation.minimumVersion &&
        expectation.sessionIds.every((sessionId) => group.sessionIds.includes(sessionId))
      );
    case "members.remove":
      return (
        group.version >= expectation.minimumVersion &&
        expectation.sessionIds.every((sessionId) => !group.sessionIds.includes(sessionId))
      );
    case "reparent":
      return (
        group.version >= expectation.minimumVersion &&
        group.parentGroupId === expectation.parentGroupId
      );
  }
}

function projectionMismatchError(expectation: GroupConvergenceExpectation): SafeError {
  const action = convergenceAction(expectation);
  const error: SafeError = {
    tag: "GroupCliError",
    code: `GROUP_${action}_CONVERGENCE_MISMATCH`,
    message: `The Group ${action.toLowerCase()} command succeeded, but the refreshed snapshot did not preserve the expected Group projection.`,
    hint: "Inspect the refreshed Group state before retrying.",
    projectId: expectation.projectId,
  };
  if ("groupId" in expectation) {
    error.hint = `${error.hint} Use \`stn group get ${expectation.groupId} --json\`.`;
  }
  return error;
}

function convergenceAction(expectation: GroupConvergenceExpectation): string {
  return expectation.action.toUpperCase().replace(".", "_");
}

function projectGroups(snapshot: StationSnapshot, projectId?: ProjectId): SessionGroupView[] {
  return snapshot.sessionGroups
    .filter((group) => projectId === undefined || group.projectId === projectId)
    .map(projectGroup);
}

function projectGroup(group: SessionGroupView): SessionGroupView {
  const projected: SessionGroupView = {
    id: group.id,
    projectId: group.projectId,
    name: group.name,
    sessionIds: [...group.sessionIds],
    version: group.version,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
  if (group.parentGroupId !== undefined) projected.parentGroupId = group.parentGroupId;
  return projected;
}

function findGroup(snapshot: StationSnapshot, groupId: SessionGroupId): SessionGroupView {
  const group = snapshot.sessionGroups.find((candidate) => candidate.id === groupId);
  if (group === undefined) throw groupNotFoundError(groupId);
  return projectGroup(group);
}

function findSession(
  snapshot: StationSnapshot,
  sessionId: SessionId,
): StationSnapshot["sessions"][number] {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw sessionNotFoundError(sessionId);
  return session;
}

function sessionMemberships(snapshot: StationSnapshot): Map<SessionId, SessionGroupId> {
  const memberships = new Map<SessionId, SessionGroupId>();
  for (const group of snapshot.sessionGroups) {
    for (const sessionId of group.sessionIds) memberships.set(sessionId, group.id);
  }
  return memberships;
}

function sameSessionIds(left: readonly SessionId[], right: readonly SessionId[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((sessionId) => expected.has(sessionId));
}

function assertProject(snapshot: StationSnapshot, projectId: ProjectId): void {
  if (!snapshot.projects.some((project) => project.id === projectId)) {
    throw groupProjectNotFoundError(projectId);
  }
}

function assertSessionProject(
  sessionProjectId: ProjectId,
  projectId: ProjectId,
  identity: string,
  label = "session",
): void {
  if (sessionProjectId !== projectId) throw sessionProjectMismatchError(identity, projectId, label);
}

function parseGroupArgs(args: string[]): ParsedGroupArgs {
  const action = args[0];
  if (action === undefined) {
    throw new Error("Group command requires a subcommand. Use: stn group --help.");
  }
  if (action === "list") return parseListArgs(args.slice(1));
  if (action === "get") return parseGetArgs(args.slice(1));
  if (action === "create") return parseCreateArgs(args.slice(1));
  if (action === "rename") return parseRenameArgs(args.slice(1));
  if (action === "members") return parseMembersArgs(args.slice(1));
  if (action === "reparent") return parseReparentArgs(args.slice(1));
  if (action === "delete") return parseDeleteArgs(args.slice(1));
  throw new Error(`Unknown group command: ${action}. Use: stn group --help.`);
}

function parseListArgs(args: string[]): Extract<ParsedGroupArgs, { action: "list" }> {
  const seen = new Set<string>();
  const filters: GroupFilters = {};
  let outputFormat: GroupOutputFormat = "text";
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--project") {
      claimOption(seen, option, "group list");
      filters.project = parseProjectId(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--json") {
      claimOption(seen, option, "group list");
      outputFormat = "json";
      continue;
    }
    throw new Error(`Unknown group list option: ${option ?? ""}`);
  }
  return { action: "list", filters, outputFormat };
}

function parseGetArgs(args: string[]): Extract<ParsedGroupArgs, { action: "get" }> {
  const groupId = parseGroupId(args[0], "group get");
  const seen = new Set<string>();
  let outputFormat: GroupOutputFormat = "text";
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--json") {
      claimOption(seen, option, "group get");
      outputFormat = "json";
      continue;
    }
    throw new Error(`Unknown group get option: ${option ?? ""}`);
  }
  return { action: "get", groupId, outputFormat };
}

function parseCreateArgs(args: string[]): Extract<ParsedGroupArgs, { action: "create" }> {
  const projectId = parseProjectId(args[0], "group create");
  const name = parseGroupName(args[1], "group create");
  const sessionIds: SessionId[] = [];
  const seen = new Set<string>();
  let outputFormat: GroupOutputFormat = "text";
  let timeoutMs: number | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--session") {
      sessionIds.push(parseSessionId(args[index + 1], option));
      index += 1;
      continue;
    }
    if (option === "--timeout-ms") {
      claimOption(seen, option, "group create");
      timeoutMs = parsePositiveIntegerOption(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--json") {
      claimOption(seen, option, "group create");
      outputFormat = "json";
      continue;
    }
    throw new Error(`Unknown group create option: ${option ?? ""}`);
  }
  const parsed: Extract<ParsedGroupArgs, { action: "create" }> = {
    action: "create",
    projectId,
    name,
    sessionIds,
    outputFormat,
  };
  if (timeoutMs !== undefined) parsed.timeoutMs = timeoutMs;
  return parsed;
}

function parseRenameArgs(args: string[]): Extract<ParsedGroupArgs, { action: "rename" }> {
  const groupId = parseGroupId(args[0], "group rename");
  const name = parseGroupName(args[1], "group rename");
  const options = parseMutationOptions(args.slice(2), "group rename");
  const parsed: Extract<ParsedGroupArgs, { action: "rename" }> = {
    action: "rename",
    groupId,
    name,
    outputFormat: options.outputFormat,
  };
  if (options.timeoutMs !== undefined) parsed.timeoutMs = options.timeoutMs;
  return parsed;
}

function parseMembersArgs(
  args: string[],
): Extract<ParsedGroupArgs, { action: "members.add" | "members.remove" }> {
  const action = args[0];
  if (action !== "add" && action !== "remove") {
    throw new Error("group members requires the add or remove subcommand.");
  }
  const groupId = parseGroupId(args[1], `group members ${action}`);
  const sessionIds: SessionId[] = [];
  const seen = new Set<string>();
  let outputFormat: GroupOutputFormat = "text";
  let timeoutMs: number | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--timeout-ms") {
      claimOption(seen, option, `group members ${action}`);
      timeoutMs = parsePositiveIntegerOption(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--json") {
      claimOption(seen, option, `group members ${action}`);
      outputFormat = "json";
      continue;
    }
    sessionIds.push(parseSessionId(option, `group members ${action}`));
  }
  if (sessionIds.length === 0) {
    throw new Error(`group members ${action} requires at least one session id.`);
  }
  const parsed: Extract<ParsedGroupArgs, { action: "members.add" | "members.remove" }> = {
    action: action === "add" ? "members.add" : "members.remove",
    groupId,
    sessionIds,
    outputFormat,
  };
  if (timeoutMs !== undefined) parsed.timeoutMs = timeoutMs;
  return parsed;
}

function parseReparentArgs(args: string[]): Extract<ParsedGroupArgs, { action: "reparent" }> {
  const groupId = parseGroupId(args[0], "group reparent");
  const seen = new Set<string>();
  let parentGroupId: SessionGroupId | undefined;
  let root = false;
  let outputFormat: GroupOutputFormat = "text";
  let timeoutMs: number | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--parent") {
      claimOption(seen, option, "group reparent");
      parentGroupId = parseGroupId(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--root") {
      claimOption(seen, option, "group reparent");
      root = true;
      continue;
    }
    if (option === "--timeout-ms") {
      claimOption(seen, option, "group reparent");
      timeoutMs = parsePositiveIntegerOption(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--json") {
      claimOption(seen, option, "group reparent");
      outputFormat = "json";
      continue;
    }
    throw new Error(`Unknown group reparent option: ${option ?? ""}`);
  }
  if ((parentGroupId === undefined) === !root) {
    throw new Error("group reparent requires exactly one of --parent <groupId> or --root.");
  }
  const parsed: Extract<ParsedGroupArgs, { action: "reparent" }> = {
    action: "reparent",
    groupId,
    outputFormat,
  };
  if (parentGroupId !== undefined) parsed.parentGroupId = parentGroupId;
  if (timeoutMs !== undefined) parsed.timeoutMs = timeoutMs;
  return parsed;
}

function parseDeleteArgs(args: string[]): Extract<ParsedGroupArgs, { action: "delete" }> {
  const groupId = parseGroupId(args[0], "group delete");
  const options = parseMutationOptions(args.slice(1), "group delete");
  const parsed: Extract<ParsedGroupArgs, { action: "delete" }> = {
    action: "delete",
    groupId,
    outputFormat: options.outputFormat,
  };
  if (options.timeoutMs !== undefined) parsed.timeoutMs = options.timeoutMs;
  return parsed;
}

function parseMutationOptions(
  args: string[],
  command: string,
): { outputFormat: GroupOutputFormat; timeoutMs?: number } {
  const seen = new Set<string>();
  let outputFormat: GroupOutputFormat = "text";
  let timeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--timeout-ms") {
      claimOption(seen, option, command);
      timeoutMs = parsePositiveIntegerOption(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--json") {
      claimOption(seen, option, command);
      outputFormat = "json";
      continue;
    }
    throw new Error(`Unknown ${command} option: ${option ?? ""}`);
  }
  return { outputFormat, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

function parseProjectId(value: string | undefined, command: string): ProjectId {
  const raw = parseRequiredOptionValue(value, command);
  if (raw.startsWith("--"))
    throw new CliInputError("CLI_GROUP_PROJECT_ID_INVALID", `${command} requires a project id.`);
  const parsed = ProjectIdSchema.safeParse(raw);
  if (!parsed.success)
    throw new CliInputError("CLI_GROUP_PROJECT_ID_INVALID", `${command} requires a project id.`);
  return parsed.data;
}

function parseGroupId(value: string | undefined, command: string): SessionGroupId {
  const raw = parseRequiredOptionValue(value, command);
  if (raw.startsWith("--"))
    throw new CliInputError("CLI_GROUP_ID_INVALID", `${command} requires an exact Group id.`);
  const parsed = SessionGroupIdSchema.safeParse(raw);
  if (!parsed.success)
    throw new CliInputError("CLI_GROUP_ID_INVALID", `${command} requires an exact Group id.`);
  return parsed.data;
}

function parseGroupName(value: string | undefined, command: string): string {
  if (value === undefined || value.startsWith("--")) {
    throw new CliInputError("CLI_GROUP_NAME_REQUIRED", `${command} requires a non-empty name.`);
  }
  const parsed = SessionGroupNameSchema.safeParse(value);
  if (!parsed.success)
    throw new CliInputError("CLI_GROUP_NAME_INVALID", `${command} requires a non-empty name.`);
  return parsed.data;
}

function parseSessionId(value: string | undefined, command: string): SessionId {
  const raw = parseRequiredOptionValue(value, command);
  if (raw.startsWith("--"))
    throw new CliInputError(
      "CLI_GROUP_SESSION_ID_INVALID",
      `${command} requires an exact session id.`,
    );
  const parsed = SessionIdSchema.safeParse(raw);
  if (!parsed.success)
    throw new CliInputError(
      "CLI_GROUP_SESSION_ID_INVALID",
      `${command} requires an exact session id.`,
    );
  return parsed.data;
}

function claimOption(seen: Set<string>, option: string, command: string): void {
  if (seen.has(option)) throw new Error(`Duplicate ${command} option: ${option}.`);
  seen.add(option);
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
  const executionOptions: TypedObserverCommandOptions = {
    timeoutMs,
    waitForCompletion: true,
  };
  if (options.config !== undefined) executionOptions.config = options.config;
  if (options.configPath !== undefined) executionOptions.configPath = options.configPath;
  return executionOptions;
}

function parseCreatedResult(
  record: GroupSuccessOutcome<CreateGroupCommand>["record"],
  commandId: string,
  traceId: string | undefined,
  command: CreateGroupCommand,
): SessionGroupCreateCommandResult {
  const parsed = SessionGroupCreateCommandResultSchema.safeParse(record.result);
  if (!parsed.success || parsed.data.projectId !== command.payload.projectId) {
    const error: SafeError = {
      tag: "GroupCliError",
      code: "GROUP_CREATE_RESULT_INVALID",
      message: "The succeeded Group create command did not return its exact durable Group result.",
      hint: "Inspect the command record before retrying; the Group id must come from its typed result.",
      commandId,
    };
    if (traceId !== undefined) error.traceId = traceId;
    if (parsed.success && parsed.data.projectId !== command.payload.projectId) {
      error.projectId = command.payload.projectId;
    }
    throw error;
  }
  return parsed.data;
}

function missingCompletionError(commandId: string, traceId: string | undefined): SafeError {
  const error: SafeError = {
    tag: "GroupCliError",
    code: "GROUP_COMMAND_COMPLETION_MISSING",
    message: "The Group command returned before its durable completion was available.",
    commandId,
  };
  if (traceId !== undefined) error.traceId = traceId;
  return error;
}

function groupProjectNotFoundError(projectId: ProjectId): SafeError {
  return {
    tag: "GroupCliError",
    code: "GROUP_PROJECT_NOT_FOUND",
    message: `No current project has the exact id ${projectId}.`,
    hint: "Use `stn project list` or `stn group list` and retry with a configured project id.",
    projectId,
  };
}

function groupNotFoundError(groupId: SessionGroupId): SafeError {
  return {
    tag: "GroupCliError",
    code: "GROUP_NOT_FOUND",
    message: `No current Session Group has the exact id ${groupId}.`,
    hint: "Use `stn group list` and pass one complete current Group id.",
  };
}

function sessionNotFoundError(sessionId: SessionId): SafeError {
  return {
    tag: "GroupCliError",
    code: "GROUP_SESSION_NOT_FOUND",
    message: `No current session has the exact id ${sessionId}.`,
    hint: "Use `stn session list` and pass one complete current session id.",
    sessionId,
  };
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

function sessionProjectMismatchError(
  identity: string,
  projectId: ProjectId,
  label: string,
): SafeError {
  return {
    tag: "GroupCliError",
    code:
      label === "parent Group" ? "GROUP_PARENT_PROJECT_MISMATCH" : "GROUP_SESSION_PROJECT_MISMATCH",
    message: `${label} ${identity} does not belong to project ${projectId}.`,
    hint: "Session Groups only contain same-project sessions and parents.",
    projectId,
    ...(label === "parent Group" ? {} : { sessionId: identity }),
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

export function renderGroupCommandText(result: GroupCommandResult): string {
  if (result.action === "list") {
    const lines: string[] = [];
    if (result.filters.project !== undefined) {
      lines.push(`Filter: project=${escapeTerminalBytes(result.filters.project)}`, "");
    }
    if (result.groups.length === 0) return [...lines, "No Session Groups matched."].join("\n");
    return [...lines, ...renderGroupList(result.groups)].join("\n");
  }
  if (result.action === "get") return renderGroup(result.group);

  const lines = [`Group ${escapeTerminalBytes(result.action)}`];
  if (result.action !== "create") {
    lines.push(`Target: ${escapeTerminalBytes(result.target.id)}`, renderGroup(result.target));
  }
  lines.push(...renderGroupOutcome(result.outcome));
  if (result.action === "create" && result.outcome.status === "succeeded" && "created" in result) {
    lines.push(
      `Created: ${escapeTerminalBytes(result.created.groupId)}`,
      `Project: ${escapeTerminalBytes(result.created.projectId)}`,
      `Version: ${result.created.version}`,
    );
  }
  if ("convergence" in result) {
    lines.push("", ...renderGroupConvergence(result.convergence));
  }
  return lines.join("\n");
}

function renderGroupList(groups: readonly SessionGroupView[]): string[] {
  return groups.flatMap((group, index) => [...(index === 0 ? [] : [""]), renderGroup(group)]);
}

function renderGroup(group: SessionGroupView): string {
  const lines = [
    `${escapeTerminalBytes(group.id)}  ${escapeTerminalBytes(group.name)}`,
    `  project: ${escapeTerminalBytes(group.projectId)}`,
    `  sessions: ${
      group.sessionIds.length === 0
        ? "(none)"
        : group.sessionIds.map(escapeTerminalBytes).join(", ")
    }`,
    `  parent: ${group.parentGroupId === undefined ? "(root)" : escapeTerminalBytes(group.parentGroupId)}`,
    `  version: ${group.version}`,
    `  created: ${escapeTerminalBytes(group.createdAt)}`,
    `  updated: ${escapeTerminalBytes(group.updatedAt)}`,
  ];
  return lines.join("\n");
}

function renderGroupOutcome(
  outcome: Exclude<CompletedGroupOutcome<GroupMutationCommand>, { status: "accepted" }>,
): string[] {
  const lines = [`Outcome: ${escapeTerminalBytes(outcome.status)}`];
  if (outcome.receipt.traceId !== undefined) {
    lines.push(`Trace: ${escapeTerminalBytes(outcome.receipt.traceId)}`);
  }
  lines.push(`Command: ${escapeTerminalBytes(outcome.receipt.commandId)}`);
  if (outcome.status === "rejected" && outcome.receipt.error !== undefined) {
    lines.push(...renderGroupError("Error", outcome.receipt.error));
  }
  if (outcome.status === "failed" && outcome.record.error !== undefined) {
    lines.push(...renderGroupError("Error", outcome.record.error));
  }
  return lines;
}

function renderGroupConvergence(convergence: GroupMutationConvergence): string[] {
  const lines = [
    `Convergence: ${escapeTerminalBytes(convergence.status)}`,
    `Project: ${escapeTerminalBytes(convergence.projectId)}`,
  ];
  if (convergence.groups !== undefined) {
    lines.push("Groups:", ...renderGroupList(convergence.groups));
  }
  if (convergence.warning !== undefined) {
    lines.push(...renderGroupError("Warning", convergence.warning));
  }
  return lines;
}

function renderGroupError(label: string, error: SafeError): string[] {
  const lines = [
    `${label}: ${escapeTerminalBytes(error.code)}: ${escapeTerminalBytes(error.message)}`,
  ];
  if (error.hint !== undefined) lines.push(`  hint: ${escapeTerminalBytes(error.hint)}`);
  return lines;
}
