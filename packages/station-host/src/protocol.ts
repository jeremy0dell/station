import {
  HostHandoffFidelitySchema,
  PtyHandoffManifestSchema,
  PtyInstanceIdSchema,
  SafeErrorSchema,
  TerminalOutputCompatibilitySchema,
  UiLifecycleDetachReasonSchema,
  UiRunContextSchema,
} from "@station/contracts";
import { z } from "zod";

/**
 * Standalone host wire contract: same NDJSON transport as observer protocol,
 * separate router/envelope so observer contracts stay free of node-pty internals.
 */
export const HOST_PROTOCOL_VERSION = 7;

const idSchema = z.string().min(1);
const RIS = "\x1bc";

/** Wire/build identity used only for guarded Host compatibility decisions. */
export const HostCompatibilityIdentitySchema = z
  .object({
    protocolVersion: z.number().int(),
    buildVersion: z.string().min(1),
  })
  .strict();
export type HostCompatibilityIdentity = z.infer<typeof HostCompatibilityIdentitySchema>;

/** Content-free UI and connection identity used only for lifecycle correlation. */
export const HostCorrelationIdentitySchema = UiRunContextSchema.extend({
  connectionId: idSchema,
}).strict();
export type HostCorrelationIdentity = z.infer<typeof HostCorrelationIdentitySchema>;

/** Compatibility and diagnostic correlation carried on every operational Host request. */
export const HostClientIdentitySchema = HostCompatibilityIdentitySchema.merge(
  HostCorrelationIdentitySchema,
).strict();
export type HostClientIdentity = z.infer<typeof HostClientIdentitySchema>;

export const HostRequestSchema = z
  .object({
    id: idSchema,
    method: z.string().min(1),
    params: z.unknown().optional(),
    client: HostClientIdentitySchema.optional(),
  })
  .strict();
export type HostRequest = z.infer<typeof HostRequestSchema>;

/** One-way normal-shutdown notice; the server must not write a response. */
export const HostClientShutdownNotificationSchema = z
  .object({
    method: z.literal("host.clientShutdown"),
    client: HostClientIdentitySchema,
  })
  .strict();
export type HostClientShutdownNotification = z.infer<typeof HostClientShutdownNotificationSchema>;

export const HostResponseSchema = z.union([
  z.object({ id: idSchema, ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ id: idSchema, ok: z.literal(false), error: SafeErrorSchema }).strict(),
]);
export type HostResponse = z.infer<typeof HostResponseSchema>;

export function hostRequest(
  id: string,
  method: string,
  params?: unknown,
  client?: HostClientIdentity,
): HostRequest {
  const request: HostRequest = params === undefined ? { id, method } : { id, method, params };
  if (client !== undefined) {
    request.client = client;
  }
  return request;
}

export function hostClientShutdownNotification(
  client: HostClientIdentity,
): HostClientShutdownNotification {
  return { method: "host.clientShutdown", client };
}

export function hostSuccess(id: string, result: unknown): HostResponse {
  return { id, ok: true, result };
}

export function hostFailure(id: string, error: z.infer<typeof SafeErrorSchema>): HostResponse {
  return { id, ok: false, error };
}

/**
 * Observer rebuilds only `agent` PTYs into terminal targets; `aux` PTYs are
 * Station-owned shells and must remain UI-local.
 */
export const HostPtyKindSchema = z.enum(["agent", "aux"]);
export type HostPtyKind = z.infer<typeof HostPtyKindSchema>;

/**
 * Immutable launch identity echoed by spawn, list, and attach acknowledgement.
 * `kind` defaults only at the spawn input boundary for caller convenience.
 */
export const HostPtyIdentitySchema = z
  .object({
    kind: HostPtyKindSchema.default("agent"),
    terminalTargetId: idSchema,
    worktreeId: idSchema,
    projectId: idSchema,
    sessionId: idSchema,
    worktreePath: idSchema,
    harnessProvider: idSchema,
  })
  .strict();
export type HostPtyIdentity = z.infer<typeof HostPtyIdentitySchema>;

const HostPtyWireIdentitySchema = HostPtyIdentitySchema.extend({
  kind: HostPtyKindSchema,
}).strict();

/** Canonical reference to one immutable Host PTY lifetime. */
export const HostPtyRefSchema = z
  .object({
    terminalTargetId: idSchema,
    ptyId: idSchema,
    ptyInstanceId: PtyInstanceIdSchema,
  })
  .strict();
