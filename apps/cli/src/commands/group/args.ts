import type { ProjectId, SessionGroupId, SessionId } from "@station/contracts";
import {
  ProjectIdSchema,
  SessionGroupIdSchema,
  SessionGroupNameSchema,
  SessionIdSchema,
} from "@station/contracts";
import type { ZodType } from "zod";
import { CliInputError, parsePositiveIntegerOption, parseRequiredOptionValue } from "../../args.js";
import type { GroupFilters } from "./summary.js";

export type GroupOutputFormat = "json" | "text";

export type ParsedGroupArgs =
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

export function parseGroupArgs(args: string[]): ParsedGroupArgs {
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
    } else if (option === "--json") {
      claimOption(seen, option, "group list");
      outputFormat = "json";
    } else {
      throw new Error(`Unknown group list option: ${option ?? ""}`);
    }
  }
  return { action: "list", filters, outputFormat };
}

function parseGetArgs(args: string[]): Extract<ParsedGroupArgs, { action: "get" }> {
  const groupId = parseGroupId(args[0], "group get");
  const seen = new Set<string>();
  let outputFormat: GroupOutputFormat = "text";
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option !== "--json") throw new Error(`Unknown group get option: ${option ?? ""}`);
    claimOption(seen, option, "group get");
    outputFormat = "json";
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
    } else if (option === "--timeout-ms") {
      claimOption(seen, option, "group create");
      timeoutMs = parsePositiveIntegerOption(args[index + 1], option);
      index += 1;
    } else if (option === "--json") {
      claimOption(seen, option, "group create");
      outputFormat = "json";
    } else {
      throw new Error(`Unknown group create option: ${option ?? ""}`);
    }
  }
  return optionalTimeout(
    { action: "create", projectId, name, sessionIds, outputFormat },
    timeoutMs,
  );
}

function parseRenameArgs(args: string[]): Extract<ParsedGroupArgs, { action: "rename" }> {
  const groupId = parseGroupId(args[0], "group rename");
  const name = parseGroupName(args[1], "group rename");
  const options = parseMutationOptions(args.slice(2), "group rename");
  return optionalTimeout(
    { action: "rename", groupId, name, outputFormat: options.outputFormat },
    options.timeoutMs,
  );
}

function parseMembersArgs(
  args: string[],
): Extract<ParsedGroupArgs, { action: "members.add" | "members.remove" }> {
  const subcommand = args[0];
  if (subcommand !== "add" && subcommand !== "remove") {
    throw new Error("group members requires the add or remove subcommand.");
  }
  const command = `group members ${subcommand}`;
  const groupId = parseGroupId(args[1], command);
  const sessionIds: SessionId[] = [];
  const seen = new Set<string>();
  let outputFormat: GroupOutputFormat = "text";
  let timeoutMs: number | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--timeout-ms") {
      claimOption(seen, option, command);
      timeoutMs = parsePositiveIntegerOption(args[index + 1], option);
      index += 1;
    } else if (option === "--json") {
      claimOption(seen, option, command);
      outputFormat = "json";
    } else {
      sessionIds.push(parseSessionId(option, command));
    }
  }
  if (sessionIds.length === 0) {
    throw new Error(`${command} requires at least one session id.`);
  }
  return optionalTimeout(
    {
      action: subcommand === "add" ? "members.add" : "members.remove",
      groupId,
      sessionIds,
      outputFormat,
    },
    timeoutMs,
  );
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
    } else if (option === "--root") {
      claimOption(seen, option, "group reparent");
      root = true;
    } else if (option === "--timeout-ms") {
      claimOption(seen, option, "group reparent");
      timeoutMs = parsePositiveIntegerOption(args[index + 1], option);
      index += 1;
    } else if (option === "--json") {
      claimOption(seen, option, "group reparent");
      outputFormat = "json";
    } else {
      throw new Error(`Unknown group reparent option: ${option ?? ""}`);
    }
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
  return optionalTimeout(
    { action: "delete", groupId, outputFormat: options.outputFormat },
    options.timeoutMs,
  );
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
    } else if (option === "--json") {
      claimOption(seen, option, command);
      outputFormat = "json";
    } else {
      throw new Error(`Unknown ${command} option: ${option ?? ""}`);
    }
  }
  return optionalTimeout({ outputFormat }, timeoutMs);
}

function parseProjectId(value: string | undefined, command: string): ProjectId {
  return parseId(ProjectIdSchema, value, command, "CLI_GROUP_PROJECT_ID_INVALID", "a project id");
}

function parseGroupId(value: string | undefined, command: string): SessionGroupId {
  return parseId(SessionGroupIdSchema, value, command, "CLI_GROUP_ID_INVALID", "an exact Group id");
}

function parseGroupName(value: string | undefined, command: string): string {
  if (value === undefined || value.startsWith("--")) {
    throw new CliInputError("CLI_GROUP_NAME_REQUIRED", `${command} requires a non-empty name.`);
  }
  const parsed = SessionGroupNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliInputError("CLI_GROUP_NAME_INVALID", `${command} requires a non-empty name.`);
  }
  return parsed.data;
}

function parseSessionId(value: string | undefined, command: string): SessionId {
  return parseId(
    SessionIdSchema,
    value,
    command,
    "CLI_GROUP_SESSION_ID_INVALID",
    "an exact session id",
  );
}

function parseId<T>(
  schema: ZodType<T>,
  value: string | undefined,
  command: string,
  code: string,
  requirement: string,
): T {
  const raw = parseRequiredOptionValue(value, command);
  const parsed = schema.safeParse(raw);
  if (raw.startsWith("--") || !parsed.success) {
    throw new CliInputError(code, `${command} requires ${requirement}.`);
  }
  return parsed.data;
}

function claimOption(seen: Set<string>, option: string, command: string): void {
  if (seen.has(option)) throw new Error(`Duplicate ${command} option: ${option}.`);
  seen.add(option);
}

function optionalTimeout<T extends object>(
  value: T,
  timeoutMs: number | undefined,
): T & {
  timeoutMs?: number;
} {
  if (timeoutMs === undefined) return value;
  return { ...value, timeoutMs };
}
