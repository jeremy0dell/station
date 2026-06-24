import { readFile } from "node:fs/promises";
import type { StationConfig } from "@station/config";
import type { LogRecord, SafeError } from "@station/contracts";
import { LogRecordSchema, SafeErrorSchema } from "@station/contracts";
import { componentLogPath } from "@station/observability";
import { resolveObserverPaths } from "../paths.js";

export type DebugLogsCommandOptions = {
  config?: StationConfig;
};

export type DebugLogsResult = {
  query?: string;
  components: DebugLogComponent[];
  minLevel: DebugLogLevel;
  since?: string;
  limit: number;
  matched: number;
  evidence: {
    filesSearched: string[];
    matchedFiles: string[];
  };
  records: DebugLogRecordSummary[];
};

type DebugLogRecordSummary = {
  timestamp: string;
  level: DebugLogLevel;
  component: DebugLogComponent;
  message: string;
  traceId?: string;
  spanId?: string;
  commandId?: string;
  projectId?: string;
  worktreeId?: string;
  sessionId?: string;
  provider?: string;
  error?: DebugLogErrorSummary;
};

type DebugLogErrorSummary = {
  code?: string;
  message?: string;
  provider?: string;
  diagnosticId?: string;
  traceId?: string;
  commandId?: string;
};

type DebugLogsArgs = {
  query?: string;
  components: DebugLogComponent[];
  minLevel: DebugLogLevel;
  since?: string;
  limit: number;
};

type DebugLogComponent = "observer" | "cli" | "tui" | "hook" | "provider" | "station-host";
type DebugLogLevel = "debug" | "info" | "warn" | "error";

type DebugLogFileMatch = {
  path: string;
  records: LogRecord[];
};

const defaultComponents: DebugLogComponent[] = ["observer", "cli", "tui"];
const allComponents: DebugLogComponent[] = [
  "observer",
  "cli",
  "tui",
  "hook",
  "provider",
  "station-host",
];
const logLevels: DebugLogLevel[] = ["debug", "info", "warn", "error"];

export async function runDebugLogsCommand(
  args: string[],
  options: DebugLogsCommandOptions = {},
): Promise<DebugLogsResult> {
  const parsed = parseDebugLogsArgs(args);
  const paths = resolveObserverPaths(options.config);
  const filesSearched: string[] = [];
  const matches: DebugLogFileMatch[] = [];

  for (const component of parsed.components) {
    const path = componentLogPath(paths.stateDir, component);
    filesSearched.push(path);
    const records = (await readJsonl(path, LogRecordSchema)).filter((record) =>
      logMatches(record, parsed),
    );
    if (records.length > 0) {
      matches.push({ path, records });
    }
  }

  const selected = matches
    .flatMap((match) => match.records)
    .sort((left, right) => timestamp(left) - timestamp(right))
    .slice(-parsed.limit);
  const result: DebugLogsResult = {
    components: parsed.components,
    minLevel: parsed.minLevel,
    limit: parsed.limit,
    matched: selected.length,
    evidence: {
      filesSearched,
      matchedFiles: matches.map((match) => match.path),
    },
    records: selected.map(logSummary),
  };
  if (parsed.query !== undefined) result.query = parsed.query;
  if (parsed.since !== undefined) result.since = parsed.since;
  return result;
}

function parseDebugLogsArgs(args: string[]): DebugLogsArgs {
  let query: string | undefined;
  const components: DebugLogComponent[] = [];
  let minLevel: DebugLogLevel | undefined;
  let since: string | undefined;
  let limit = 50;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      continue;
    }
    if (arg === "--component") {
      components.push(parseComponent(requiredValue(args[index + 1], "--component")));
      index += 1;
      continue;
    }
    if (arg === "--all-components") {
      for (const component of allComponents) {
        if (!components.includes(component)) {
          components.push(component);
        }
      }
      continue;
    }
    if (arg === "--min-level") {
      minLevel = parseLevel(requiredValue(args[index + 1], "--min-level"));
      index += 1;
      continue;
    }
    if (arg === "--since") {
      since = parseSince(requiredValue(args[index + 1], "--since"));
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      limit = parseLimit(requiredValue(args[index + 1], "--limit"));
      index += 1;
      continue;
    }
    if (arg?.startsWith("--")) {
      throw new Error(`Unknown debug logs option: ${arg}`);
    }
    if (query === undefined && arg !== undefined) {
      query = arg;
      continue;
    }
    throw new Error(`Unknown debug logs argument: ${arg ?? ""}`);
  }

  return {
    ...(query === undefined ? {} : { query }),
    components: components.length === 0 ? defaultComponents : components,
    minLevel: minLevel ?? (query === undefined ? "warn" : "debug"),
    ...(since === undefined ? {} : { since }),
    limit,
  };
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
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) {
        records.push(parsed.data);
      }
    } catch {}
  }
  return records;
}

