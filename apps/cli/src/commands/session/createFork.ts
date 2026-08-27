import type {
  AcceptedCommandReceipt,
  CommandExecutionOutcome,
  ProjectView,
  ProviderHealth,
  ProviderId,
  SafeError,
  SessionCreateCommandResult,
  SessionForkCommandResult,
  SessionGroupPlacementIntent,
  SourceSessionGroupPlacementIntent,
  StationCommand,
  StationSnapshot,
  TerminalPlacementRequest,
} from "@station/contracts";
import {
  CreateSessionCommandSchema,
  ForkSessionCommandSchema,
  SessionCreateCommandResultSchema,
  SessionForkCommandResultSchema,
} from "@station/contracts";
import { CliInputError } from "../../args.js";
import type { ObserverProcessDeps } from "../../observerProcess.js";
import { defaultStdinMaxBytes } from "../../stdin.js";
import { executeTypedObserverCommand, type TypedObserverCommandOptions } from "../command.js";
import type { ObserverSnapshotLoadOptions } from "../snapshot.js";
import type {
  ParsedCreateOrForkSessionArgs,
  ParsedCreateSessionArgs,
  ParsedForkSessionArgs,
} from "./args.js";
import {
  loadSessionCreationConvergence,
  type SessionCreationConvergenceExpectation,
} from "./creationConvergence.js";
import { runCurrentSessionCommand } from "./current.js";
import type { SessionCommandOptions } from "./options.js";
import type { SessionCommandResult, SessionCreationOutcome } from "./result.js";
import { findSessionSummary } from "./summary.js";

type CreateSessionCommand = Extract<StationCommand, { type: "session.create" }>;
type ForkSessionCommand = Extract<StationCommand, { type: "session.fork" }>;

export function sessionCreationPrompt(
  parsed: ParsedCreateOrForkSessionArgs,
  options: SessionCommandOptions,
): string | undefined {
  if (!parsed.promptStdin) return undefined;
  if (options.initialPrompt === undefined || options.initialPrompt.trim().length === 0) {
    throw new CliInputError(
      "CLI_SESSION_PROMPT_STDIN_REQUIRED",
      "--prompt-stdin requires a non-empty prompt on stdin.",
    );
  }
  if (Buffer.byteLength(options.initialPrompt) > defaultStdinMaxBytes) {
    throw new CliInputError(
      "CLI_SESSION_PROMPT_STDIN_TOO_LARGE",
      "The prompt on stdin exceeded the supported size limit.",
    );
  }
  return options.initialPrompt;
}

export async function runCreateOrForkSessionCommand(
  parsed: ParsedCreateOrForkSessionArgs,
  snapshot: StationSnapshot,
  initialPrompt: string | undefined,
  timeoutMs: number,
  options: SessionCommandOptions,
  deps: ObserverProcessDeps,
): Promise<Extract<SessionCommandResult, { action: "create" | "fork" }>> {
  const project =
    parsed.action === "create"
      ? findAvailableProject(snapshot, parsed.projectId)
      : findAvailableProject(
          snapshot,
          findSessionSummary(snapshot, parsed.sourceSessionId).projectId,
        );
  const terminalProvider = validateTmuxProvider(snapshot);
  const placement = await resolvePlacement(parsed, timeoutMs, options, deps);

  if (parsed.action === "create") {
    return runCreateSession(
      parsed,
      snapshot,
      project,
      terminalProvider,
      placement,
      initialPrompt,
      timeoutMs,
      options,
      deps,
    );
  }
  return runForkSession(
    parsed,
    snapshot,
    project,
    terminalProvider,
    placement,
    initialPrompt,
    timeoutMs,
    options,
    deps,
  );
}

