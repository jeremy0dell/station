import { SafeErrorSchema } from "@station/contracts";
import { z } from "zod";

/**
 * Standalone host wire contract: same NDJSON transport as observer protocol,
 * separate router/envelope so observer contracts stay free of node-pty internals.
 */
export const HOST_PROTOCOL_VERSION = 1;

const idSchema = z.string().min(1);

export const HostRequestSchema = z
  .object({
    id: idSchema,
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();
export type HostRequest = z.infer<typeof HostRequestSchema>;

export const HostResponseSchema = z.union([
  z.object({ id: idSchema, ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ id: idSchema, ok: z.literal(false), error: SafeErrorSchema }).strict(),
]);
export type HostResponse = z.infer<typeof HostResponseSchema>;

export function hostRequest(id: string, method: string, params?: unknown): HostRequest {
  return params === undefined ? { id, method } : { id, method, params };
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
}).strict();
export type HostSpawnParams = z.infer<typeof HostSpawnParamsSchema>;

export const HostSpawnResultSchema = z.object({ ptyId: idSchema, pid: z.number().int() }).strict();
export type HostSpawnResult = z.infer<typeof HostSpawnResultSchema>;

export const HostWriteParamsSchema = z.object({ ptyId: idSchema, data: z.string() }).strict();
export type HostWriteParams = z.infer<typeof HostWriteParamsSchema>;

export const HostResizeParamsSchema = z
  .object({ ptyId: idSchema, cols: z.number().int(), rows: z.number().int() })
  .strict();
export type HostResizeParams = z.infer<typeof HostResizeParamsSchema>;

export const HostOkResultSchema = z.object({ ok: z.literal(true) }).strict();
export type HostOkResult = z.infer<typeof HostOkResultSchema>;

export const HostListEntrySchema = HostPtyIdentitySchema.extend({
  ptyId: idSchema,
  pid: z.number().int(),
  alive: z.boolean(),
  cols: z.number().int(),
  rows: z.number().int(),
}).strict();
export type HostListEntry = z.infer<typeof HostListEntrySchema>;

export const HostListResultSchema = z.object({ ptys: z.array(HostListEntrySchema) }).strict();
export type HostListResult = z.infer<typeof HostListResultSchema>;

export const HostFocusParamsSchema = z.object({ ptyId: idSchema }).strict();
export type HostFocusParams = z.infer<typeof HostFocusParamsSchema>;

export const HostCloseParamsSchema = z
  .object({ ptyId: idSchema, confirm: z.literal(true) })
  .strict();
export type HostCloseParams = z.infer<typeof HostCloseParamsSchema>;

export const HostCloseResultSchema = z.object({ closed: z.boolean() }).strict();
export type HostCloseResult = z.infer<typeof HostCloseResultSchema>;

export const HostHealthResultSchema = z
  .object({ ok: z.literal(true), protocolVersion: z.number().int() })
  .strict();
export type HostHealthResult = z.infer<typeof HostHealthResultSchema>;

export const HostAttachParamsSchema = z.object({ ptyId: idSchema }).strict();
export type HostAttachParams = z.infer<typeof HostAttachParamsSchema>;

/**
 * Attach acknowledgement: the scrollback snapshot is captured atomically with
 * registering the live listener, so `scrollback ++ live frames` reproduces the
 * full output stream with no gap or overlap. Scrollback entries are the bridge's
 * data-event strings verbatim (what `StationVtScreen.feed` consumes).
 */
export const HostAttachAckSchema = z
  .object({
    subscribed: z.literal(true),
    ptyId: idSchema,
    pid: z.number().int(),
    cols: z.number().int(),
    rows: z.number().int(),
    exited: z.boolean(),
    scrollback: z.array(z.string()),
    truncated: z.boolean(),
  })
  .strict();
export type HostAttachAck = z.infer<typeof HostAttachAckSchema>;

export const HostDetachParamsSchema = z.object({ ptyId: idSchema }).strict();
export type HostDetachParams = z.infer<typeof HostDetachParamsSchema>;

export const HostFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("data"), ptyId: idSchema, data: z.string() }).strict(),
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
