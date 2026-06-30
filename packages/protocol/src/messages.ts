import {
  CommandIdSchema,
  CommandReceiptSchema,
  CommandRecordSchema,
  DiagnosticCollectionOptionsSchema,
  DiagnosticSnapshotSchema,
  DoctorOptionsSchema,
  DoctorReportSchema,
  EventFilterSchema,
  HarnessEventReportReceiptSchema,
  HarnessEventReportSchema,
  HarnessLaunchPlanSchema,
  ObserverHealthSchema,
  ObserverStopReceiptSchema,
  ProjectIdSchema,
  ProviderHookEventSchema,
  ProviderHookReceiptSchema,
  ProviderIdSchema,
  ReconcileReceiptSchema,
  SafeErrorSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  STATION_SCHEMA_VERSION,
  StationCommandSchema,
  StationEventSchema,
  StationSnapshotSchema,
  TerminalTargetIdSchema,
  WorktreeIdSchema,
} from "@station/contracts";
import { z } from "zod";

export const ProtocolMethods = [
  "observer.health",
  "observer.stop",
  "snapshot.get",
  "events.subscribe",
  "command.dispatch",
  "command.get",
  "observer.reconcile",
  "observer.ingestProviderHookEvent",
  "observer.harnessEvent.report",
  "agent.prepareExternalLaunch",
  "agent.reportExternalExit",
  "doctor.run",
  "diagnostics.collect",
] as const;

export const ProtocolMethodSchema = z.enum(ProtocolMethods);

export type ProtocolMethod = z.infer<typeof ProtocolMethodSchema>;

export const JsonRpcVersionSchema = z.literal("2.0");

export const ProtocolRequestSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    jsonrpc: JsonRpcVersionSchema,
    id: z.string().min(1),
    method: ProtocolMethodSchema,
    params: z.unknown().optional(),
  })
  .strict();

export type ProtocolRequest = z.infer<typeof ProtocolRequestSchema>;

export const ProtocolSuccessResponseSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    jsonrpc: JsonRpcVersionSchema,
    id: z.string().min(1),
    result: z.unknown(),
  })
  .strict();

export type ProtocolSuccessResponse = z.infer<typeof ProtocolSuccessResponseSchema>;

export const ProtocolErrorResponseSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    jsonrpc: JsonRpcVersionSchema,
    id: z.string().min(1),
    error: SafeErrorSchema,
  })
  .strict();

export type ProtocolErrorResponse = z.infer<typeof ProtocolErrorResponseSchema>;

export const ProtocolResponseSchema = z.union([
  ProtocolSuccessResponseSchema,
  ProtocolErrorResponseSchema,
]);

export type ProtocolResponse = z.infer<typeof ProtocolResponseSchema>;

export const ProtocolEventEnvelopeSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    event: StationEventSchema,
  })
  .strict();

export type ProtocolEventEnvelope = z.infer<typeof ProtocolEventEnvelopeSchema>;

export const ProtocolMessageSchema = z.union([
  ProtocolRequestSchema,
  ProtocolResponseSchema,
  ProtocolEventEnvelopeSchema,
]);

export const SnapshotGetParamsSchema = z
  .object({
    includeDebug: z.boolean().optional(),
  })
  .strict()
  .optional();

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

/**
 * Where a reattaching Station client picks up a persistent host-owned agent: the
 * live host PTY id, its STATION target id, and the host socket to attach to. Present
 * only behind `stationPersistentAgents` when a live host PTY exists — absent ⇒
 * the UI spawns the PTY locally from `launchPlan`.
 */
export const AgentReattachHandleSchema = z
  .object({
    ptyId: z.string().min(1),
    terminalTargetId: TerminalTargetIdSchema,
    hostSocketPath: z.string().min(1),
  })
  .strict();

export type AgentReattachHandle = z.infer<typeof AgentReattachHandleSchema>;

export const AgentPrepareExternalLaunchResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("prepared"),
      sessionId: SessionIdSchema,
      terminalTargetId: TerminalTargetIdSchema,
      launchPlan: HarnessLaunchPlanSchema,
      reattachHandle: AgentReattachHandleSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("existing-session"),
      sessionId: SessionIdSchema,
      harnessProvider: ProviderIdSchema,
      reattachHandle: AgentReattachHandleSchema.optional(),
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

export const CommandDispatchParamsSchema = z
  .object({
    command: StationCommandSchema,
  })
  .strict();