async function runCreateSession(
  parsed: ParsedCreateSessionArgs,
  snapshot: StationSnapshot,
  project: ProjectView,
  terminalProvider: ProviderId,
  placement: TerminalPlacementRequest,
  initialPrompt: string | undefined,
  timeoutMs: number,
  options: SessionCommandOptions,
  deps: ObserverProcessDeps,
): Promise<Extract<SessionCommandResult, { action: "create" }>> {
  const harnessProvider = parsed.harness ?? project.defaults.harness;
  validateHarnessProvider(snapshot, harnessProvider);
  const group = resolveCreateGroup(snapshot, project, parsed);
  const command = createCommand(
    parsed,
    project,
    harnessProvider,
    terminalProvider,
    placement,
    group,
    initialPrompt,
  );
  const outcome = await executeTypedObserverCommand(
    command,
    mutationExecutionOptions(options, timeoutMs),
    deps,
  );
  if (outcome.status === "accepted") throw missingSessionCompletionError(outcome.receipt);
  if (outcome.status === "rejected") {
    return { action: "create", outcome: { status: "rejected", receipt: outcome.receipt } };
  }
  if (outcome.status === "failed") {
    return { action: "create", outcome: failedCreationOutcome(outcome) };
  }
  const result = parseCreateResult(command, outcome);
  const convergence = await loadSessionCreationConvergence(
    convergenceExpectation("create", parsed, result, harnessProvider, terminalProvider),
    snapshotLoadOptions(options, timeoutMs),
    deps,
  );
  return {
    action: "create",
    outcome: succeededCreationOutcome(outcome, result),
    convergence,
  };
}

async function runForkSession(
  parsed: ParsedForkSessionArgs,
  snapshot: StationSnapshot,
  project: ProjectView,
  terminalProvider: ProviderId,
  placement: TerminalPlacementRequest,
  initialPrompt: string | undefined,
  timeoutMs: number,
  options: SessionCommandOptions,
  deps: ObserverProcessDeps,
): Promise<Extract<SessionCommandResult, { action: "fork" }>> {
  const source = findSessionSummary(snapshot, parsed.sourceSessionId);
  const harnessProvider = parsed.harness ?? source.harness.provider;
  validateHarnessProvider(snapshot, harnessProvider);
  const group = resolveForkGroup(snapshot, parsed, source.projectId);
  const command = forkCommand(
    parsed,
    source.worktreeId,
    project,
    harnessProvider,
    terminalProvider,
    placement,
    group,
    initialPrompt,
  );
  const outcome = await executeTypedObserverCommand(
    command,
    mutationExecutionOptions(options, timeoutMs),
    deps,
  );
  if (outcome.status === "accepted") throw missingSessionCompletionError(outcome.receipt);
  if (outcome.status === "rejected") {
    return { action: "fork", outcome: { status: "rejected", receipt: outcome.receipt } };
  }
  if (outcome.status === "failed") {
    return { action: "fork", outcome: failedCreationOutcome(outcome) };
  }
  const result = parseForkResult(command, outcome);
  const convergence = await loadSessionCreationConvergence(
    convergenceExpectation("fork", parsed, result, harnessProvider, terminalProvider),
    snapshotLoadOptions(options, timeoutMs),
    deps,
  );
  return {
    action: "fork",
    outcome: succeededCreationOutcome(outcome, result),
    convergence,
  };
}

function createCommand(
  parsed: ParsedCreateSessionArgs,
  project: ProjectView,
  harnessProvider: ProviderId,
  terminalProvider: ProviderId,
  placement: TerminalPlacementRequest,
  group: SessionGroupPlacementIntent | undefined,
  initialPrompt: string | undefined,
): CreateSessionCommand {
  const payload: CreateSessionCommand["payload"] = {
    projectId: project.id,
    branch: parsed.branch,
    harness: { provider: harnessProvider },
    terminal: { provider: terminalProvider },
    placement,
  };
  if (parsed.title !== undefined) payload.title = parsed.title;
  if (parsed.base !== undefined) payload.base = parsed.base;
  if (parsed.layout !== undefined) payload.terminal.layout = parsed.layout;
  if (group !== undefined) payload.group = group;
  if (initialPrompt !== undefined) payload.initialPrompt = initialPrompt;
  return CreateSessionCommandSchema.parse({ type: "session.create", payload });
}

