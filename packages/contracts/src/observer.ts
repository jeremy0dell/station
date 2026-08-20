import { z } from "zod";
import type { CommandReceipt, CommandRecord, StationCommand } from "./commands.js";
import { FreshSessionGroupPlacementIntentSchema, RemoveWorktreePayloadSchema } from "./commands.js";
import type {
  DiagnosticCollectionOptions,
  DiagnosticSnapshot,
  DoctorOptions,
  DoctorReport,
} from "./diagnostics.js";
import { SafeErrorSchema } from "./errors.js";
import type { EventFilter, StationEvent } from "./events.js";
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
  TerminalOutputCompatibilitySchema,
} from "./providers.js";
import type { ObserverRepairInventory } from "./repair.js";
import type { SessionRecoveryReadiness } from "./sessionRecovery.js";
import { nonEmptyStringSchema, userFacingTitleSchema } from "./shared.js";
import { type StationSnapshot, StationSnapshotSchema } from "./snapshot.js";

export const ObserverHealthStatusSchema = z.enum(["healthy", "degraded", "unavailable"]);

/** Opaque UUID v4 minted for one Observer launch and published in argv and its pidfile. */
export const ObserverProcessTokenSchema = z
  .uuid()
  .refine((value) => value[14]?.toLowerCase() === "4", "Expected an Observer UUID v4 token.");

export const ObserverProcessIdentitySchema = z
  .object({
    pid: z.number().int().positive(),
    osStartTime: nonEmptyStringSchema,
    processToken: ObserverProcessTokenSchema,
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
    title: userFacingTitleSchema.optional(),
    group: FreshSessionGroupPlacementIntentSchema.optional(),
  })
  .strict();

export type AgentPrepareExternalLaunchParams = z.infer<
  typeof AgentPrepareExternalLaunchParamsSchema
>;

const AgentPreparedExternalLaunchBaseSchema = z.object({
  kind: z.literal("prepared"),
  sessionId: SessionIdSchema,
  terminalTargetId: TerminalTargetIdSchema,
  terminalBindingToken: nonEmptyStringSchema.optional(),
  launchPlan: HarnessLaunchPlanSchema,
});

export const AgentPrepareExternalLaunchResultSchema = z.union([
  AgentPreparedExternalLaunchBaseSchema.extend({
    attachment: ManagedTerminalAttachmentSchema.optional(),
    outputCompatibility: z.never().optional(),
  }).strict(),
  AgentPreparedExternalLaunchBaseSchema.extend({
    attachment: z.never().optional(),
    outputCompatibility: TerminalOutputCompatibilitySchema.optional(),
  }).strict(),
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
    expectedSessionId: SessionIdSchema.optional(),
    expectedBindingToken: nonEmptyStringSchema.optional(),
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

export const WorktreePrepareRemovalParamsSchema = RemoveWorktreePayloadSchema.omit({
  removalReservationId: true,
});

export type WorktreePrepareRemovalParams = z.infer<typeof WorktreePrepareRemovalParamsSchema>;

export const WorktreePrepareRemovalResultSchema = z
  .object({
    reservationId: nonEmptyStringSchema,
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    externalTerminalExitRequired: z.boolean(),
  })
  .strict();

export type WorktreePrepareRemovalResult = z.infer<typeof WorktreePrepareRemovalResultSchema>;

export const WorktreeCancelRemovalParamsSchema = z
  .object({ reservationId: nonEmptyStringSchema })
  .strict();

export type WorktreeCancelRemovalParams = z.infer<typeof WorktreeCancelRemovalParamsSchema>;

export const WorktreeCancelRemovalResultSchema = z.object({ cancelled: z.boolean() }).strict();

export type WorktreeCancelRemovalResult = z.infer<typeof WorktreeCancelRemovalResultSchema>;

/**
 * DRIVING PORT
 *
 * Exposes Observer state, recovery-readiness, and read-only repair inspection queries,
 * handshakes, ingress reports, maintenance, and lifecycle operations to external actors.
 */
export type ObserverApi = {
  health(): Promise<ObserverHealth>;
  stop(): Promise<ObserverStopReceipt>;
  getSnapshot(options?: { includeDebug?: boolean }): Promise<StationSnapshot>;
  getSessionRecoveryReadiness(): Promise<SessionRecoveryReadiness>;
  inspectRepairInventory(): Promise<ObserverRepairInventory>;
  subscribe(filter?: EventFilter): AsyncIterable<StationEvent>;
  dispatch(command: StationCommand): Promise<CommandReceipt>;
  getCommand(commandId: CommandId): Promise<CommandRecord | undefined>;
  reconcile(reason?: string): Promise<ReconcileReceipt>;
  ingestProviderHookEvent(event: ProviderHookEvent): Promise<ProviderHookReceipt>;
  reportHarnessEvent(report: HarnessEventReport): Promise<HarnessEventReportReceipt>;
  /** Prepares either an attachable managed process or a caller-owned local launch. */
  prepareExternalLaunch(
    params: AgentPrepareExternalLaunchParams,
  ): Promise<AgentPrepareExternalLaunchResult>;
  reportExternalExit(params: AgentReportExternalExitParams): Promise<AgentReportExternalExitResult>;
  /** Validate and reserve one worktree before a renderer settles externally owned PTYs. */
  prepareWorktreeRemoval(
    params: WorktreePrepareRemovalParams,
  ): Promise<WorktreePrepareRemovalResult>;
  /** Release an unused worktree-removal reservation after renderer preparation fails. */
  cancelWorktreeRemoval(params: WorktreeCancelRemovalParams): Promise<WorktreeCancelRemovalResult>;
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
