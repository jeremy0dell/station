import type {
  AgentState,
  ProjectId,
  ProviderId,
  SessionGroupId,
  SessionId,
  StationCommand,
} from "@station/contracts";
import {
  AgentStateSchema,
  CloseSessionCommandSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  RenameSessionCommandSchema,
  SessionGroupIdSchema,
  SessionGroupNameSchema,
  SessionIdSchema,
  SessionOriginSchema,
  SessionTerminalCommandOptionsSchema,
  userFacingTitleSchema,
} from "@station/contracts";
import { CliInputError, parsePositiveIntegerOption, parseRequiredOptionValue } from "../../args.js";
import type { SessionFilters } from "./summary.js";

export type RenameSessionCommand = Extract<StationCommand, { type: "session.rename" }>;
export type CloseSessionCommand = Extract<StationCommand, { type: "session.close" }>;
export type SessionOutputFormat = "json" | "text";

export type SessionPlacementOption =
  | { kind: "from-current" }
  | { kind: "terminal"; provider: "tmux" };

export type CreateSessionGroupOption =
  | { kind: "ungrouped" }
  | { kind: "existing"; groupId: SessionGroupId }
  | { kind: "create"; name: string };

export type ForkSessionGroupOption = "default" | "inherit" | "ungrouped";

type SessionCreationArgs = {
  branch: string;
  outputFormat: SessionOutputFormat;
  placement: SessionPlacementOption;
  promptStdin: boolean;
  base?: string;
  harness?: ProviderId;
  layout?: "default" | "agent-only" | "agent-build-shell";
  timeoutMs?: number;
  title?: string;
};

export type ParsedCreateSessionArgs = SessionCreationArgs & {
  action: "create";
  group: CreateSessionGroupOption;
  projectId: ProjectId;
};

export type ParsedForkSessionArgs = SessionCreationArgs & {
  action: "fork";
  copyDirty?: boolean;
  group: ForkSessionGroupOption;
  sourceSessionId: SessionId;
};

export type ParsedCreateOrForkSessionArgs = ParsedCreateSessionArgs | ParsedForkSessionArgs;

export type ParsedSessionArgs =
  | { action: "current"; outputFormat: "json" }
  | {
      action: "list";
      filters: SessionFilters;
      outputFormat: SessionOutputFormat;
      requireRunning: boolean;
    }
  | ParsedCreateSessionArgs
  | ParsedForkSessionArgs
  | {
      action: "get";
      outputFormat: SessionOutputFormat;
      sessionId: SessionId;
      requireRunning: boolean;
    }
  | {
      action: "rename";
      command: RenameSessionCommand;
      outputFormat: SessionOutputFormat;
      timeoutMs?: number;
    }
  | {
      action: "close";
      command: CloseSessionCommand;
      outputFormat: SessionOutputFormat;
      timeoutMs?: number;
    };

export function parseSessionArgs(args: string[]): ParsedSessionArgs {
  const action = args[0];
  if (action === undefined) {
    throw new Error("Session command requires a subcommand. Use: stn session --help.");
  }
  if (action === "current") return parseCurrentArgs(args.slice(1));
  if (action === "list") return parseListArgs(args.slice(1));
  if (action === "get") return parseGetArgs(args.slice(1));
  if (action === "create") return parseCreateArgs(args.slice(1));
  if (action === "fork") return parseForkArgs(args.slice(1));
  if (action === "rename") return parseRenameArgs(args.slice(1));
  if (action === "close") return parseCloseArgs(args.slice(1));
  throw new Error(`Unknown session command: ${action}. Use: stn session --help.`);
}

function parseCreateArgs(args: string[]): ParsedCreateSessionArgs {
  const projectId = parseProjectId(args[0], "session create");
  const common = parseCreationOptions(args.slice(1), "create");
  const groupOptions = common.groupOptions;
  let group: CreateSessionGroupOption = { kind: "ungrouped" };
  if (groupOptions.existing !== undefined) {
    group = { kind: "existing", groupId: groupOptions.existing };
  } else if (groupOptions.create !== undefined) {
    group = { kind: "create", name: groupOptions.create };
  }
  return {
    action: "create",
    projectId,
    group,
    ...common.values,
  };
}

function parseForkArgs(args: string[]): ParsedForkSessionArgs {
  const sourceSessionId = parseSessionId(args[0], "session fork");
  const common = parseCreationOptions(args.slice(1), "fork");
  const { inherit, ungrouped } = common.groupOptions;
  const group: ForkSessionGroupOption = ungrouped ? "ungrouped" : inherit ? "inherit" : "default";
  const parsed: ParsedForkSessionArgs = {
    action: "fork",
    sourceSessionId,
    group,
    ...common.values,
  };
  if (common.copyDirty !== undefined) parsed.copyDirty = common.copyDirty;
  return parsed;
}

