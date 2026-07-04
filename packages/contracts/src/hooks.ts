import { z } from "zod";
import { SafeErrorSchema } from "./errors.js";
import {
  StationEventSchema,
  StationEventTypeSchema,
  WorktreeAgentStateChangeSourceSchema,
} from "./events.js";
import {
  HarnessRunIdSchema,
  ProjectIdSchema,
  type ProviderId,
  ProviderIdSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  TerminalTargetIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import {
  HarnessEventDiagnosticsSchema,
  HarnessTurnSchema,
  ObservedStatusSchema,
} from "./observations.js";
import { nonEmptyStringSchema, optionalProviderDataSchema } from "./shared.js";

export const ProviderHookKindSchema = z.enum(["worktree", "terminal", "harness", "provider"]);

export const ProviderHookEventSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    hookId: nonEmptyStringSchema.optional(),
    provider: ProviderIdSchema,
    kind: ProviderHookKindSchema,
    event: nonEmptyStringSchema,
    receivedAt: TimestampSchema,
    projectId: ProjectIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    payload: optionalProviderDataSchema,
  })
  .strict();

export type ProviderHookEvent = z.infer<typeof ProviderHookEventSchema>;
export type ProviderHookKind = z.infer<typeof ProviderHookKindSchema>;

export const ProviderHookReceiptSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    hookId: nonEmptyStringSchema,
    provider: ProviderIdSchema,
    event: nonEmptyStringSchema,
    accepted: z.boolean(),
    status: z.enum(["ingested", "spooled", "rejected", "ignored"]),
    receivedAt: TimestampSchema,
    reconciled: z.boolean().optional(),
    spooled: z.boolean().optional(),
    deduped: z.boolean().optional(),
    error: SafeErrorSchema.optional(),
  })
  .strict();

export type ProviderHookReceipt = z.infer<typeof ProviderHookReceiptSchema>;
export const HookReceiptSchema = ProviderHookReceiptSchema;
export type HookReceipt = ProviderHookReceipt;

export const HarnessEventReportCorrelationSchema = z
  .object({
    harnessRunId: HarnessRunIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    terminalTargetId: TerminalTargetIdSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    nativeSessionId: nonEmptyStringSchema.optional(),
    nativeSessionFile: nonEmptyStringSchema.optional(),
    cwd: nonEmptyStringSchema.optional(),
    pid: z.number().int().positive().optional(),
  })
  .strict();

export type HarnessEventReportCorrelation = z.infer<typeof HarnessEventReportCorrelationSchema>;

export const HarnessEventReportDiagnosticsSchema = HarnessEventDiagnosticsSchema;

export type HarnessEventReportDiagnostics = z.infer<typeof HarnessEventReportDiagnosticsSchema>;

export const HarnessEventReportSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    reportId: nonEmptyStringSchema,
    provider: ProviderIdSchema,
    kind: z.literal("harness"),
    eventType: nonEmptyStringSchema,
    observedAt: TimestampSchema,
    coalesceKey: nonEmptyStringSchema.optional(),
    status: ObservedStatusSchema.optional(),
    turn: HarnessTurnSchema.optional(),
    correlation: HarnessEventReportCorrelationSchema.optional(),
    diagnostics: HarnessEventReportDiagnosticsSchema.optional(),
    providerData: optionalProviderDataSchema,
  })
  .strict();

export type HarnessEventReport = z.infer<typeof HarnessEventReportSchema>;

export const HarnessEventReportReceiptSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    reportId: nonEmptyStringSchema,
    provider: ProviderIdSchema,
    eventType: nonEmptyStringSchema,
    accepted: z.boolean(),
    status: z.enum(["accepted", "spooled", "rejected"]),
    receivedAt: TimestampSchema,
    projected: z.boolean().optional(),
    scheduledReconcile: z.boolean().optional(),
    deduped: z.boolean().optional(),
    error: SafeErrorSchema.optional(),
  })
  .strict();

export type HarnessEventReportReceipt = z.infer<typeof HarnessEventReportReceiptSchema>;

export const ProviderHookPayloadSummarySchema = z
  .object({
    present: z.boolean(),
    originalBytes: z.number().int().nonnegative().nullable(),
    compactedBytes: z.number().int().nonnegative().nullable(),
    compacted: z.boolean(),
    omittedFieldNames: z.array(nonEmptyStringSchema),
  })
  .strict();

export type ProviderHookPayloadSummary = z.infer<typeof ProviderHookPayloadSummarySchema>;
export const HookPayloadSummarySchema = ProviderHookPayloadSummarySchema;
export type HookPayloadSummary = ProviderHookPayloadSummary;

export const StationHookIdentityPayloadSchema = z
  .object({
    station_project_id: nonEmptyStringSchema.optional(),
    station_worktree_id: nonEmptyStringSchema.optional(),
    station_worktree_path: nonEmptyStringSchema.optional(),
    station_session_id: nonEmptyStringSchema.optional(),
    station_terminal_provider: nonEmptyStringSchema.optional(),
    station_terminal_target_id: nonEmptyStringSchema.optional(),
  })
  .passthrough();

export type StationHookIdentityPayload = z.infer<typeof StationHookIdentityPayloadSchema>;

export function parseStationHookIdentityPayload(
  payload: unknown,
): StationHookIdentityPayload | undefined {
  const result = StationHookIdentityPayloadSchema.safeParse(payload);
  return result.success ? result.data : undefined;
}

