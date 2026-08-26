import type {
  AgentState,
  ProjectId,
  ProviderId,
  SessionId,
  StationCommand,
} from "@station/contracts";
import {
  AgentStateSchema,
  CloseSessionCommandSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  RenameSessionCommandSchema,
  SessionIdSchema,
  SessionOriginSchema,
} from "@station/contracts";
import { parsePositiveIntegerOption, parseRequiredOptionValue } from "../../args.js";
import type { SessionFilters } from "./summary.js";

export type RenameSessionCommand = Extract<StationCommand, { type: "session.rename" }>;
export type CloseSessionCommand = Extract<StationCommand, { type: "session.close" }>;
export type SessionOutputFormat = "json" | "text";

export type ParsedSessionArgs =
  | { action: "current"; outputFormat: "json" }
  | {
      action: "list";
      filters: SessionFilters;
      outputFormat: SessionOutputFormat;
      requireRunning: boolean;
    }
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
  if (action === "rename") return parseRenameArgs(args.slice(1));
  if (action === "close") return parseCloseArgs(args.slice(1));
  throw new Error(`Unknown session command: ${action}. Use: stn session --help.`);
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