export const CommandGetParamsSchema = z
  .object({
    commandId: CommandIdSchema,
  })
  .strict();

export const ReconcileParamsSchema = z
  .object({
    reason: z.string().min(1).optional(),
  })
  .strict()
  .optional();

export const ProviderHookIngestParamsSchema = z
  .object({
    event: ProviderHookEventSchema,
  })
  .strict();

export const HarnessEventReportParamsSchema = z
  .object({
    report: HarnessEventReportSchema,
  })
  .strict();

export const EventsSubscribeParamsSchema = EventFilterSchema.optional();

export const ProtocolParamSchemas = {
  "observer.health": z.undefined().optional(),
  "observer.stop": z.undefined().optional(),
  "snapshot.get": SnapshotGetParamsSchema,
  "events.subscribe": EventsSubscribeParamsSchema,
  "command.dispatch": CommandDispatchParamsSchema,
  "command.get": CommandGetParamsSchema,
  "observer.reconcile": ReconcileParamsSchema,
  "observer.ingestProviderHookEvent": ProviderHookIngestParamsSchema,
  "observer.harnessEvent.report": HarnessEventReportParamsSchema,
  "agent.prepareExternalLaunch": AgentPrepareExternalLaunchParamsSchema,
  "agent.reportExternalExit": AgentReportExternalExitParamsSchema,
  "doctor.run": DoctorOptionsSchema,
  "diagnostics.collect": DiagnosticCollectionOptionsSchema,
} as const satisfies Record<ProtocolMethod, z.ZodTypeAny>;

export const ProtocolResultSchemas = {
  "observer.health": ObserverHealthSchema,
  "observer.stop": ObserverStopReceiptSchema,
  "snapshot.get": StationSnapshotSchema,
  "events.subscribe": z.object({ subscribed: z.literal(true) }).strict(),
  "command.dispatch": CommandReceiptSchema,
  "command.get": CommandRecordSchema.nullable(),
  "observer.reconcile": ReconcileReceiptSchema,
  "observer.ingestProviderHookEvent": ProviderHookReceiptSchema,
  "observer.harnessEvent.report": HarnessEventReportReceiptSchema,
  "agent.prepareExternalLaunch": AgentPrepareExternalLaunchResultSchema,
  "agent.reportExternalExit": AgentReportExternalExitResultSchema,
  "doctor.run": DoctorReportSchema,
  "diagnostics.collect": DiagnosticSnapshotSchema,
} as const satisfies Record<ProtocolMethod, z.ZodTypeAny>;

export function protocolRequest(
  id: string,
  method: ProtocolMethod,
  params?: unknown,
): ProtocolRequest {
  const request: {
    schemaVersion: typeof STATION_SCHEMA_VERSION;
    jsonrpc: "2.0";
    id: string;
    method: ProtocolMethod;
    params?: unknown;
  } = {
    schemaVersion: STATION_SCHEMA_VERSION,
    jsonrpc: "2.0",
    id,
    method,
  };
  const parsedParams = ProtocolParamSchemas[method].parse(params);
  if (parsedParams !== undefined) request.params = parsedParams;
  return ProtocolRequestSchema.parse(request);
}

export function protocolSuccessResponse(
  id: string,
  method: keyof typeof ProtocolResultSchemas,
  value: unknown,
): ProtocolSuccessResponse {
  const result = ProtocolResultSchemas[method].parse(value);
  return ProtocolSuccessResponseSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    jsonrpc: "2.0",
    id,
    result,
  });
}

export function protocolErrorResponse(id: string, error: unknown): ProtocolErrorResponse {
  const parsedSafeError = SafeErrorSchema.safeParse(error);
  const safeError = parsedSafeError.success
    ? parsedSafeError.data
    : protocolSafeError({ message: "Observer protocol method failed." });
  return ProtocolErrorResponseSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    jsonrpc: "2.0",
    id,
    error: safeError,
  });
}

export function protocolSocketClosedError() {
  return protocolSafeError({
    code: "PROTOCOL_SOCKET_CLOSED",
    message: "Observer socket closed before a protocol response arrived.",
  });
}

export function protocolSafeError(input: {
  tag?: string;
  code?: string;
  message: string;
  hint?: string;
}) {
  return SafeErrorSchema.parse({
    tag: input.tag ?? "ProtocolError",
    code: input.code ?? "PROTOCOL_ERROR",
    message: input.message,
    ...(input.hint === undefined ? {} : { hint: input.hint }),
  });
}
