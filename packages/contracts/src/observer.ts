import { z } from "zod";
import type { CommandReceipt, CommandRecord, StationCommand } from "./commands.js";
import type {
  DiagnosticCollectionOptions,
  DiagnosticSnapshot,
  DoctorOptions,
  DoctorReport,
} from "./diagnostics.js";
import { SafeErrorSchema } from "./errors.js";
import type { EventFilter, StationEvent } from "./events.js";
import type {
  HarnessReadinessQueryParams,
  HarnessReadinessQueryResult,
} from "./harnessReadiness.js";
import type {
  HarnessEventReport,
  HarnessEventReportReceipt,
  ProviderHookEvent,
  ProviderHookReceipt,
} from "./hooks.js";
import {
  type CommandId,
  ProjectIdSchema,
  ProviderIdSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  TerminalTargetIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import {
  HarnessLaunchPlanSchema,
  ManagedTerminalAttachmentSchema,
  ProviderHealthSchema,
} from "./providers.js";
import { nonEmptyStringSchema } from "./shared.js";
import { type StationSnapshot, StationSnapshotSchema } from "./snapshot.js";

export const ObserverHealthStatusSchema = z.enum(["healthy", "degraded", "unavailable"]);

export const ObserverProcessIdentitySchema = z
  .object({
    pid: z.number().int().positive(),
    osStartTime: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
    socketPath: nonEmptyStringSchema,
  })
  .strict();

export type ObserverProcessIdentity = z.infer<typeof ObserverProcessIdentitySchema>;

export const ObserverSqliteHealthSummarySchema = z
  .object({
    path: nonEmptyStringSchema,
    open: z.boolean(),
    status: z.enum(["healthy", "unavailable", "closed"]),
    schemaVersion: z.number().int().nonnegative(),
    lastCheckedAt: TimestampSchema,
    lastError: SafeErrorSchema.optional(),
  })
  .passthrough();

export const ObserverReconcileTimingSchema = z
  .object({
    reason: nonEmptyStringSchema,
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema,
    durationMs: z.number().nonnegative(),
    projectsScanned: z.number().int().nonnegative().optional(),
    worktreesObserved: z.number().int().nonnegative().optional(),
    terminalTargetsObserved: z.number().int().nonnegative().optional(),
    harnessRunsObserved: z.number().int().nonnegative().optional(),
    eventsEmitted: z.number().int().nonnegative().optional(),
    errors: z.array(SafeErrorSchema).optional(),
  })
  .strict();

export const HarnessIngressQueueHealthSchema = z
  .object({
    depth: z.number().int().nonnegative(),
    enqueued: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    coalesced: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    lastProcessedAt: TimestampSchema.optional(),
    lastError: SafeErrorSchema.optional(),
    lastDrain: z
      .object({
        scanned: z.number().int().nonnegative(),
        drained: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        finishedAt: TimestampSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export type HarnessIngressQueueHealth = z.infer<typeof HarnessIngressQueueHealthSchema>;

export const ObserverHealthSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    status: ObserverHealthStatusSchema,
    pid: z.number().int().positive().optional(),
    startedAt: TimestampSchema.optional(),
    version: nonEmptyStringSchema.optional(),
    socketPath: nonEmptyStringSchema.optional(),
    stateDir: nonEmptyStringSchema.optional(),
    uptimeMs: z.number().nonnegative().optional(),
    hookSpoolDepth: z.number().int().nonnegative().optional(),
    harnessIngressQueue: HarnessIngressQueueHealthSchema.optional(),
    providerHealth: z.record(ProviderIdSchema, ProviderHealthSchema).optional(),
    sqlite: ObserverSqliteHealthSummarySchema.optional(),
    lastReconcile: ObserverReconcileTimingSchema.optional(),
  })
  .strict();

export type ObserverHealth = z.infer<typeof ObserverHealthSchema>;

export const ObserverStopReceiptSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    stopped: z.boolean(),
    at: TimestampSchema,
    message: nonEmptyStringSchema.optional(),
  })
  .strict();

export type ObserverStopReceipt = z.infer<typeof ObserverStopReceiptSchema>;

export const ReconcileReceiptSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    reason: nonEmptyStringSchema,
    reconciledAt: TimestampSchema,
    snapshot: StationSnapshotSchema,
  })
  .strict();

