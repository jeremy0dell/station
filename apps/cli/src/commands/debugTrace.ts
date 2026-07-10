import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StationConfig } from "@station/config";
import type {
  CommandRecord,
  DiagnosticDetail,
  DiagnosticEvidenceIndex,
  ErrorEnvelope,
  LogRecord,
  SafeError,
} from "@station/contracts";
import {
  CommandIdSchema,
  CommandRecordSchema,
  DiagnosticEvidenceIndexSchema,
  ErrorEnvelopeSchema,
  LogRecordSchema,
  SafeErrorSchema,
  SpanIdSchema,
  TraceIdSchema,
} from "@station/contracts";
import { z } from "zod";
import { resolveObserverPaths } from "../paths.js";

export type DebugTraceCommandOptions = {
  config?: StationConfig;
};

export type DebugTraceResult = {
  query?: string;
  latestFailure: boolean;
  matched: boolean;
  matchedIdType?: "traceId" | "commandId" | "diagnosticId" | "unknown";
  source?: "bundle" | "log";
  bundlePath?: string;
  traceId?: string;
  spanId?: string;
  command?: {
    id: string;
    type?: string;
    status?: string;
    traceId?: string;
    spanId?: string;
  };
  error?: {
    id?: string;
    code?: string;
    message?: string;
    provider?: string;
    diagnosticId?: string;
    diagnostics?: DiagnosticDetail[];
  };
  rootCauseCodes: string[];
  evidence: {
    filesSearched: string[];
    matchedFiles: string[];
  };
  suggestedCommands: string[];
};

type DebugTraceCommandSummary = NonNullable<DebugTraceResult["command"]>;
type DebugTraceErrorSummary = NonNullable<DebugTraceResult["error"]>;

type DebugTraceArgs = {
  query?: string;
  latestFailure: boolean;
};

type DebugTraceMatch = {
  source: "bundle" | "log";
  matchedIdType: DebugTraceResult["matchedIdType"];
  bundlePath?: string;
  command?: DebugTraceResult["command"];
  error?: DebugTraceResult["error"];
  traceId?: string;
  spanId?: string;
  rootCauseCodes: string[];
  matchedFiles: string[];
  createdAt?: string;
};

type ParsedDebugTraceLogAttributes = {
  commandId?: string;
  traceId?: string;
  spanId?: string;
  commandType?: string;
  error?: DebugTraceErrorSummary;
};