type ParsedCreationOptions = {
  values: SessionCreationArgs;
  groupOptions: {
    create?: string;
    existing?: SessionGroupId;
    inherit: boolean;
    ungrouped: boolean;
  };
  copyDirty?: boolean;
};

function parseCreationOptions(args: string[], action: "create" | "fork"): ParsedCreationOptions {
  const command = `session ${action}`;
  const seen = new Set<string>();
  const groupOptions: ParsedCreationOptions["groupOptions"] = {
    inherit: false,
    ungrouped: false,
  };
  let branch: string | undefined;
  let outputFormat: SessionOutputFormat = "text";
  let placement: SessionPlacementOption | undefined;
  let promptStdin = false;
  let base: string | undefined;
  let harness: ProviderId | undefined;
  let layout: SessionCreationArgs["layout"];
  let timeoutMs: number | undefined;
  let title: string | undefined;
  let copyDirty: boolean | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--branch") {
      claimOption(seen, option, command);
      branch = parseSessionOptionValue(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--from-current") {
      claimOption(seen, option, command);
      if (placement !== undefined) throw creationInputError(action, "Placement options conflict.");
      placement = { kind: "from-current" };
      continue;
    }
    if (option === "--terminal") {
      claimOption(seen, option, command);
      if (placement !== undefined) throw creationInputError(action, "Placement options conflict.");
      const provider = parseSessionOptionValue(args[index + 1], option);
      if (provider !== "tmux") {
        throw creationInputError(action, "--terminal must be tmux for session create or fork.");
      }
      placement = { kind: "terminal", provider };
      index += 1;
      continue;
    }
    if (option === "--title") {
      claimOption(seen, option, command);
      title = parseSessionTitle(args[index + 1], action);
      index += 1;
      continue;
    }
    if (option === "--base") {
      claimOption(seen, option, command);
      base = parseSessionOptionValue(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--harness") {
      claimOption(seen, option, command);
      harness = parseProviderId(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--layout") {
      claimOption(seen, option, command);
      layout = parseSessionLayout(args[index + 1], action);
      index += 1;
      continue;
    }
    if (option === "--prompt-stdin") {
      claimOption(seen, option, command);
      promptStdin = true;
      continue;
    }
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
    if (option === "--group") {
      ensureCreateOption(action, option);
      claimOption(seen, option, command);
      groupOptions.existing = parseSessionGroupId(args[index + 1], option, action);
      index += 1;
      continue;
    }
    if (option === "--new-group") {
      ensureCreateOption(action, option);
      claimOption(seen, option, command);
      groupOptions.create = parseSessionGroupName(args[index + 1], option, action);
      index += 1;
      continue;
    }
    if (option === "--inherit-group") {
      ensureForkOption(action, option);
      claimOption(seen, option, command);
      groupOptions.inherit = true;
      continue;
    }
    if (option === "--ungrouped") {
      claimOption(seen, option, command);
      groupOptions.ungrouped = true;
      continue;
    }
    if (option === "--copy-dirty" || option === "--no-copy-dirty") {
      ensureForkOption(action, option);
      claimOption(seen, option, command);
      if (copyDirty !== undefined) {
        throw creationInputError(action, "Copy-dirty options conflict.");
      }
      copyDirty = option === "--copy-dirty";
      continue;
    }
    throw creationInputError(action, `Unknown ${command} option: ${option ?? ""}`);
  }

  if (branch === undefined) throw creationInputError(action, `${command} requires --branch.`);
  if (placement === undefined) {
    throw creationInputError(action, `${command} requires --from-current or --terminal tmux.`);
  }
  const groupSelectionCount = [
    groupOptions.existing !== undefined,
    groupOptions.create !== undefined,
    groupOptions.inherit,
    groupOptions.ungrouped,
  ].filter(Boolean).length;
  if (groupSelectionCount > 1) throw creationInputError(action, "Group options conflict.");

  const values: SessionCreationArgs = {
    branch,
    outputFormat,
    placement,
    promptStdin,
  };
  if (base !== undefined) values.base = base;
  if (harness !== undefined) values.harness = harness;
  if (layout !== undefined) values.layout = layout;
  if (timeoutMs !== undefined) values.timeoutMs = timeoutMs;
  if (title !== undefined) values.title = title;
  const parsed: ParsedCreationOptions = { values, groupOptions };
  if (copyDirty !== undefined) parsed.copyDirty = copyDirty;
  return parsed;
}

function parseCurrentArgs(args: string[]): Extract<ParsedSessionArgs, { action: "current" }> {
  const unexpected = args[0];
  if (unexpected !== undefined) {
    throw new Error(
      `Unexpected argument for stn session current: ${unexpected}. Use: stn session current --help.`,
    );
  }
  return { action: "current", outputFormat: "json" };
}

function parseListArgs(args: string[]): Extract<ParsedSessionArgs, { action: "list" }> {
  const filters: SessionFilters = {};
  const seen = new Set<string>();
  let outputFormat: SessionOutputFormat = "text";
  let requireRunning = false;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--json") {
      claimOption(seen, option, "session list");
      outputFormat = "json";
      continue;
    }
    if (option === "--require-running") {
      claimOption(seen, option, "session list");
      requireRunning = true;
      continue;
    }
    if (option === "--project") {
      claimOption(seen, option, "session list");
      filters.project = parseProjectId(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--provider") {
      claimOption(seen, option, "session list");
      filters.provider = parseProviderId(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--status") {
      claimOption(seen, option, "session list");
      filters.status = parseAgentState(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--origin") {
      claimOption(seen, option, "session list");
      filters.origin = parseSessionOrigin(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--query") {
      claimOption(seen, option, "session list");
      filters.query = parseSessionOptionValue(args[index + 1], option);
      index += 1;
      continue;
    }
    throw new Error(`Unknown session list option: ${option ?? ""}`);
  }
  return { action: "list", filters, outputFormat, requireRunning };
}

function parseGetArgs(args: string[]): Extract<ParsedSessionArgs, { action: "get" }> {
  const sessionId = parseSessionId(args[0], "session get");
  const seen = new Set<string>();
  let outputFormat: SessionOutputFormat = "text";
  let requireRunning = false;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--json") {
      claimOption(seen, option, "session get");
      outputFormat = "json";
      continue;
    }
    if (option === "--require-running") {
      claimOption(seen, option, "session get");
      requireRunning = true;
      continue;
    }
    throw new Error(`Unknown session get option: ${option ?? ""}`);
  }
  return { action: "get", outputFormat, sessionId, requireRunning };
}

function parseRenameArgs(args: string[]): Extract<ParsedSessionArgs, { action: "rename" }> {
  const sessionId = parseSessionId(args[0], "session rename");
  const title = args[1];
  if (title === undefined || title.startsWith("--")) {
    throw new Error("session rename requires a non-empty title.");
  }
  const seen = new Set<string>();
  let outputFormat: SessionOutputFormat = "text";
  let timeoutMs: number | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--json") {
      claimOption(seen, option, "session rename");
      outputFormat = "json";
      continue;
    }
    if (option === "--timeout-ms") {
      claimOption(seen, option, "session rename");
      timeoutMs = parsePositiveIntegerOption(args[index + 1], option);
      index += 1;
      continue;
    }
    throw new Error(`Unknown session rename option: ${option ?? ""}`);
  }
  const command = RenameSessionCommandSchema.parse({
    type: "session.rename",
    payload: { sessionId, title },
  });
  const parsed: Extract<ParsedSessionArgs, { action: "rename" }> = {
    action: "rename",
    command,
    outputFormat,
  };
  if (timeoutMs !== undefined) parsed.timeoutMs = timeoutMs;
  return parsed;
}

