import { z } from "zod";
import { SafeErrorSchema } from "./errors.js";
import { ProviderIdSchema, SchemaVersionSchema, TimestampSchema } from "./ids.js";
import { ProviderHealthSchema } from "./providers.js";
import { nonEmptyStringSchema } from "./shared.js";
import { StationSnapshotSchema } from "./snapshot.js";

export const ObserverHealthStatusSchema = z.enum(["healthy", "degraded", "unavailable"]);

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

// Freshness-insensitive launch reconciles: the observer may satisfy these by
// joining an in-flight observer.startup scan instead of running a new one.
export const TUI_STARTUP_RECONCILE_REASON = "tui-startup";
export const POPUP_OPEN_RECONCILE_REASON = "popup-open";
export const STARTUP_RECONCILE_REASONS = [
  TUI_STARTUP_RECONCILE_REASON,
  POPUP_OPEN_RECONCILE_REASON,
] as const;