export type HostPtyRef = z.infer<typeof HostPtyRefSchema>;

export function isSameHostPtyRef(left: HostPtyRef, right: HostPtyRef): boolean {
  return (
    left.terminalTargetId === right.terminalTargetId &&
    left.ptyId === right.ptyId &&
    left.ptyInstanceId === right.ptyInstanceId
  );
}

export const HostSpawnParamsSchema = HostPtyIdentitySchema.extend({
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  outputCompatibility: TerminalOutputCompatibilitySchema.optional(),
}).strict();
export type HostSpawnParams = z.infer<typeof HostSpawnParamsSchema>;

/** Spawn returns the exact reference callers must retain for every later attach. */
export const HostSpawnResultSchema = HostPtyRefSchema.extend({ pid: z.number().int() }).strict();
export type HostSpawnResult = z.infer<typeof HostSpawnResultSchema>;

export const HostWriteParamsSchema = z.object({ ptyId: idSchema, data: z.string() }).strict();
export const HostResizeParamsSchema = z
  .object({ ptyId: idSchema, cols: z.number().int(), rows: z.number().int() })
  .strict();
export const HostOkResultSchema = z.object({ ok: z.literal(true) }).strict();
/** Live inventory entry whose reference and immutable identity derive from one table entry. */
export const HostListEntrySchema = HostPtyWireIdentitySchema.extend({
  ptyId: idSchema,
  ptyInstanceId: PtyInstanceIdSchema,
  pid: z.number().int(),
  alive: z.boolean(),
  cols: z.number().int(),
  rows: z.number().int(),
}).strict();
export type HostListEntry = z.infer<typeof HostListEntrySchema>;

export const HostListResultSchema = z.object({ ptys: z.array(HostListEntrySchema) }).strict();
export const HostFocusParamsSchema = z.object({ ptyId: idSchema }).strict();
export const HostCloseParamsSchema = z
  .object({ ptyId: idSchema, confirm: z.literal(true) })
  .strict();
export const HostCloseResultSchema = z.object({ closed: z.boolean() }).strict();
export const HostHealthResultSchema = z
  .object({
    ok: z.literal(true),
    protocolVersion: z.number().int(),
    buildVersion: z.string().min(1).optional(),
  })
  .strict();
export type HostHealthResult = z.infer<typeof HostHealthResultSchema>;

/** The only three actions allowed by the host protocol/build compatibility policy. */
export type HostCompatibility =
  | { action: "reuse" }
  | { action: "replace"; runningBuildVersion: string }
  | { action: "refuse"; reason: "protocol-mismatch" | "legacy-health" };

/**
 * POLICY
 *
 * Decide host reuse, idle replace eligibility, or refuse from opaque health
 * without inferring SemVer compatibility. Live handoff is only considered when
 * this returns `replace`; protocol mismatch stays a visible refuse.
 */
export function classifyHostCompatibility(
  health: HostHealthResult,
  expectedBuildVersion: string,
): HostCompatibility {
  if (health.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return { action: "refuse", reason: "protocol-mismatch" };
  }
  if (health.buildVersion === undefined) {
    return { action: "refuse", reason: "legacy-health" };
  }
  if (health.buildVersion === expectedBuildVersion) {
    return { action: "reuse" };
  }
  return { action: "replace", runningBuildVersion: health.buildVersion };
}

export const HostStopIfIdleParamsSchema = z
  .object({ requestingBuildVersion: z.string().min(1) })
  .strict();
export const HostStopIfIdleResultSchema = z.object({ stopping: z.literal(true) }).strict();
export type HostStopIfIdleResult = z.infer<typeof HostStopIfIdleResultSchema>;

export const HostBeginHandoffParamsSchema = z
  .object({
    requestingBuildVersion: z.string().min(1),
    fidelity: HostHandoffFidelitySchema.default("processes"),
  })
  .strict();
export type HostBeginHandoffParams = z.infer<typeof HostBeginHandoffParamsSchema>;