function parseCloseArgs(args: string[]): Extract<ParsedSessionArgs, { action: "close" }> {
  const sessionId = parseSessionId(args[0], "session close");
  const seen = new Set<string>();
  let outputFormat: SessionOutputFormat = "text";
  let mode: "harness" | "terminal" | "all" | undefined;
  let force = false;
  let timeoutMs: number | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--json") {
      claimOption(seen, option, "session close");
      outputFormat = "json";
      continue;
    }
    if (option === "--mode") {
      claimOption(seen, option, "session close");
      mode = parseCloseMode(args[index + 1]);
      index += 1;
      continue;
    }
    if (option === "--force") {
      claimOption(seen, option, "session close");
      force = true;
      continue;
    }
    if (option === "--timeout-ms") {
      claimOption(seen, option, "session close");
      timeoutMs = parsePositiveIntegerOption(args[index + 1], option);
      index += 1;
      continue;
    }
    throw new Error(`Unknown session close option: ${option ?? ""}`);
  }
  if (mode === undefined) {
    throw new Error("session close requires --mode <harness|terminal|all>.");
  }
  const payload: { sessionId: SessionId; mode: typeof mode; force?: true } = { sessionId, mode };
  if (force) payload.force = true;
  const command = CloseSessionCommandSchema.parse({ type: "session.close", payload });
  const parsed: Extract<ParsedSessionArgs, { action: "close" }> = {
    action: "close",
    command,
    outputFormat,
  };
  if (timeoutMs !== undefined) parsed.timeoutMs = timeoutMs;
  return parsed;
}

