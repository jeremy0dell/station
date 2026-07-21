import { z } from "zod";
import { CommandRecordSchema } from "./commands.js";
import { ErrorEnvelopeSchema, SafeErrorSchema } from "./errors.js";
import { StationEventSchema } from "./events.js";
import {
  CommandIdSchema,
  HarnessRunIdSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  STATION_SCHEMA_VERSION,
  TerminalTargetIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { ObserverHealthSchema, ObserverSqliteHealthSummarySchema } from "./observer.js";
import { ProviderHealthSchema, ProviderHookRuntimeSchema } from "./providers.js";
import { nonEmptyStringSchema } from "./shared.js";
import { StationSnapshotSchema } from "./snapshot.js";

export const TraceIdSchema = nonEmptyStringSchema;
export const SpanIdSchema = nonEmptyStringSchema;

export const TraceContextSchema = z
  .object({
    traceId: TraceIdSchema,
    spanId: SpanIdSchema,
    parentSpanId: SpanIdSchema.optional(),
    operation: nonEmptyStringSchema.optional(),
  })
  .strict();

export type TraceContext = z.infer<typeof TraceContextSchema>;

export const DiagnosticContextSchema = z
  .object({
    traceId: TraceIdSchema.optional(),
    spanId: SpanIdSchema.optional(),
    operation: nonEmptyStringSchema.optional(),
  })
  .strict();

export type DiagnosticContext = z.infer<typeof DiagnosticContextSchema>;

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export const LogComponentSchema = z.enum([
  "observer",
  "cli",
  "tui",
  "hook",
  "provider",
  "station-host",
]);

export const LogRecordSchema = z
  .object({
    timestamp: TimestampSchema,
    level: LogLevelSchema,
    component: LogComponentSchema,
    message: nonEmptyStringSchema,
    traceId: TraceIdSchema.optional(),
    spanId: SpanIdSchema.optional(),
    commandId: CommandIdSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    worktreeId: nonEmptyStringSchema.optional(),
    sessionId: nonEmptyStringSchema.optional(),
    provider: ProviderIdSchema.optional(),
    attributes: z.record(nonEmptyStringSchema, z.unknown()).optional(),
  })
  .strict();

export type LogRecord = z.infer<typeof LogRecordSchema>;

export const RetentionPolicySchema = z
  .object({
    maxDays: z.number().int().positive(),
    maxTotalMb: z.number().int().positive(),
    maxFileMb: z.number().int().positive(),
    maxFilesPerComponent: z.number().int().positive(),
    components: z
      .object({
        observerMaxMb: z.number().int().positive(),
        cliMaxMb: z.number().int().positive(),
        tuiMaxMb: z.number().int().positive(),
        hookRunnerMaxMb: z.number().int().positive(),
        providerMaxMb: z.number().int().positive(),
      })
      .strict(),
    sqlite: z
      .object({
        eventsMaxDays: z.number().int().positive(),
        commandsMaxDays: z.number().int().positive(),
        errorsMaxDays: z.number().int().positive(),
        providerObservationsMaxDays: z.number().int().positive(),
      })
      .strict(),
    debugBundles: z
      .object({
        maxBundles: z.number().int().positive(),
        maxDays: z.number().int().positive(),
      })
      .strict(),
    hookSpool: z
      .object({
        deliveredDeleteImmediately: z.boolean(),
        failedMaxDays: z.number().int().positive(),
        failedMaxItems: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export const LocalStateUsageEntrySchema = z
  .object({
    kind: z.enum(["logs", "database", "debug_bundles", "hook_spool", "other"]),
    path: nonEmptyStringSchema,
    sizeBytes: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative().optional(),
    limitBytes: z.number().int().nonnegative().optional(),
    overLimit: z.boolean().optional(),
  })
  .strict();

export const LocalStateUsageSchema = z
  .object({
    stateDir: nonEmptyStringSchema,
    totalBytes: z.number().int().nonnegative(),
    limitBytes: z.number().int().nonnegative(),
    overLimit: z.boolean(),
    entries: z.array(LocalStateUsageEntrySchema),
  })
  .strict();

export type LocalStateUsage = z.infer<typeof LocalStateUsageSchema>;

export const RedactionReportSchema = z
  .object({
    policyVersion: nonEmptyStringSchema,
    generatedAt: TimestampSchema,
    redactedFields: z.array(nonEmptyStringSchema),
    redactedPatterns: z.array(nonEmptyStringSchema),
    replacements: z.number().int().nonnegative(),
    suspiciousSecretsFound: z.number().int().nonnegative(),
  })
  .strict();

export type RedactionReport = z.infer<typeof RedactionReportSchema>;

export const DiagnosticCollectionOptionsSchema = z
  .object({
    since: TimestampSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    commandId: CommandIdSchema.optional(),
    traceId: TraceIdSchema.optional(),
    latestFailure: z.boolean().optional(),
    includeLogs: z.boolean().optional(),
    maxLogRecords: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export type DiagnosticCollectionOptions = z.infer<typeof DiagnosticCollectionOptionsSchema>;

export const DoctorOptionsSchema = z
  .object({
    projectId: ProjectIdSchema.optional(),
    deep: z.boolean().optional(),
    providerHookRuntime: ProviderHookRuntimeSchema.optional(),
  })
  .strict()
  .optional();

export type DoctorOptions = z.infer<typeof DoctorOptionsSchema>;

export const DiagnosticConfigSummarySchema = z
  .object({
    configPath: nonEmptyStringSchema.optional(),
    projectCount: z.number().int().nonnegative(),
    diagnostics: z.array(SafeErrorSchema),
  })
  .strict();

export const HookSpoolSummarySchema = z
  .object({
    path: nonEmptyStringSchema,
    pending: z.number().int().nonnegative(),
    oldestCreatedAt: TimestampSchema.optional(),
    newestCreatedAt: TimestampSchema.optional(),
  })
  .strict();

export const DiagnosticSnapshotSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    collectedAt: TimestampSchema,
    observerHealth: ObserverHealthSchema,
    snapshot: StationSnapshotSchema,
    providerHealth: z.record(ProviderIdSchema, ProviderHealthSchema),
    commands: z.array(CommandRecordSchema),
    events: z.array(StationEventSchema),
    errors: z.array(ErrorEnvelopeSchema),
    logs: z.array(LogRecordSchema),
    configSummary: DiagnosticConfigSummarySchema.optional(),
    localState: LocalStateUsageSchema.optional(),
    retention: RetentionPolicySchema.optional(),
    hookSpool: HookSpoolSummarySchema.optional(),
    redactionReport: RedactionReportSchema.optional(),
  })
  .strict();

export type DiagnosticSnapshot = z.infer<typeof DiagnosticSnapshotSchema>;

export const DiagnosticEvidenceCategorySchema = z.enum([
  "config",
  "observer",
  "sqlite",
  "provider",
  "command",
  "event",
  "error",
  "log",
  "hook_spool",
  "snapshot",
  "row",
  "session",
  "local_state",
  "retention",
]);

export const DiagnosticEvidenceSeveritySchema = z.enum(["debug", "info", "warn", "error", "fatal"]);

export const DiagnosticRootCauseCodeSchema = z.enum([
  "INVALID_CONFIG",
  "MISSING_WORKTRUNK_BINARY",
  "STALE_TERMINAL_TARGET",
  "HOOK_SPOOL_FALLBACK",
  "PROVIDER_TIMEOUT",
  "HARNESS_UNEXPECTED_EXIT",
  "SQLITE_WRITE_FAILURE",
  "COMMAND_FAILED",
  "PROVIDER_UNAVAILABLE",
  "WORKTRUNK_BRANCH_EXISTS",
  "WORKTRUNK_WORKTREE_EXISTS",
]);

export type DiagnosticRootCauseCode = z.infer<typeof DiagnosticRootCauseCodeSchema>;

export const DiagnosticEvidenceItemSchema = z
  .object({
    id: nonEmptyStringSchema,
    category: DiagnosticEvidenceCategorySchema,
    severity: DiagnosticEvidenceSeveritySchema,
    code: nonEmptyStringSchema.optional(),
    message: nonEmptyStringSchema,
    provider: ProviderIdSchema.optional(),
    commandId: CommandIdSchema.optional(),
    traceId: TraceIdSchema.optional(),
    spanId: SpanIdSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    targetId: TerminalTargetIdSchema.optional(),
    runId: HarnessRunIdSchema.optional(),
    diagnosticId: nonEmptyStringSchema.optional(),
    evidence: z.record(nonEmptyStringSchema, z.unknown()).optional(),
  })
  .strict();

export type DiagnosticEvidenceItem = z.infer<typeof DiagnosticEvidenceItemSchema>;

export const DiagnosticRootCauseSchema = z
  .object({
    code: DiagnosticRootCauseCodeSchema,
    confidence: z.enum(["high", "medium", "low"]),
    summary: nonEmptyStringSchema,
    itemIds: z.array(nonEmptyStringSchema),
    provider: ProviderIdSchema.optional(),
    commandId: CommandIdSchema.optional(),
    diagnosticId: nonEmptyStringSchema.optional(),
  })
  .strict();

export type DiagnosticRootCause = z.infer<typeof DiagnosticRootCauseSchema>;

export const DiagnosticQuestionSchema = z
  .object({
    id: nonEmptyStringSchema,
    question: nonEmptyStringSchema,
    answer: nonEmptyStringSchema,
    itemIds: z.array(nonEmptyStringSchema),
  })
  .strict();

export type DiagnosticQuestion = z.infer<typeof DiagnosticQuestionSchema>;

export const DiagnosticEvidenceIndexSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    generatedAt: TimestampSchema,
    source: z
      .object({
        collectedAt: TimestampSchema.optional(),
        bundleId: nonEmptyStringSchema.optional(),
      })
      .strict()
      .optional(),
    summary: z
      .object({
        status: z.enum(["healthy", "degraded", "unavailable"]),
        rootCauseCodes: z.array(DiagnosticRootCauseCodeSchema),
        providers: z.array(ProviderIdSchema),
        commandIds: z.array(CommandIdSchema),
        diagnosticIds: z.array(nonEmptyStringSchema),
        redaction: z.enum(["redacted", "unknown"]),
      })
      .strict(),
    items: z.array(DiagnosticEvidenceItemSchema),
    rootCauses: z.array(DiagnosticRootCauseSchema),
    questions: z.array(DiagnosticQuestionSchema),
  })
  .strict();

export type DiagnosticEvidenceIndex = z.infer<typeof DiagnosticEvidenceIndexSchema>;

export const DoctorCheckSchema = z
  .object({
    name: nonEmptyStringSchema,
    status: z.enum(["ok", "warn", "error"]),
    message: nonEmptyStringSchema,
    error: SafeErrorSchema.optional(),
  })
  .strict();

export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

export const DoctorReportSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    generatedAt: TimestampSchema,
    status: z.enum(["healthy", "degraded", "unavailable"]),
    checks: z.array(DoctorCheckSchema),
    observer: ObserverHealthSchema,
    config: DiagnosticConfigSummarySchema,
    sqlite: ObserverSqliteHealthSummarySchema.optional(),
    providers: z.record(ProviderIdSchema, ProviderHealthSchema),
    hooks: HookSpoolSummarySchema.optional(),
    snapshot: StationSnapshotSchema,
    logs: z
      .object({
        paths: z.array(nonEmptyStringSchema),
        recent: z.array(LogRecordSchema),
      })
      .strict(),
    localState: LocalStateUsageSchema,
    retention: RetentionPolicySchema,
    recentErrors: z.array(SafeErrorSchema),
    debugBundle: z
      .object({
        available: z.boolean(),
        diagnosticsDir: nonEmptyStringSchema,
      })
      .strict(),
  })
  .strict();

export type DoctorReport = z.infer<typeof DoctorReportSchema>;

export const DebugBundleManifestSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    bundleId: nonEmptyStringSchema,
    createdAt: TimestampSchema,
    bundlePath: nonEmptyStringSchema,
    stationVersion: nonEmptyStringSchema,
    platform: nonEmptyStringSchema,
    nodeVersion: nonEmptyStringSchema,
    redactionPolicyVersion: nonEmptyStringSchema,
    sections: z.array(nonEmptyStringSchema),
    commandIds: z.array(CommandIdSchema).optional(),
    traceIds: z.array(TraceIdSchema).optional(),
    redactionReport: RedactionReportSchema,
  })
  .strict();

export type DebugBundleManifest = z.infer<typeof DebugBundleManifestSchema>;

export const EMPTY_REDACTION_REPORT: RedactionReport = {
  policyVersion: "station-redaction-v1",
  generatedAt: "2026-05-20T00:00:00.000Z",
  redactedFields: [],
  redactedPatterns: [],
  replacements: 0,
  suspiciousSecretsFound: 0,
};

export const DEFAULT_DIAGNOSTIC_SCHEMA_VERSION = STATION_SCHEMA_VERSION;
