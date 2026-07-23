import { z } from "zod";
import { StationCommandSchema } from "./commands.js";
import { SafeErrorSchema } from "./errors.js";
import {
  CommandIdSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { ProviderHealthSchema } from "./providers.js";
import { nonEmptyStringSchema } from "./shared.js";
import { SessionViewSchema, WorktreeAgentSchema, WorktreeRowSchema } from "./snapshot.js";

export const WorktreeAgentStateChangeSourceSchema = z.enum(["harness_event_report", "reconcile"]);
export type WorktreeAgentStateChangeSource = z.infer<typeof WorktreeAgentStateChangeSourceSchema>;

export const StationEventTypeSchema = z.enum([
  "observer.started",
  "observer.reconciled",
  "project.updated",
  "worktree.added",
  "worktree.updated",
  "worktree.removed",
  "worktree.agentStateChanged",
  "session.created",
  "session.updated",
  "session.removed",
  "command.accepted",
  "command.started",
  "command.succeeded",
  "command.failed",
  "provider.healthChanged",
  "providerHook.ingested",
  "harness.eventReported",
  "providerHook.spoolDrained",
]);

export type StationEventType = z.infer<typeof StationEventTypeSchema>;

const DiagnosticEventFields = {
  traceId: nonEmptyStringSchema.optional(),
  spanId: nonEmptyStringSchema.optional(),
};

export const ObserverStartedEventSchema = z
  .object({ type: z.literal("observer.started"), at: TimestampSchema })
  .strict();

export const ObserverReconciledEventSchema = z
  .object({
    type: z.literal("observer.reconciled"),
    at: TimestampSchema,
    changed: z.number().int().nonnegative(),
    ...DiagnosticEventFields,
  })
  .strict();

export const ProjectUpdatedEventSchema = z
  .object({ type: z.literal("project.updated"), projectId: ProjectIdSchema })
  .strict();

export const WorktreeAddedEventSchema = z
  .object({ type: z.literal("worktree.added"), row: WorktreeRowSchema })
  .strict();

export const WorktreeUpdatedEventSchema = z
  .object({
    type: z.literal("worktree.updated"),
    worktreeId: WorktreeIdSchema,
    patch: WorktreeRowSchema.partial(),
  })
  .strict();

export const WorktreeRemovedEventSchema = z
  .object({ type: z.literal("worktree.removed"), worktreeId: WorktreeIdSchema })
  .strict();

export const WorktreeAgentStateChangedEventSchema = z
  .object({
    type: z.literal("worktree.agentStateChanged"),
    worktreeId: WorktreeIdSchema,
    agent: WorktreeAgentSchema.optional(),
    sessionTitle: nonEmptyStringSchema.optional(),
    changeSource: WorktreeAgentStateChangeSourceSchema.optional(),
    harnessEventType: nonEmptyStringSchema.optional(),
    reportId: nonEmptyStringSchema.optional(),
  })
  .strict();

export const SessionCreatedEventSchema = z
  .object({ type: z.literal("session.created"), session: SessionViewSchema })
  .strict();

export const SessionUpdatedEventSchema = z
  .object({
    type: z.literal("session.updated"),
    sessionId: SessionIdSchema,
    patch: SessionViewSchema.partial(),
  })
  .strict();

export const SessionRemovedEventSchema = z
  .object({ type: z.literal("session.removed"), sessionId: SessionIdSchema })
  .strict();

export const CommandAcceptedEventSchema = z
  .object({
    type: z.literal("command.accepted"),
    commandId: CommandIdSchema,
    command: StationCommandSchema,
    ...DiagnosticEventFields,
  })
  .strict();

export const CommandStartedEventSchema = z
  .object({
    type: z.literal("command.started"),
    commandId: CommandIdSchema,
    command: StationCommandSchema,
    ...DiagnosticEventFields,
  })
  .strict();

export const CommandSucceededEventSchema = z
  .object({
    type: z.literal("command.succeeded"),
    commandId: CommandIdSchema,
    ...DiagnosticEventFields,
  })
  .strict();

export const CommandFailedEventSchema = z
  .object({
    type: z.literal("command.failed"),
    commandId: CommandIdSchema,
    error: SafeErrorSchema,
    ...DiagnosticEventFields,
  })
  .strict();

export const ProviderHealthChangedEventSchema = z
  .object({
    type: z.literal("provider.healthChanged"),
    provider: ProviderIdSchema,
    health: ProviderHealthSchema,
  })
  .strict();

export const ProviderHookIngestedEventSchema = z
  .object({
    type: z.literal("providerHook.ingested"),
    at: TimestampSchema,
    hookId: nonEmptyStringSchema,
    provider: ProviderIdSchema,
    event: nonEmptyStringSchema,
  })
  .strict();

export const HarnessEventReportedEventSchema = z
  .object({
    type: z.literal("harness.eventReported"),
    at: TimestampSchema,
    reportId: nonEmptyStringSchema,
    provider: ProviderIdSchema,
    eventType: nonEmptyStringSchema,
  })
  .strict();

export const ProviderHookSpoolDrainedEventSchema = z
  .object({
    type: z.literal("providerHook.spoolDrained"),
    at: TimestampSchema,
    drained: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();

export const StationEventSchema = z.discriminatedUnion("type", [
  ObserverStartedEventSchema,
  ObserverReconciledEventSchema,
  ProjectUpdatedEventSchema,
  WorktreeAddedEventSchema,
  WorktreeUpdatedEventSchema,
  WorktreeRemovedEventSchema,
  WorktreeAgentStateChangedEventSchema,
  SessionCreatedEventSchema,
  SessionUpdatedEventSchema,
  SessionRemovedEventSchema,
  CommandAcceptedEventSchema,
  CommandStartedEventSchema,
  CommandSucceededEventSchema,
  CommandFailedEventSchema,
  ProviderHealthChangedEventSchema,
  ProviderHookIngestedEventSchema,
  HarnessEventReportedEventSchema,
  ProviderHookSpoolDrainedEventSchema,
]);

export type StationEvent = z.infer<typeof StationEventSchema>;

export type StationEventMetadata = {
  commandId?: z.infer<typeof CommandIdSchema>;
  traceId?: string;
  timestamp?: string;
};

export function stationEventMetadata(event: StationEvent): StationEventMetadata {
  switch (event.type) {
    case "command.accepted":
    case "command.started":
    case "command.succeeded":
    case "command.failed": {
      const metadata: StationEventMetadata = {
        commandId: event.commandId,
      };
      if (event.traceId !== undefined) {
        metadata.traceId = event.traceId;
      }
      return metadata;
    }
    case "observer.reconciled": {
      const metadata: StationEventMetadata = {
        timestamp: event.at,
      };
      if (event.traceId !== undefined) {
        metadata.traceId = event.traceId;
      }
      return metadata;
    }
    case "observer.started":
    case "providerHook.ingested":
    case "harness.eventReported":
    case "providerHook.spoolDrained":
      return {
        timestamp: event.at,
      };
    case "project.updated":
    case "worktree.added":
    case "worktree.updated":
    case "worktree.removed":
    case "worktree.agentStateChanged":
    case "session.created":
    case "session.updated":
    case "session.removed":
    case "provider.healthChanged":
      return {};
  }
}

export function stationEventCommandId(
  event: StationEvent,
): z.infer<typeof CommandIdSchema> | undefined {
  return stationEventMetadata(event).commandId;
}

export function stationEventTraceId(event: StationEvent): string | undefined {
  return stationEventMetadata(event).traceId;
}

export function stationEventTimestamp(event: StationEvent): string | undefined {
  return stationEventMetadata(event).timestamp;
}

export const EventFilterSchema = z
  .object({
    type: z.union([StationEventTypeSchema, z.array(StationEventTypeSchema).min(1)]).optional(),
    commandId: CommandIdSchema.optional(),
    traceId: nonEmptyStringSchema.optional(),
    since: TimestampSchema.optional(),
  })
  .strict();

export type EventFilter = z.infer<typeof EventFilterSchema>;