function forkCommand(
  parsed: ParsedForkSessionArgs,
  sourceWorktreeId: ForkSessionCommand["payload"]["sourceWorktreeId"],
  project: ProjectView,
  harnessProvider: ProviderId,
  terminalProvider: ProviderId,
  placement: TerminalPlacementRequest,
  group: SourceSessionGroupPlacementIntent | undefined,
  initialPrompt: string | undefined,
): ForkSessionCommand {
  const payload: ForkSessionCommand["payload"] = {
    projectId: project.id,
    sourceWorktreeId,
    branch: parsed.branch,
    harness: { provider: harnessProvider },
    terminal: { provider: terminalProvider },
    placement,
  };
  if (parsed.title !== undefined) payload.title = parsed.title;
  if (parsed.base !== undefined) payload.base = parsed.base;
  if (parsed.copyDirty !== undefined) payload.copyDirty = parsed.copyDirty;
  if (parsed.layout !== undefined) payload.terminal.layout = parsed.layout;
  if (group !== undefined) payload.group = group;
  if (initialPrompt !== undefined) payload.initialPrompt = initialPrompt;
  return ForkSessionCommandSchema.parse({ type: "session.fork", payload });
}

async function resolvePlacement(
  parsed: ParsedCreateOrForkSessionArgs,
  timeoutMs: number,
  options: SessionCommandOptions,
  deps: ObserverProcessDeps,
): Promise<TerminalPlacementRequest> {
  if (parsed.placement.kind === "terminal") return { intent: "detached" };
  const currentOptions = sessionOptionsWithTimeout(options, timeoutMs);
  const current = await runCurrentSessionCommand(currentOptions, deps);
  if (current.source.provider !== "tmux") {
    throw sessionCliError(
      "SESSION_CURRENT_TERMINAL_UNSUPPORTED",
      "--from-current requires current placement authority from tmux.",
      { provider: current.source.provider },
    );
  }
  return { intent: "sibling", source: current.source };
}

function resolveCreateGroup(
  snapshot: StationSnapshot,
  project: ProjectView,
  parsed: ParsedCreateSessionArgs,
): SessionGroupPlacementIntent | undefined {
  if (parsed.group.kind === "ungrouped") return undefined;
  if (parsed.group.kind === "create") {
    return { kind: "create", name: parsed.group.name };
  }
  const selectedGroupId = parsed.group.groupId;
  const group = snapshot.sessionGroups.find((candidate) => candidate.id === selectedGroupId);
  if (group === undefined) {
    throw sessionCliError(
      "SESSION_CREATE_GROUP_NOT_FOUND",
      "The requested Group is not present in the current snapshot.",
      { projectId: project.id },
    );
  }
  if (group.projectId !== project.id) {
    throw sessionCliError(
      "SESSION_CREATE_GROUP_PROJECT_MISMATCH",
      "The requested Group belongs to a different project.",
      { projectId: project.id },
    );
  }
  if (group.parentGroupId !== undefined) {
    throw sessionCliError(
      "SESSION_CREATE_GROUP_NOT_ROOT",
      "New sessions may be placed only in a root Group.",
      { projectId: project.id },
    );
  }
  return { kind: "existing", groupId: group.id };
}

function resolveForkGroup(
  snapshot: StationSnapshot,
  parsed: ParsedForkSessionArgs,
  projectId: ProjectView["id"],
): SourceSessionGroupPlacementIntent | undefined {
  if (parsed.group === "ungrouped") return undefined;
  const sourceGroup = snapshot.sessionGroups.find(
    (group) => group.projectId === projectId && group.sessionIds.includes(parsed.sourceSessionId),
  );
  if (sourceGroup === undefined) {
    if (parsed.group === "inherit") {
      throw sessionCliError(
        "SESSION_FORK_SOURCE_GROUP_MISSING",
        "The source session is currently Ungrouped and cannot satisfy --inherit-group.",
        { projectId, sessionId: parsed.sourceSessionId },
      );
    }
    return undefined;
  }
  return {
    kind: "source",
    sourceSessionId: parsed.sourceSessionId,
    groupId: sourceGroup.id,
  };
}

function findAvailableProject(snapshot: StationSnapshot, projectId: string): ProjectView {
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    throw sessionCliError(
      "SESSION_PROJECT_NOT_FOUND",
      "No configured project has the requested exact id.",
      { projectId },
    );
  }
  return project;
}

function validateHarnessProvider(snapshot: StationSnapshot, provider: ProviderId): void {
  const listed = snapshot.harnesses?.some((candidate) => candidate.id === provider);
  const health = snapshot.providerHealth[provider];
  if (snapshot.harnesses !== undefined && listed !== true) {
    throw sessionCliError(
      "SESSION_HARNESS_NOT_CONFIGURED",
      "The selected harness provider is not configured.",
      { provider },
    );
  }
  validateProviderHealth(health, provider, "harness");
}