export const HostBeginHandoffResultSchema = z
  .object({
    manifest: PtyHandoffManifestSchema,
    fidelity: HostHandoffFidelitySchema,
    released: z.array(z.string().min(1)),
    skipped: z.array(
      z
        .object({
          ptyId: z.string().min(1),
          reason: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type HostBeginHandoffResult = z.infer<typeof HostBeginHandoffResultSchema>;

export const HostCompleteHandoffResultSchema = z.object({ stopping: z.literal(true) }).strict();
export type HostCompleteHandoffResult = z.infer<typeof HostCompleteHandoffResultSchema>;

export const HostAbortHandoffResultSchema = z
  .object({
    adopted: z.array(z.string().min(1)),
    failed: z.array(
      z
        .object({
          ptyId: z.string().min(1),
          reason: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type HostAbortHandoffResult = z.infer<typeof HostAbortHandoffResultSchema>;

export const HostAdoptRegistryParamsSchema = z
  .object({
    manifest: PtyHandoffManifestSchema,
  })
  .strict();
export type HostAdoptRegistryParams = z.infer<typeof HostAdoptRegistryParamsSchema>;

export const HostAdoptRegistryResultSchema = HostAbortHandoffResultSchema;
export type HostAdoptRegistryResult = z.infer<typeof HostAdoptRegistryResultSchema>;

/** Exact PTY-lifetime reference plus per-attempt lifecycle correlation. */
export const HostAttachParamsSchema = HostPtyRefSchema.extend({ attachmentId: idSchema }).strict();
export type HostAttachParams = z.infer<typeof HostAttachParamsSchema>;

export const HostReplayDataEventSchema = z
  .object({ type: z.literal("data"), data: z.string() })
  .strict();
export const HostReplayEventSchema = z.discriminatedUnion("type", [
  HostReplayDataEventSchema,
  z
    .object({
      type: z.literal("resize"),
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    })
    .strict(),
]);
export type HostReplayEvent = z.infer<typeof HostReplayEventSchema>;

/**
 * Verbatim history, exact semantic restoration, or a control-only degraded
 * reset captured at the Host's semantic boundary. Live reset never carries
 * historical events, begins with RIS, and establishes a valid active-buffer
 * cursor anchor before the client requests repaint.
 */
export const HostReplaySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("raw-complete"),
      initialCols: z.number().int().positive(),
      initialRows: z.number().int().positive(),
      events: z.array(HostReplayEventSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("semantic-truncation-recovery"),
      initialCols: z.number().int().positive(),
      initialRows: z.number().int().positive(),
      events: z.array(HostReplayDataEventSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("live-reset-recovery"),
      initialCols: z.number().int().positive(),
      initialRows: z.number().int().positive(),
      events: z.array(HostReplayEventSchema).length(0),
      resetData: z.string().startsWith(RIS),
    })
    .strict(),
]);
/**
 * Attach acknowledgement captured atomically with the live listener and echoing
 * the exact PTY reference plus immutable identity. Raw replay
 * preserves production geometry; exact semantic and control-only reset recovery
 * both begin at the Host's current geometry, with reset recovery anchored before
 * the client geometry nudge.
 */
export const HostAttachAckSchema = HostPtyWireIdentitySchema.merge(HostPtyRefSchema)
  .extend({
    subscribed: z.literal(true),
    pid: z.number().int(),
    cols: z.number().int(),
    rows: z.number().int(),
    exited: z.boolean(),
    replay: HostReplaySchema,
  })
  .strict()
  .superRefine((ack, context) => {
    let replayCols = ack.replay.initialCols;
    let replayRows = ack.replay.initialRows;
    for (const event of ack.replay.events) {
      if (event.type === "resize") {
        replayCols = event.cols;
        replayRows = event.rows;
      }
    }
    if (replayCols !== ack.cols || replayRows !== ack.rows) {
      context.addIssue({
        code: "custom",
        path: ["replay"],
        message: "Replay must end at the Host's current geometry.",
      });
    }
  });
export type HostAttachAck = z.infer<typeof HostAttachAckSchema>;

export const HostDetachParamsSchema = z
  .object({
    ptyId: idSchema,
    attachmentId: idSchema,
    reason: UiLifecycleDetachReasonSchema.extract(["explicit_detach", "client_shutdown"]),
  })
  .strict();
export const HostFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("data"), ptyId: idSchema, data: z.string() }).strict(),
  z
    .object({
      type: z.literal("resize"),
      ptyId: idSchema,
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("exit"),
      ptyId: idSchema,
      exitCode: z.number().int().nullable(),
      signal: z.number().int().nullable().optional(),
    })
    .strict(),
  z.object({ type: z.literal("focus"), ptyId: idSchema }).strict(),
]);
export type HostFrame = z.infer<typeof HostFrameSchema>;
export type HostExitFrame = Extract<HostFrame, { type: "exit" }>;