function logMatches(record: LogRecord, args: DebugLogsArgs): boolean {
  return (
    args.components.includes(record.component) &&
    levelRank(record.level) >= levelRank(args.minLevel) &&
    (args.since === undefined || record.timestamp >= args.since) &&
    (args.query === undefined || recordContains(record, args.query))
  );
}

function logSummary(record: LogRecord): DebugLogRecordSummary {
  const summary: DebugLogRecordSummary = {
    timestamp: record.timestamp,
    level: record.level,
    component: record.component,
    message: record.message,
  };
  if (record.traceId !== undefined) summary.traceId = record.traceId;
  if (record.spanId !== undefined) summary.spanId = record.spanId;
  if (record.commandId !== undefined) summary.commandId = record.commandId;
  if (record.projectId !== undefined) summary.projectId = record.projectId;
  if (record.worktreeId !== undefined) summary.worktreeId = record.worktreeId;
  if (record.sessionId !== undefined) summary.sessionId = record.sessionId;
  if (record.provider !== undefined) summary.provider = record.provider;

  const error = errorSummary(record.attributes?.error);
  if (error !== undefined) {
    summary.error = error;
  }
  return summary;
}

function errorSummary(value: unknown): DebugLogErrorSummary | undefined {
  const safeError = SafeErrorSchema.safeParse(value);
  if (safeError.success) {
    return safeErrorSummary(safeError.data);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as {
    code?: unknown;
    message?: unknown;
    provider?: unknown;
    diagnosticId?: unknown;
    traceId?: unknown;
    commandId?: unknown;
  };
  const summary: DebugLogErrorSummary = {};
  if (typeof candidate.code === "string") summary.code = candidate.code;
  if (typeof candidate.message === "string") summary.message = candidate.message;
  if (typeof candidate.provider === "string") summary.provider = candidate.provider;
  if (typeof candidate.diagnosticId === "string") summary.diagnosticId = candidate.diagnosticId;
  if (typeof candidate.traceId === "string") summary.traceId = candidate.traceId;
  if (typeof candidate.commandId === "string") summary.commandId = candidate.commandId;
  return Object.keys(summary).length === 0 ? undefined : summary;
}

function safeErrorSummary(error: SafeError): DebugLogErrorSummary {
  const summary: DebugLogErrorSummary = {
    code: error.code,
    message: error.message,
  };
  if (error.provider !== undefined) summary.provider = error.provider;
  if (error.diagnosticId !== undefined) summary.diagnosticId = error.diagnosticId;
  if (error.traceId !== undefined) summary.traceId = error.traceId;
  if (error.commandId !== undefined) summary.commandId = error.commandId;
  return summary;
}

function recordContains(record: LogRecord, query: string): boolean {
  const loweredQuery = query.toLowerCase();
  return JSON.stringify(record).toLowerCase().includes(loweredQuery);
}

function timestamp(record: LogRecord): number {
  return Date.parse(record.timestamp);
}

function levelRank(level: DebugLogLevel): number {
  return logLevels.indexOf(level);
}

function requiredValue(value: string | undefined, option: string): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parseComponent(value: string): DebugLogComponent {
  if (allComponents.includes(value as DebugLogComponent)) {
    return value as DebugLogComponent;
  }
  throw new Error(`Invalid debug logs component: ${value}`);
}

function parseLevel(value: string): DebugLogLevel {
  if (logLevels.includes(value as DebugLogLevel)) {
    return value as DebugLogLevel;
  }
  throw new Error(`Invalid debug logs level: ${value}`);
}

function parseSince(value: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid debug logs --since value: ${value}`);
  }
  return new Date(value).toISOString();
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid debug logs --limit value: ${value}`);
  }
  return parsed;
}