export type ReconcileReceipt = z.infer<typeof ReconcileReceiptSchema>;

export const AgentPrepareExternalLaunchParamsSchema = z
  .object({
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    harness: ProviderIdSchema.optional(),
  })
  .strict();

export type AgentPrepareExternalLaunchParams = z.infer<
  typeof AgentPrepareExternalLaunchParamsSchema
>;

export const AgentPrepareExternalLaunchResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("prepared"),
      sessionId: SessionIdSchema,
      terminalTargetId: TerminalTargetIdSchema,
      launchPlan: HarnessLaunchPlanSchema,
      attachment: ManagedTerminalAttachmentSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("existing-session"),
      sessionId: SessionIdSchema,
      harnessProvider: ProviderIdSchema,
      attachment: ManagedTerminalAttachmentSchema.optional(),
    })
    .strict(),
]);

export type AgentPrepareExternalLaunchResult = z.infer<
  typeof AgentPrepareExternalLaunchResultSchema
>;

export const AgentReportExternalExitParamsSchema = z
  .object({
    terminalTargetId: TerminalTargetIdSchema,
  })
  .strict();

export type AgentReportExternalExitParams = z.infer<typeof AgentReportExternalExitParamsSchema>;

export const AgentReportExternalExitResultSchema = z
  .object({
    acknowledged: z.boolean(),
    terminalTargetId: TerminalTargetIdSchema,
  })
  .strict();

export type AgentReportExternalExitResult = z.infer<typeof AgentReportExternalExitResultSchema>;

/**
 * DRIVING PORT
 *
 * Exposes Observer queries, handshakes, ingress reports, maintenance, and lifecycle
 * operations to external actors.
 */
export type ObserverApi = {
  health(): Promise<ObserverHealth>;
  stop(): Promise<ObserverStopReceipt>;
  getSnapshot(options?: { includeDebug?: boolean }): Promise<StationSnapshot>;
  /** Returns cached readiness unless `refresh` requests and awaits one provider probe. */
  getHarnessReadiness(params: HarnessReadinessQueryParams): Promise<HarnessReadinessQueryResult>;
  subscribe(filter?: EventFilter): AsyncIterable<StationEvent>;
  dispatch(command: StationCommand): Promise<CommandReceipt>;
  getCommand(commandId: CommandId): Promise<CommandRecord | undefined>;
  reconcile(reason?: string): Promise<ReconcileReceipt>;
  ingestProviderHookEvent(event: ProviderHookEvent): Promise<ProviderHookReceipt>;
  reportHarnessEvent(report: HarnessEventReport): Promise<HarnessEventReportReceipt>;
  prepareExternalLaunch(
    params: AgentPrepareExternalLaunchParams,
  ): Promise<AgentPrepareExternalLaunchResult>;
  reportExternalExit(params: AgentReportExternalExitParams): Promise<AgentReportExternalExitResult>;
  runDoctor(options?: DoctorOptions): Promise<DoctorReport>;
  collectDiagnostics(options?: DiagnosticCollectionOptions): Promise<DiagnosticSnapshot>;
};

// Freshness-insensitive launch reconciles: the observer may satisfy these by
// joining an in-flight observer.startup scan instead of running a new one.
export const TUI_STARTUP_RECONCILE_REASON = "tui-startup";
export const POPUP_OPEN_RECONCILE_REASON = "popup-open";
export const STARTUP_RECONCILE_REASONS = [
  TUI_STARTUP_RECONCILE_REASON,
  POPUP_OPEN_RECONCILE_REASON,
] as const;