export const ProviderHookEventNamePayloadSchema = z
  .object({
    hook_event_name: nonEmptyStringSchema.optional(),
  })
  .passthrough();

export type ProviderHookEventNamePayload = z.infer<typeof ProviderHookEventNamePayloadSchema>;

export function parseProviderHookEventName(payload: unknown): string | undefined {
  const result = ProviderHookEventNamePayloadSchema.safeParse(payload);
  return result.success ? result.data.hook_event_name : undefined;
}

export type ProviderHookScopeDecision =
  | {
      action: "accept";
      reason: "not-required" | "station-env" | "cwd";
    }
  | {
      action: "ignore";
      reason: "missing-station-env" | "event-not-forwarded";
    };
export type HookScopeDecision = ProviderHookScopeDecision;

export type ProviderHookPayloadEnrichmentInput = {
  payload: unknown;
  env: Record<string, string | undefined>;
};

export function enrichStationHookIdentityPayload(
  input: ProviderHookPayloadEnrichmentInput,
): unknown {
  const parsed = StationHookIdentityPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    return input.payload;
  }

  const payload: Record<string, unknown> = { ...parsed.data };
  const fields = [
    ["station_project_id", input.env.STATION_PROJECT_ID],
    ["station_worktree_id", input.env.STATION_WORKTREE_ID],
    ["station_worktree_path", input.env.STATION_WORKTREE_PATH],
    ["station_session_id", input.env.STATION_SESSION_ID],
    ["station_terminal_provider", input.env.STATION_TERMINAL_PROVIDER],
    ["station_terminal_target_id", input.env.STATION_TERMINAL_TARGET_ID],
  ] as const;
  for (const [key, value] of fields) {
    if (payload[key] === undefined && value !== undefined && value.length > 0) {
      payload[key] = value;
    }
  }
  return payload;
}

export type ProviderHookPayloadCompactionResult = {
  event: ProviderHookEvent;
  payloadSummary: ProviderHookPayloadSummary;
};

export type HarnessEventReportResult =
  | {
      ok: true;
      report: HarnessEventReport;
    }
  | {
      ok: false;
      error: unknown;
    };

export type ProviderHookReportInput = {
  event: ProviderHookEvent;
  payloadSummary: ProviderHookPayloadSummary;
  fallbackReportId: () => string;
};

export type ProviderHookAdapter = {
  provider: ProviderId;
  kind?: ProviderHookKind;
  normalizeEventName?: (event: string) => string;
  enrichPayload?: (input: ProviderHookPayloadEnrichmentInput) => unknown;
  decideScope?: (event: ProviderHookEvent) => ProviderHookScopeDecision;
  compactPayload?: (event: ProviderHookEvent) => ProviderHookPayloadCompactionResult;
  toHarnessEventReport?: (input: ProviderHookReportInput) => HarnessEventReportResult;
};

export const ProviderHookSpoolRecordSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    spoolId: nonEmptyStringSchema,
    createdAt: TimestampSchema,
    event: ProviderHookEventSchema,
    attempts: z.number().int().nonnegative(),
    lastError: SafeErrorSchema.optional(),
  })
  .strict();

export type ProviderHookSpoolRecord = z.infer<typeof ProviderHookSpoolRecordSchema>;
export const HookSpoolRecordSchema = ProviderHookSpoolRecordSchema;
export type HookSpoolRecord = ProviderHookSpoolRecord;

export const HarnessEventReportSpoolRecordSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    spoolId: nonEmptyStringSchema,
    createdAt: TimestampSchema,
    report: HarnessEventReportSchema,
    attempts: z.number().int().nonnegative(),
    lastError: SafeErrorSchema.optional(),
  })
  .strict();

export type HarnessEventReportSpoolRecord = z.infer<typeof HarnessEventReportSpoolRecordSchema>;

export const ObserverEventHookFilterSchema = z
  .object({
    agentState: ObservedStatusSchema.shape.value.optional(),
    harness: ProviderIdSchema.optional(),
    changeSource: WorktreeAgentStateChangeSourceSchema.optional(),
    harnessEventType: nonEmptyStringSchema.optional(),
  })
  .strict();

export type ObserverEventHookFilter = z.infer<typeof ObserverEventHookFilterSchema>;
export const EventHookFilterSchema = ObserverEventHookFilterSchema;
export type EventHookFilter = ObserverEventHookFilter;

export const ObserverEventHookConfigSchema = z
  .object({
    id: nonEmptyStringSchema,
    events: z.array(StationEventTypeSchema).min(1),
    command: nonEmptyStringSchema,
    args: z.array(nonEmptyStringSchema).optional(),
    timeoutMs: z.number().int().positive().optional(),
    filter: ObserverEventHookFilterSchema.optional(),
  })
  .strict();

export type ObserverEventHookConfig = z.infer<typeof ObserverEventHookConfigSchema>;
export const EventHookConfigSchema = ObserverEventHookConfigSchema;
export type EventHookConfig = ObserverEventHookConfig;

export const ObserverEventHookInvocationSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    hookId: nonEmptyStringSchema,
    observedAt: TimestampSchema,
    event: StationEventSchema,
  })
  .strict();

export type ObserverEventHookInvocation = z.infer<typeof ObserverEventHookInvocationSchema>;
export const EventHookInvocationSchema = ObserverEventHookInvocationSchema;
export type EventHookInvocation = ObserverEventHookInvocation;
