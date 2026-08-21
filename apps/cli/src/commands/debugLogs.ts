import { readFile } from "node:fs/promises";
import type { StationConfig } from "@station/config";
import type {
  LogRecord,
  ObserverOperationalEvent,
  ObserverStartupEvidence,
  SafeError,
} from "@station/contracts";
import { LogRecordSchema } from "@station/contracts";
import { componentLogPath } from "@station/observability";
import { resolveObserverPaths } from "../paths.js";
import {
  assessCauseEvidence,
  type CauseAssessment,
  type DiagnosticContextEntry,
  type DiagnosticEvidenceRoles,
  type DiagnosticMatchEvidence,
  diagnosticEvidenceRoles,
  extractDiagnosticMatchEvidence,
  type OperationalBoundaryEvidence,
  projectDiagnosticContext,
  projectOperationalBoundaryEvidence,
  retainedFailureSignal,
} from "./diagnosticEvidence.js";
import {
  type LifecycleErrorSummary,
  parseLifecycleLogEvidence,
  parseLogSafeError,
  summarizeLifecycleError,
} from "./lifecycleLogEvidence.js";

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
  causeAssessment: Pick<
    CauseAssessment,
    "status" | "explicitRootCauseCodes" | "observedFailureCodes" | "observedFailureSignals"
  >;
  evidenceRoles: DiagnosticEvidenceRoles;
  records: DebugLogRecordSummary[];
};

type DebugLogRecordSummary = {
  timestamp: string;
  level: DebugLogLevel;
  component: DebugLogComponent;
  componentRole: "logging_location";
  message: string;
  traceId?: string;
  spanId?: string;
  commandId?: string;
  projectId?: string;
  worktreeId?: string;
  sessionId?: string;
  provider?: string;
  operationalEvent?: ObserverOperationalEvent;
  operationalBoundaryEvidence?: OperationalBoundaryEvidence;
  context?: DiagnosticContextEntry[];
  matchEvidence?: DiagnosticMatchEvidence[];
  error?: DebugLogErrorSummary;
  cause?: DebugLogErrorSummary;
  startupEvidence?: ObserverStartupEvidence;
};

