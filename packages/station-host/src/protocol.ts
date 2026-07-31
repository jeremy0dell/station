import { SafeErrorSchema, TerminalOutputCompatibilitySchema } from "@station/contracts";
import { z } from "zod";

/**
 * Standalone host wire contract: same NDJSON transport as observer protocol,
 * separate router/envelope so observer contracts stay free of node-pty internals.
 */
export const HOST_PROTOCOL_VERSION = 6;

const idSchema = z.string().min(1);
const RIS = "\x1bc";

export const HostRequestSchema = z
  .object({
    id: idSchema,
    method: z.string().min(1),
    params: z.unknown().optional(),
    protocolVersion: z.number().int().optional(),
    buildVersion: z.string().min(1).optional(),
  })
  .strict();
export type HostRequest = z.infer<typeof HostRequestSchema>;

/** Exact client identity carried by operational requests so the host can reject old callers. */
export type HostClientIdentity = {
  protocolVersion: number;
  buildVersion: string;
};

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
    request.protocolVersion = client.protocolVersion;
    request.buildVersion = client.buildVersion;
  }
  return request;
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
 * Launch metadata echoed by `host.list`, not agent state; the provider uses it
 * to rebuild terminal observations after restart. `kind` defaults to `agent` for
 * old entries, with no protocol bump because host and clients ship together.
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

export const HostSpawnResultSchema = z.object({ ptyId: idSchema, pid: z.number().int() }).strict();
export type HostSpawnResult = z.infer<typeof HostSpawnResultSchema>;

export const HostWriteParamsSchema = z.object({ ptyId: idSchema, data: z.string() }).strict();
export const HostResizeParamsSchema = z
  .object({ ptyId: idSchema, cols: z.number().int(), rows: z.number().int() })
  .strict();
export const HostOkResultSchema = z.object({ ok: z.literal(true) }).strict();
export const HostListEntrySchema = HostPtyIdentitySchema.extend({
  ptyId: idSchema,
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

/** Classify opaque build versions without inferring SemVer compatibility. */
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

export const HostAttachParamsSchema = z.object({ ptyId: idSchema }).strict();
export type HostAttachParams = z.infer<typeof HostAttachParamsSchema>;

export const HostReplayDataEventSchema = z
  .object({ type: z.literal("data"), data: z.string() })
  .strict();
export const HostReplayResizeEventSchema = z
  .object({
    type: z.literal("resize"),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  })
  .strict();
const HostSemanticCopyRowSchema = z
  .object({
    row: z.number().int().min(0).max(1_000_000),
    leadingColumns: z.number().int().min(0).max(1_000_000),
    separatorSpaces: z.number().int().min(0).max(1024),
  })
  .strict();
const HostSemanticCopyRowsSchema = z
  .array(HostSemanticCopyRowSchema)
  .max(20_000)
  .superRefine((rows, context) => {
    const seen = new Set<number>();
    for (const [index, row] of rows.entries()) {
      if (seen.has(row.row)) {
        context.addIssue({
          code: "custom",
          path: [index, "row"],
          message: "Semantic-copy buffer rows must be unique.",
        });
      }
      seen.add(row.row);
    }
  });
export const HostReplaySemanticCopyEventSchema = z
  .object({
    type: z.literal("semantic-copy"),
    normal: HostSemanticCopyRowsSchema,
    alternate: HostSemanticCopyRowsSchema,
  })
  .strict();
export const HostReplayEventSchema = z.discriminatedUnion("type", [
  HostReplayDataEventSchema,
  HostReplayResizeEventSchema,
  HostReplaySemanticCopyEventSchema,
]);
export type HostReplayEvent = z.infer<typeof HostReplayEventSchema>;

const HostRawReplayEventSchema = z.discriminatedUnion("type", [
  HostReplayDataEventSchema,
  HostReplayResizeEventSchema,
]);
const HostSemanticRecoveryEventsSchema = z
  .array(
    z.discriminatedUnion("type", [HostReplayDataEventSchema, HostReplaySemanticCopyEventSchema]),
  )
  .min(2)
  .superRefine((events, context) => {
    const hasEarlySidecar = events.slice(0, -1).some((event) => event.type === "semantic-copy");
    if (hasEarlySidecar || events.at(-1)?.type !== "semantic-copy") {
      context.addIssue({
        code: "custom",
        message: "Semantic recovery requires exactly one final semantic-copy event.",
      });
    }
  });

/**
 * Verbatim history, exact semantic restoration, or a control-only degraded
 * reset captured at the Host's semantic boundary. Exact semantic recovery ends
 * with one content-free semantic-copy sidecar after serialized VT; raw replay
 * carries the original OSC bytes and must not duplicate that sidecar. Live reset
 * never carries historical events, and its reset data must begin with RIS.
 */
export const HostReplaySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("raw-complete"),
      initialCols: z.number().int().positive(),
      initialRows: z.number().int().positive(),
      events: z.array(HostRawReplayEventSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("semantic-truncation-recovery"),
      initialCols: z.number().int().positive(),
      initialRows: z.number().int().positive(),
      events: HostSemanticRecoveryEventsSchema,
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
export type HostReplay = z.infer<typeof HostReplaySchema>;

/**
 * Attach acknowledgement captured atomically with the live listener. Raw replay
 * preserves production geometry; exact semantic recovery restores its terminal
 * data and copy sidecar in order, while control-only reset recovery begins at the
 * Host's current geometry before the client geometry nudge.
 */
export const HostAttachAckSchema = z
  .object({
    subscribed: z.literal(true),
    ptyId: idSchema,
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

export const HostDetachParamsSchema = z.object({ ptyId: idSchema }).strict();
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