function validateTmuxProvider(snapshot: StationSnapshot): ProviderId {
  const provider = "tmux";
  const health = snapshot.providerHealth[provider];
  if (health === undefined) {
    throw sessionCliError(
      "SESSION_TMUX_NOT_CONFIGURED",
      "The tmux terminal provider is not available in the current snapshot.",
      { provider },
    );
  }
  validateProviderHealth(health, provider, "terminal");
  return provider;
}

function validateProviderHealth(
  health: ProviderHealth | undefined,
  provider: ProviderId,
  expectedType: "harness" | "terminal",
): void {
  if (health !== undefined && health.providerType !== expectedType) {
    throw sessionCliError(
      "SESSION_PROVIDER_TYPE_MISMATCH",
      `The selected ${expectedType} provider has a different provider type.`,
      { provider },
    );
  }
}

function parseCreateResult(
  command: CreateSessionCommand,
  outcome: Extract<CommandExecutionOutcome<CreateSessionCommand>, { status: "succeeded" }>,
): SessionCreateCommandResult {
  const parsed = SessionCreateCommandResultSchema.safeParse(outcome.record.result);
  if (!parsed.success) throw missingSessionResultError("create", outcome.receipt);
  const result: SessionCreateCommandResult =
    parsed.data.requestedPlacement === "sibling"
      ? {
          type: parsed.data.type,
          projectId: parsed.data.projectId,
          worktreeId: parsed.data.worktreeId,
          sessionId: parsed.data.sessionId,
          requestedPlacement: parsed.data.requestedPlacement,
          resolvedPlacement: parsed.data.resolvedPlacement,
        }
      : {
          type: parsed.data.type,
          projectId: parsed.data.projectId,
          worktreeId: parsed.data.worktreeId,
          sessionId: parsed.data.sessionId,
          requestedPlacement: parsed.data.requestedPlacement,
          resolvedPlacement: parsed.data.resolvedPlacement,
        };
  if (parsed.data.resolvedGroupId !== undefined) {
    result.resolvedGroupId = parsed.data.resolvedGroupId;
  }
  assertMatchingCreationResult(command, result, outcome.receipt);
  return result;
}

function parseForkResult(
  command: ForkSessionCommand,
  outcome: Extract<CommandExecutionOutcome<ForkSessionCommand>, { status: "succeeded" }>,
): SessionForkCommandResult {
  const parsed = SessionForkCommandResultSchema.safeParse(outcome.record.result);
  if (!parsed.success) throw missingSessionResultError("fork", outcome.receipt);
  const result: SessionForkCommandResult =
    parsed.data.requestedPlacement === "sibling"
      ? {
          type: parsed.data.type,
          projectId: parsed.data.projectId,
          worktreeId: parsed.data.worktreeId,
          sessionId: parsed.data.sessionId,
          requestedPlacement: parsed.data.requestedPlacement,
          resolvedPlacement: parsed.data.resolvedPlacement,
        }
      : {
          type: parsed.data.type,
          projectId: parsed.data.projectId,
          worktreeId: parsed.data.worktreeId,
          sessionId: parsed.data.sessionId,
          requestedPlacement: parsed.data.requestedPlacement,
          resolvedPlacement: parsed.data.resolvedPlacement,
        };
  if (parsed.data.resolvedGroupId !== undefined) {
    result.resolvedGroupId = parsed.data.resolvedGroupId;
  }
  assertMatchingCreationResult(command, result, outcome.receipt);
  return result;
}

function assertMatchingCreationResult(
  command: CreateSessionCommand | ForkSessionCommand,
  result: SessionCreateCommandResult | SessionForkCommandResult,
  receipt: AcceptedCommandReceipt,
): void {
  if (
    result.projectId !== command.payload.projectId ||
    result.requestedPlacement !== command.payload.placement.intent ||
    result.resolvedPlacement.provider !== command.payload.terminal.provider ||
    !creationGroupResultMatches(command, result)
  ) {
    throw correlatedSessionError(
      `SESSION_${command.type === "session.create" ? "CREATE" : "FORK"}_RESULT_MISMATCH`,
      "The durable creation result does not match the dispatched project, Group, or terminal placement.",
      receipt,
    );
  }
}

