import type { StationConfig } from "@station/config";
import type { LogRecord, SafeError } from "@station/contracts";
import { LogRecordSchema, SafeErrorSchema } from "@station/contracts";
import { componentLogPath, readJsonlReverse } from "@station/observability";
import { z } from "zod";
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
  search: {
    complete: boolean;
    bytesRead: number;
    invalidLines: number;
    incompleteComponents: DebugLogComponent[];
  };
  truncation: {
    records: boolean;
    text: boolean;
  };
  retryCommand?: string;
  evidence?: {
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
  full: boolean;
};

type DebugLogComponent = "observer" | "cli" | "tui" | "hook" | "provider" | "station-host";
type DebugLogLevel = "debug" | "info" | "warn" | "error";

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
const defaultSearchBytes = 8 * 1024 * 1024;
const conciseTextCodePoints = 240;

const DebugLogErrorSchema = z
  .object({
    code: z.string().optional(),
    message: z.string().optional(),
    provider: z.string().optional(),
    diagnosticId: z.string().optional(),
    traceId: z.string().optional(),
    commandId: z.string().optional(),
  })
  .passthrough();

export async function runDebugLogsCommand(
  args: string[],
  options: DebugLogsCommandOptions = {},
): Promise<DebugLogsResult> {
  const parsed = parseDebugLogsArgs(args);
  const paths = resolveObserverPaths(options.config);
  const files = parsed.components.map((component) => ({
    component,
    path: componentLogPath(paths.stateDir, component),
  }));
  const searches = await Promise.all(
    files.map(async (file) => ({
      ...file,
      result: await readJsonlReverse(file.path, LogRecordSchema, {
        ...(parsed.full ? {} : { maxBytes: defaultSearchBytes }),
        maxRecords: parsed.limit + 1,
        matches: (record) => logMatches(record, parsed),
      }),
    })),
  );

  const matchingSearches = searches.filter((search) => search.result.records.length > 0);
  const candidates = matchingSearches
    .flatMap((search) => search.result.records)
    .sort((left, right) => timestamp(left) - timestamp(right));
  const selected = candidates.slice(-parsed.limit);
  const summaries = selected.map((record) => logSummary(record, parsed.full));
  const incompleteComponents = searches
    .filter((search) => !search.result.complete)
    .map((search) => search.component);
  const searchComplete = incompleteComponents.length === 0;
  const result: DebugLogsResult = {
    components: parsed.components,
    minLevel: parsed.minLevel,
    limit: parsed.limit,
    matched: selected.length,
    search: {
      complete: searchComplete,
      bytesRead: searches.reduce((total, search) => total + search.result.bytesRead, 0),
      invalidLines: searches.reduce((total, search) => total + search.result.invalidLines, 0),
      incompleteComponents,
    },
    truncation: {
      records: candidates.length > parsed.limit,
      text: summaries.some((summary) => summary.truncated),
    },
    records: summaries.map((summary) => summary.record),
  };
  if (parsed.query !== undefined) result.query = parsed.query;
  if (parsed.since !== undefined) result.since = parsed.since;
  if (parsed.full) {
    result.evidence = {
      filesSearched: files.map((file) => file.path),
      matchedFiles: matchingSearches.map((search) => search.path),
    };
  }
  if (!parsed.full && selected.length === 0 && !searchComplete) {
    result.retryCommand = debugLogsFullCommand(args);
  }
  return result;
}

function parseDebugLogsArgs(args: string[]): DebugLogsArgs {
  let query: string | undefined;
  const components: DebugLogComponent[] = [];
  let minLevel: DebugLogLevel | undefined;
  let since: string | undefined;
  let explicitLimit: number | undefined;
  let full = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--full") {
      full = true;
      continue;
    }
    if (arg === "--component") {
      components.push(parseComponent(requiredValue(args[index + 1], "--component")));
      index += 1;
      continue;
    }
    if (arg === "--all-components") {
      for (const component of allComponents) {
        if (!components.includes(component)) components.push(component);
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
      explicitLimit = parseLimit(requiredValue(args[index + 1], "--limit"));
      index += 1;
      continue;
    }
    if (arg?.startsWith("--")) throw new Error(`Unknown debug logs option: ${arg}`);
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
    limit: explicitLimit ?? (full ? 50 : 5),
    full,
  };
}

function logMatches(record: LogRecord, args: DebugLogsArgs): boolean {
  return (
    args.components.includes(record.component) &&
    levelRank(record.level) >= levelRank(args.minLevel) &&
    (args.since === undefined || record.timestamp >= args.since) &&
    (args.query === undefined || recordContains(record, args.query))
  );
}