function parseSessionId(value: string | undefined, command: string): SessionId {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${command} requires an exact session id.`);
  }
  const parsed = SessionIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid session id: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parseProjectId(value: string | undefined, option: string): ProjectId {
  const parsed = ProjectIdSchema.safeParse(parseSessionOptionValue(value, option));
  if (!parsed.success) throw new Error(`${option} requires a non-empty project id.`);
  return parsed.data;
}

function parseProviderId(value: string | undefined, option: string): ProviderId {
  const parsed = ProviderIdSchema.safeParse(parseSessionOptionValue(value, option));
  if (!parsed.success) throw new Error(`${option} requires a non-empty provider id.`);
  return parsed.data;
}

function parseSessionGroupId(
  value: string | undefined,
  option: string,
  action: "create" | "fork",
): SessionGroupId {
  const parsed = SessionGroupIdSchema.safeParse(parseSessionOptionValue(value, option));
  if (!parsed.success) throw creationInputError(action, `${option} requires an exact Group id.`);
  return parsed.data;
}

function parseSessionGroupName(
  value: string | undefined,
  option: string,
  action: "create" | "fork",
): string {
  const parsed = SessionGroupNameSchema.safeParse(parseSessionOptionValue(value, option));
  if (!parsed.success) throw creationInputError(action, `${option} requires a non-empty name.`);
  return parsed.data;
}

function parseSessionTitle(value: string | undefined, action: "create" | "fork"): string {
  const parsed = userFacingTitleSchema.safeParse(parseSessionOptionValue(value, "--title"));
  if (!parsed.success) throw creationInputError(action, "--title requires a non-empty title.");
  return parsed.data;
}

function parseSessionLayout(
  value: string | undefined,
  action: "create" | "fork",
): "default" | "agent-only" | "agent-build-shell" {
  const parsed = SessionTerminalCommandOptionsSchema.shape.layout.safeParse(
    parseSessionOptionValue(value, "--layout"),
  );
  if (!parsed.success || parsed.data === undefined) {
    throw creationInputError(action, "--layout must be default, agent-only, or agent-build-shell.");
  }
  return parsed.data;
}

function parseAgentState(value: string | undefined, option: string): AgentState {
  const parsed = AgentStateSchema.safeParse(parseSessionOptionValue(value, option));
  if (!parsed.success) {
    throw new Error(`${option} must be a current session status.`);
  }
  return parsed.data;
}

function parseSessionOrigin(value: string | undefined, option: string): "station" | "external" {
  const parsed = SessionOriginSchema.safeParse(parseSessionOptionValue(value, option));
  if (!parsed.success) throw new Error(`${option} must be station or external.`);
  return parsed.data;
}

function parseCloseMode(value: string | undefined): "harness" | "terminal" | "all" {
  const parsed = CloseSessionCommandSchema.shape.payload.shape.mode.safeParse(
    parseSessionOptionValue(value, "--mode"),
  );
  if (!parsed.success) throw new Error("--mode must be harness, terminal, or all.");
  return parsed.data;
}

function parseSessionOptionValue(value: string | undefined, option: string): string {
  const parsed = parseRequiredOptionValue(value, option);
  if (parsed.startsWith("--")) throw new Error(`${option} requires a value.`);
  return parsed;
}

function claimOption(seen: Set<string>, option: string, command: string): void {
  if (seen.has(option)) {
    throw new Error(`Duplicate ${command} option: ${option}.`);
  }
  seen.add(option);
}

function ensureCreateOption(action: "create" | "fork", option: string): void {
  if (action !== "create") throw creationInputError(action, `${option} is create-only.`);
}

function ensureForkOption(action: "create" | "fork", option: string): void {
  if (action !== "fork") throw creationInputError(action, `${option} is fork-only.`);
}

function creationInputError(action: "create" | "fork", message: string): CliInputError {
  return new CliInputError(`CLI_SESSION_${action.toUpperCase()}_INPUT_INVALID`, message);
}