const DebugTraceLogAttributesSchema = z
  .object({
    commandId: CommandIdSchema.optional(),
    traceId: TraceIdSchema.optional(),
    spanId: SpanIdSchema.optional(),
    commandType: z.string().min(1).optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

export async function runDebugTraceCommand(
  args: string[],
  options: DebugTraceCommandOptions = {},
): Promise<DebugTraceResult> {
  const parsed = parseDebugTraceArgs(args);
  const paths = resolveObserverPaths(options.config);
  const filesSearched: string[] = [];
  const bundleMatches = await searchBundles(paths.diagnosticsDir, parsed, filesSearched);
  const logMatches = await searchLogs(paths.logDir, parsed, filesSearched);
  const match = chooseMatch([...bundleMatches, ...logMatches], parsed);
  const result: DebugTraceResult = {
    latestFailure: parsed.latestFailure,
    matched: match !== undefined,
    rootCauseCodes: match?.rootCauseCodes ?? [],
    evidence: {
      filesSearched,
      matchedFiles: match?.matchedFiles ?? [],
    },
    suggestedCommands: suggestedCommands(parsed.query, match),
  };
  if (parsed.query !== undefined) result.query = parsed.query;
  if (match?.matchedIdType !== undefined) result.matchedIdType = match.matchedIdType;
  if (match?.source !== undefined) result.source = match.source;
  if (match?.bundlePath !== undefined) result.bundlePath = match.bundlePath;
  if (match?.traceId !== undefined) result.traceId = match.traceId;
  if (match?.spanId !== undefined) result.spanId = match.spanId;
  if (match?.command !== undefined) result.command = match.command;
  if (match?.error !== undefined) result.error = match.error;
  return result;
}

function parseDebugTraceArgs(args: string[]): DebugTraceArgs {
  let query: string | undefined;
  let latestFailure = args.length === 0;
  for (const arg of args) {
    if (arg === "--json") {
      continue;
    }
    if (arg === "--latest-failure") {
      latestFailure = true;
      continue;
    }
    if (query === undefined) {
      query = arg;
      continue;
    }
    throw new Error(`Unknown debug trace option: ${arg}`);
  }
  return {
    latestFailure,
    ...(query === undefined ? {} : { query }),
  };
}

async function searchBundles(
  diagnosticsDir: string,
  args: DebugTraceArgs,
  filesSearched: string[],
): Promise<DebugTraceMatch[]> {
  const bundleDirs = await listBundleDirs(diagnosticsDir);
  const matches: DebugTraceMatch[] = [];
  for (const bundlePath of bundleDirs) {
    const indexPath = join(bundlePath, "diagnostic-index.json");
    const commandsPath = join(bundlePath, "commands.jsonl");
    const errorsPath = join(bundlePath, "errors.jsonl");
    const logsPath = join(bundlePath, "logs", "observer.jsonl");
    filesSearched.push(indexPath, commandsPath, errorsPath, logsPath);

    const index = await readJson(indexPath, DiagnosticEvidenceIndexSchema);
    const commands = await readJsonl(commandsPath, CommandRecordSchema);
    const errors = await readJsonl(errorsPath, ErrorEnvelopeSchema);
    const logs = await readJsonl(logsPath, LogRecordSchema);
    const match = matchBundle({
      args,
      bundlePath,
      index,
      commands,
      errors,
      logs,
      paths: { indexPath, commandsPath, errorsPath, logsPath },
    });
    if (match !== undefined) {
      matches.push(match);
    }
  }
  return matches;
}

async function searchLogs(
  logDir: string,
  args: DebugTraceArgs,
  filesSearched: string[],
): Promise<DebugTraceMatch[]> {
  const paths = ["observer.jsonl", "hooks.jsonl", "cli.jsonl", "tui.jsonl"].map((name) =>
    join(logDir, name),
  );
  const matches: DebugTraceMatch[] = [];
  for (const path of paths) {
    filesSearched.push(path);
    const logs = await readJsonl(path, LogRecordSchema);
    const log = args.latestFailure
      ? [...logs].reverse().find(isFailedCommandLog)
      : logs.find((record) => args.query !== undefined && recordContains(record, args.query));
    if (log === undefined) {
      continue;
    }
    matches.push(matchFromLog(log, path, args.query));
  }
  return matches;
}

function matchBundle(input: {
  args: DebugTraceArgs;
  bundlePath: string;
  index: DiagnosticEvidenceIndex | undefined;
  commands: readonly CommandRecord[];
  errors: readonly ErrorEnvelope[];
  logs: readonly LogRecord[];
  paths: {
    indexPath: string;
    commandsPath: string;
    errorsPath: string;
    logsPath: string;
  };
}): DebugTraceMatch | undefined {
  const command = input.args.latestFailure
    ? latestFailedCommand(input.commands)
    : input.commands.find(
        (candidate) =>
          input.args.query !== undefined && commandMatchesQuery(candidate, input.args.query),
      );
  const error = input.args.latestFailure
    ? latestErrorForCommand(input.errors, command)
    : input.errors.find(
        (candidate) =>
          input.args.query !== undefined && errorMatchesQuery(candidate, input.args.query),
      );
  const indexMatched =
    input.index !== undefined &&
    input.args.query !== undefined &&
    recordContains(input.index, input.args.query);
  const logMatched =
    input.args.query !== undefined &&
    input.logs.some((log) => recordContains(log, input.args.query ?? ""));

  if (command === undefined && error === undefined && !indexMatched && !logMatched) {
    return undefined;
  }

  const matchedFiles: string[] = [];
  if (command !== undefined) matchedFiles.push(input.paths.commandsPath);
  if (error !== undefined) matchedFiles.push(input.paths.errorsPath);
  if (indexMatched) matchedFiles.push(input.paths.indexPath);
  if (logMatched) matchedFiles.push(input.paths.logsPath);

  const match: DebugTraceMatch = {
    source: "bundle",
    matchedIdType: matchedIdType(input.args.query, command, error),
    bundlePath: input.bundlePath,
    rootCauseCodes: rootCauseCodes(input.index, command, error),
    matchedFiles,
  };
  const commandResult = commandSummary(command);
  if (commandResult !== undefined) match.command = commandResult;
  const errorResult = traceErrorSummary(error, command);
  if (errorResult !== undefined) match.error = errorResult;
  const createdAt = command?.finishedAt ?? command?.createdAt ?? error?.createdAt;
  if (createdAt !== undefined) match.createdAt = createdAt;
  return match;
}

function chooseMatch(
  matches: readonly DebugTraceMatch[],
  args: DebugTraceArgs,
): DebugTraceMatch | undefined {
  if (!args.latestFailure) {
    return matches[0];
  }
  return [...matches].sort((left, right) => timestamp(right) - timestamp(left))[0];
}

async function listBundleDirs(diagnosticsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(diagnosticsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(diagnosticsDir, entry.name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

async function readJson<T>(
  path: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    const result = schema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

async function readJsonl<T>(
  path: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T[]> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const records: T[] = [];
  for (const line of source.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const result = schema.safeParse(JSON.parse(line));
      if (result.success) {
        records.push(result.data);
      }
    } catch {}
  }
  return records;
}

function latestFailedCommand(commands: readonly CommandRecord[]): CommandRecord | undefined {
  return [...commands].reverse().find((command) => command.status === "failed");
}

function latestErrorForCommand(
  errors: readonly ErrorEnvelope[],
  command: CommandRecord | undefined,
): ErrorEnvelope | undefined {
  if (command === undefined) {
    return [...errors].reverse()[0];
  }
  return [...errors].reverse().find((error) => error.commandId === command.id);
}

function commandMatchesQuery(command: CommandRecord, query: string): boolean {
  return command.id === query || command.traceId === query || recordContains(command, query);
}

function errorMatchesQuery(error: ErrorEnvelope, query: string): boolean {
  return (
    error.id === query ||
    error.commandId === query ||
    error.traceId === query ||
    recordContains(error, query)
  );
}

function matchFromLog(log: LogRecord, path: string, query: string | undefined): DebugTraceMatch {
  const attributes = parseDebugTraceLogAttributes(log.attributes);
  const commandId = attributes.commandId ?? log.commandId;
  const traceId = attributes.traceId ?? log.traceId;
  const spanId = attributes.spanId ?? log.spanId;
  const commandType = attributes.commandType;
  const command =
    commandId === undefined
      ? undefined
      : {
          id: commandId,
          ...(commandType === undefined ? {} : { type: commandType }),
          status: "failed",
          ...(traceId === undefined ? {} : { traceId }),
          ...(spanId === undefined ? {} : { spanId }),
        };
  const errorResult = attributes.error;
  const match: DebugTraceMatch = {
    source: "log",
    matchedIdType: matchedIdType(query, undefined, undefined),
    ...(command === undefined ? {} : { command }),
    ...(traceId === undefined ? {} : { traceId }),
    ...(spanId === undefined ? {} : { spanId }),
    rootCauseCodes: errorResult?.code === undefined ? [] : [errorResult.code],
    matchedFiles: [path],
    createdAt: log.timestamp,
  };
  if (errorResult !== undefined) match.error = errorResult;
  return match;
}

function isFailedCommandLog(log: LogRecord): boolean {
  const attributes = parseDebugTraceLogAttributes(log.attributes);
  return (
    log.level === "error" &&
    (log.message.toLowerCase().includes("command failed") || attributes.error !== undefined)
  );
}

function matchedIdType(
  query: string | undefined,
  command: CommandRecord | undefined,
  error: ErrorEnvelope | undefined,
): DebugTraceResult["matchedIdType"] {
  if (query === undefined) {
    return "unknown";
  }
  if (query.startsWith("trc_") || command?.traceId === query || error?.traceId === query) {
    return "traceId";
  }
  if (query.startsWith("cmd_") || command?.id === query || error?.commandId === query) {
    return "commandId";
  }
  if (query.startsWith("diag_") || query.startsWith("err_") || error?.id === query) {
    return "diagnosticId";
  }
  return "unknown";
}

function commandSummary(command: CommandRecord | undefined): DebugTraceResult["command"] {
  if (command === undefined) {
    return undefined;
  }
  const summary: DebugTraceCommandSummary = {
    id: command.id,
    type: command.type,
    status: command.status,
  };
  if (command.traceId !== undefined) summary.traceId = command.traceId;
  if (command.spanId !== undefined) summary.spanId = command.spanId;
  return summary;
}

function errorSummary(error: ErrorEnvelope | undefined): DebugTraceResult["error"] {
  if (error === undefined) {
    return undefined;
  }
  const summary: DebugTraceErrorSummary = {
    id: error.id,
    code: error.code,
    message: error.message,
  };
  if (error.provider !== undefined) summary.provider = error.provider;
  if (error.diagnostics !== undefined) summary.diagnostics = error.diagnostics;
  return summary;
}

function traceErrorSummary(
  error: ErrorEnvelope | undefined,
  command: CommandRecord | undefined,
): DebugTraceResult["error"] {
  const summary = errorSummary(error) ?? commandErrorSummary(command);
  if (summary === undefined) {
    return undefined;
  }
  if (summary.diagnostics === undefined && command?.diagnostics !== undefined) {
    summary.diagnostics = command.diagnostics;
  }
  return summary;
}

function commandErrorSummary(command: CommandRecord | undefined): DebugTraceResult["error"] {
  if (command?.error === undefined && command?.diagnostics === undefined) {
    return undefined;
  }
  const summary: DebugTraceErrorSummary = {};
  if (command.error !== undefined) {
    summary.code = command.error.code;
    summary.message = command.error.message;
    if (command.error.provider !== undefined) summary.provider = command.error.provider;
    if (command.error.diagnosticId !== undefined) summary.diagnosticId = command.error.diagnosticId;
  }
  if (command.diagnostics !== undefined) summary.diagnostics = command.diagnostics;
  return Object.keys(summary).length === 0 ? undefined : summary;
}

function rootCauseCodes(
  index: DiagnosticEvidenceIndex | undefined,
  command: CommandRecord | undefined,
  error: ErrorEnvelope | undefined,
): string[] {
  const codes = new Set<string>(index?.summary.rootCauseCodes ?? []);
  if (command?.error?.code !== undefined) codes.add(command.error.code);
  if (error?.code !== undefined) codes.add(error.code);
  return [...codes].sort();
}

function safeErrorSummary(error: SafeError): DebugTraceResult["error"] {
  const summary: DebugTraceErrorSummary = {
    code: error.code,
    message: error.message,
  };
  if (error.provider !== undefined) summary.provider = error.provider;
  if (error.diagnosticId !== undefined) summary.diagnosticId = error.diagnosticId;
  return summary;
}

function parseDebugTraceLogAttributes(
  attributes: LogRecord["attributes"] | undefined,
): ParsedDebugTraceLogAttributes {
  const parsed = DebugTraceLogAttributesSchema.safeParse(attributes ?? {});
  if (!parsed.success) {
    return {};
  }
  const result: ParsedDebugTraceLogAttributes = {};
  if (parsed.data.commandId !== undefined) result.commandId = parsed.data.commandId;
  if (parsed.data.traceId !== undefined) result.traceId = parsed.data.traceId;
  if (parsed.data.spanId !== undefined) result.spanId = parsed.data.spanId;
  if (parsed.data.commandType !== undefined) result.commandType = parsed.data.commandType;
  const error = parseLogAttributeError(parsed.data.error);
  if (error !== undefined) result.error = error;
  return result;
}

function parseLogAttributeError(error: unknown): DebugTraceResult["error"] {
  const safeError = SafeErrorSchema.safeParse(error);
  if (safeError.success) {
    return safeErrorSummary(safeError.data);
  }
  const envelope = ErrorEnvelopeSchema.safeParse(error);
  if (envelope.success) {
    return errorSummary(envelope.data);
  }
  return undefined;
}

function suggestedCommands(
  query: string | undefined,
  match: DebugTraceMatch | undefined,
): string[] {
  const traceId =
    match?.command?.traceId ??
    match?.traceId ??
    (query?.startsWith("trc_") === true ? query : undefined);
  const commandId = match?.command?.id ?? (query?.startsWith("cmd_") === true ? query : undefined);
  const commands = ["stn doctor"];
  if (traceId !== undefined) {
    commands.push(`stn debug bundle --trace ${traceId}`);
  }
  if (commandId !== undefined) {
    commands.push(`stn debug bundle --command ${commandId}`);
  }
  if (traceId === undefined && commandId === undefined) {
    commands.push("stn debug bundle --latest-failure");
  }
  return commands;
}

function timestamp(match: DebugTraceMatch): number {
  return match.createdAt === undefined ? 0 : Date.parse(match.createdAt);
}

function recordContains(value: unknown, query: string): boolean {
  return JSON.stringify(value).includes(query);
}