type DebugLogErrorSummary = LifecycleErrorSummary & {
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

const defaultComponents: DebugLogComponent[] = ["observer", "cli", "tui", "station-host"];
const allComponents: DebugLogComponent[] = [
  "observer",
  "cli",
  "tui",
  "hook",
  "provider",
  "station-host",
];
const logLevels: DebugLogLevel[] = ["debug", "info", "warn", "error"];

/**
 * ADAPTER
 *
 * Reads redacted lifecycle logs and projects strict outer, causal, and startup
 * evidence fields without treating the logging component as failure ownership.
 */
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
  const includeOperationalBoundaryEvidence = parsed.query !== undefined || selected.length === 1;
  const records = selected.map((record) =>
    logSummary(record, parsed.query, includeOperationalBoundaryEvidence),
  );
  const observedFailureCodes = records.flatMap((record) =>
    record.error?.code === undefined ? [] : [record.error.code],
  );
  const explicitRootCauseCodes = records.flatMap((record) =>
    record.cause?.code === undefined ? [] : [record.cause.code],
  );
  const observedFailureSignals = records.flatMap((record) => {
    const signal = retainedFailureSignal(contextString(record.context ?? [], "/attributes/kind"));
    return signal === undefined ? [] : [signal];
  });
  const assessedCause = assessCauseEvidence({
    explicitRootCauseCodes,
    observedFailureCodes,
    observedFailureSignals,
    matched: selected.length > 0,
    searchComplete: true,
    invalidLines: 0,
    reportingBoundaryOnly: selected.length > 0,
  });
  const causeAssessment: DebugLogsResult["causeAssessment"] = {
    status: assessedCause.status,
    explicitRootCauseCodes: assessedCause.explicitRootCauseCodes,
    observedFailureCodes: assessedCause.observedFailureCodes,
  };
  if (assessedCause.observedFailureSignals !== undefined) {
    causeAssessment.observedFailureSignals = assessedCause.observedFailureSignals;
  }
  const result: DebugLogsResult = {
    components: parsed.components,
    minLevel: parsed.minLevel,
    limit: parsed.limit,
    matched: selected.length,
    evidence: {
      filesSearched,
      matchedFiles: matches.map((match) => match.path),
    },
    causeAssessment,
    evidenceRoles: diagnosticEvidenceRoles(),
    records,
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
    } catch {
      // Ignore one malformed historical line; bounded search continues with valid records.
    }
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

function logSummary(
  record: LogRecord,
  query: string | undefined,
  includeOperationalBoundaryEvidence: boolean,
): DebugLogRecordSummary {
  const context = projectDiagnosticContext(record);
  const lifecycle = parseLifecycleLogEvidence(record.attributes);
  const error =
    lifecycle === undefined
      ? errorSummary(record.attributes?.error)
      : debugLogErrorSummary(lifecycle.error);
  const summary: DebugLogRecordSummary = {
    timestamp: record.timestamp,
    level: record.level,
    component: record.component,
    componentRole: "logging_location",
    message: record.message,
  };
  if (includeOperationalBoundaryEvidence) {
    const operationalInput: OperationalBoundaryEvidence = { recordSummary: record.message };
    const operation = contextString(context, "/attributes/operation");
    if (operation !== undefined) operationalInput.operation = operation;
    const commandType = contextString(context, "/attributes/commandType");
    if (commandType !== undefined) operationalInput.commandType = commandType;
    const signalKind = retainedFailureSignal(contextString(context, "/attributes/kind"));
    if (signalKind !== undefined) operationalInput.signalKind = signalKind;
    if (error?.code !== undefined) operationalInput.errorCode = error.code;
    if (error?.message !== undefined) operationalInput.errorMessage = error.message;
    const operationalBoundaryEvidence = projectOperationalBoundaryEvidence(operationalInput);
    if (operationalBoundaryEvidence !== undefined) {
      summary.operationalBoundaryEvidence = operationalBoundaryEvidence;
    }
  }
  if (record.traceId !== undefined) summary.traceId = record.traceId;
  if (record.spanId !== undefined) summary.spanId = record.spanId;
  if (record.commandId !== undefined) summary.commandId = record.commandId;
  if (record.projectId !== undefined) summary.projectId = record.projectId;
  if (record.worktreeId !== undefined) summary.worktreeId = record.worktreeId;
  if (record.sessionId !== undefined) summary.sessionId = record.sessionId;
  if (record.provider !== undefined) summary.provider = record.provider;
  if (record.operationalEvent !== undefined) summary.operationalEvent = record.operationalEvent;
  if (context.length > 0) summary.context = context;
  if (query !== undefined) {
    const matchEvidence = extractDiagnosticMatchEvidence(record, query);
    if (matchEvidence.length > 0) summary.matchEvidence = matchEvidence;
  }
  if (error !== undefined) summary.error = error;
  if (lifecycle?.cause !== undefined) summary.cause = debugLogErrorSummary(lifecycle.cause);
  if (lifecycle?.startupEvidence !== undefined) {
    summary.startupEvidence = lifecycle.startupEvidence;
  }
  return summary;
}

function contextString(
  context: readonly DiagnosticContextEntry[],
  path: string,
): string | undefined {
  const value = context.find((entry) => entry.path === path)?.value;
  return typeof value === "string" ? value : undefined;
}

function errorSummary(value: unknown): DebugLogErrorSummary | undefined {
  const safeError = parseLogSafeError(value);
  return safeError === undefined ? undefined : debugLogErrorSummary(safeError);
}

function debugLogErrorSummary(error: SafeError): DebugLogErrorSummary {
  const summary: DebugLogErrorSummary = summarizeLifecycleError(error);
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