function logSummary(
  record: LogRecord,
  full: boolean,
): { record: DebugLogRecordSummary; truncated: boolean } {
  const message = boundedText(record.message, full);
  const summary: DebugLogRecordSummary = {
    timestamp: record.timestamp,
    level: record.level,
    component: record.component,
    message: message.value,
  };
  if (record.traceId !== undefined) summary.traceId = record.traceId;
  if (record.spanId !== undefined) summary.spanId = record.spanId;
  if (record.commandId !== undefined) summary.commandId = record.commandId;
  if (record.projectId !== undefined) summary.projectId = record.projectId;
  if (record.worktreeId !== undefined) summary.worktreeId = record.worktreeId;
  if (record.sessionId !== undefined) summary.sessionId = record.sessionId;
  if (record.provider !== undefined) summary.provider = record.provider;

  const error = errorSummary(record.attributes?.error, full);
  if (error !== undefined) summary.error = error.value;
  return { record: summary, truncated: message.truncated || error?.truncated === true };
}

function errorSummary(
  value: unknown,
  full: boolean,
): { value: DebugLogErrorSummary; truncated: boolean } | undefined {
  const safeError = SafeErrorSchema.safeParse(value);
  if (safeError.success) return safeErrorSummary(safeError.data, full);
  const parsed = DebugLogErrorSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const summary: DebugLogErrorSummary = {};
  if (parsed.data.code !== undefined) summary.code = parsed.data.code;
  const message =
    parsed.data.message === undefined ? undefined : boundedText(parsed.data.message, full);
  if (message !== undefined) summary.message = message.value;
  if (parsed.data.provider !== undefined) summary.provider = parsed.data.provider;
  if (parsed.data.diagnosticId !== undefined) summary.diagnosticId = parsed.data.diagnosticId;
  if (parsed.data.traceId !== undefined) summary.traceId = parsed.data.traceId;
  if (parsed.data.commandId !== undefined) summary.commandId = parsed.data.commandId;
  return Object.keys(summary).length === 0
    ? undefined
    : { value: summary, truncated: message?.truncated === true };
}

function safeErrorSummary(
  error: SafeError,
  full: boolean,
): { value: DebugLogErrorSummary; truncated: boolean } {
  const message = boundedText(error.message, full);
  const summary: DebugLogErrorSummary = { code: error.code, message: message.value };
  if (error.provider !== undefined) summary.provider = error.provider;
  if (error.diagnosticId !== undefined) summary.diagnosticId = error.diagnosticId;
  if (error.traceId !== undefined) summary.traceId = error.traceId;
  if (error.commandId !== undefined) summary.commandId = error.commandId;
  return { value: summary, truncated: message.truncated };
}

function boundedText(value: string, full: boolean): { value: string; truncated: boolean } {
  const codePoints = [...value];
  if (full || codePoints.length <= conciseTextCodePoints) {
    return { value, truncated: false };
  }
  return {
    value: `${codePoints.slice(0, conciseTextCodePoints - 1).join("")}…`,
    truncated: true,
  };
}

function debugLogsFullCommand(args: readonly string[]): string {
  const retryArgs = args.filter((arg) => arg !== "--json" && arg !== "--full");
  return ["stn", "debug", "logs", ...retryArgs, "--full"].map(shellArg).join(" ");
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function recordContains(record: LogRecord, query: string): boolean {
  return JSON.stringify(record).toLowerCase().includes(query.toLowerCase());
}

function timestamp(record: LogRecord): number {
  return Date.parse(record.timestamp);
}

function levelRank(level: DebugLogLevel): number {
  return logLevels.indexOf(level);
}

function requiredValue(value: string | undefined, option: string): string {
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function parseComponent(value: string): DebugLogComponent {
  if (allComponents.includes(value as DebugLogComponent)) return value as DebugLogComponent;
  throw new Error(`Invalid debug logs component: ${value}`);
}

function parseLevel(value: string): DebugLogLevel {
  if (logLevels.includes(value as DebugLogLevel)) return value as DebugLogLevel;
  throw new Error(`Invalid debug logs level: ${value}`);
}

function parseSince(value: string): string {
  if (Number.isNaN(Date.parse(value)))
    throw new Error(`Invalid debug logs --since value: ${value}`);
  return new Date(value).toISOString();
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid debug logs --limit value: ${value}`);
  }
  return parsed;
}