function creationGroupResultMatches(
  command: CreateSessionCommand | ForkSessionCommand,
  result: SessionCreateCommandResult | SessionForkCommandResult,
): boolean {
  const group = command.payload.group;
  if (group === undefined) return result.resolvedGroupId === undefined;
  if (command.type === "session.fork") return true;
  if (group.kind === "existing") return result.resolvedGroupId === group.groupId;
  return result.resolvedGroupId !== undefined;
}

function failedCreationOutcome<TCommand extends CreateSessionCommand | ForkSessionCommand>(
  outcome: Extract<CommandExecutionOutcome<TCommand>, { status: "failed" }>,
): SessionCreationOutcome<never> {
  const completion: Extract<SessionCreationOutcome<never>, { status: "failed" }>["completion"] = {
    commandId: outcome.record.id,
  };
  if (outcome.record.traceId !== undefined) completion.traceId = outcome.record.traceId;
  if (outcome.record.error !== undefined) completion.error = outcome.record.error;
  return { status: "failed", receipt: outcome.receipt, completion };
}

function succeededCreationOutcome<TResult>(
  outcome: Extract<
    CommandExecutionOutcome<CreateSessionCommand | ForkSessionCommand>,
    { status: "succeeded" }
  >,
  result: TResult,
): SessionCreationOutcome<TResult> {
  const completion: Extract<
    SessionCreationOutcome<TResult>,
    { status: "succeeded" }
  >["completion"] = { commandId: outcome.record.id };
  if (outcome.record.traceId !== undefined) completion.traceId = outcome.record.traceId;
  return { status: "succeeded", receipt: outcome.receipt, completion, result };
}

function convergenceExpectation(
  action: "create" | "fork",
  parsed: ParsedCreateOrForkSessionArgs,
  result: SessionCreateCommandResult | SessionForkCommandResult,
  harnessProvider: ProviderId,
  terminalProvider: ProviderId,
): SessionCreationConvergenceExpectation {
  return {
    action,
    branch: parsed.branch,
    harnessProvider,
    result,
    terminalProvider,
    title: parsed.title ?? parsed.branch,
  };
}

function mutationExecutionOptions(
  options: SessionCommandOptions,
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

function snapshotLoadOptions(
  options: SessionCommandOptions,
  timeoutMs: number,
): ObserverSnapshotLoadOptions {
  const loadOptions: ObserverSnapshotLoadOptions = { requireRunning: false, timeoutMs };
  if (options.config !== undefined) loadOptions.config = options.config;
  if (options.configPath !== undefined) loadOptions.configPath = options.configPath;
  return loadOptions;
}

function sessionOptionsWithTimeout(
  options: SessionCommandOptions,
  timeoutMs: number,
): SessionCommandOptions {
  return { ...options, timeoutMs };
}

function missingSessionCompletionError(receipt: AcceptedCommandReceipt): SafeError {
  return correlatedSessionError(
    "SESSION_COMMAND_COMPLETION_MISSING",
    "The session command returned before its durable completion was available.",
    receipt,
  );
}

function missingSessionResultError(
  action: "create" | "fork",
  receipt: AcceptedCommandReceipt,
): SafeError {
  return correlatedSessionError(
    `SESSION_${action.toUpperCase()}_RESULT_MISSING`,
    `The ${action} command succeeded without its required durable creation result.`,
    receipt,
  );
}

function correlatedSessionError(
  code: string,
  message: string,
  receipt: Pick<AcceptedCommandReceipt, "commandId" | "traceId">,
): SafeError {
  const error: SafeError = {
    tag: "SessionCliError",
    code,
    message,
    hint: `Inspect the durable record with \`stn command get ${receipt.commandId}\` before retrying.`,
    commandId: receipt.commandId,
  };
  if (receipt.traceId !== undefined) error.traceId = receipt.traceId;
  return error;
}

function sessionCliError(
  code: string,
  message: string,
  fields: Pick<SafeError, "projectId" | "provider" | "sessionId"> = {},
): SafeError {
  const error: SafeError = { tag: "SessionCliError", code, message };
  if (fields.projectId !== undefined) error.projectId = fields.projectId;
  if (fields.provider !== undefined) error.provider = fields.provider;
  if (fields.sessionId !== undefined) error.sessionId = fields.sessionId;
  return error;
}
