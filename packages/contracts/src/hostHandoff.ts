import { z } from "zod";
import {
  ProjectIdSchema,
  SessionIdSchema,
  TerminalTargetIdSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { nonEmptyStringSchema } from "./shared.js";

/**
 * Handoff payloads for transferring live host PTY ownership between builds.
 * The per-terminal bridge writes its park state and the host writes scrollback
 * exports as durable files, so both shapes parse here with strict schemas.
 */

export const PtyBridgeProtocolVersion = 2;
export const PtyBridgeProtocolVersionSchema = z.literal(PtyBridgeProtocolVersion);

/** Opaque identity generated once for one PTY lifetime and preserved across Host ownership changes. */
export const PtyInstanceIdSchema = nonEmptyStringSchema;
export type PtyInstanceId = z.infer<typeof PtyInstanceIdSchema>;

export const PtyHandoffKindSchema = z.enum(["agent", "aux"]);
/**
 * Launch metadata round-tripped through the handoff manifest and the bridge
 * park state; mirrors the host's PTY identity so adoption can rebuild entries
 * without the old host's in-memory table.
 */
export const PtyHandoffIdentitySchema = z
  .object({
    kind: PtyHandoffKindSchema.default("agent"),
    terminalTargetId: TerminalTargetIdSchema,
    worktreeId: WorktreeIdSchema,
    projectId: ProjectIdSchema,
    sessionId: SessionIdSchema,
    worktreePath: nonEmptyStringSchema,
    harnessProvider: nonEmptyStringSchema,
  })
  .strict();
export type PtyHandoffIdentity = z.infer<typeof PtyHandoffIdentitySchema>;

/** Composable handoff fidelity; `screen` never blocks when capture is unavailable. */
export const HostHandoffFidelitySchema = z.enum(["processes", "screen"]);
export type HostHandoffFidelity = z.infer<typeof HostHandoffFidelitySchema>;

export const PtyHandoffEntrySchema = z
  .object({
    bridgeProtocolVersion: PtyBridgeProtocolVersionSchema,
    bridgePid: z.number().int().positive(),
    controlSocket: nonEmptyStringSchema,
    command: nonEmptyStringSchema,
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    /** Immutable PTY-lifetime identity preserved by negotiated and crash adoption. */
    ptyInstanceId: PtyInstanceIdSchema,
    identity: PtyHandoffIdentitySchema,
    scrollbackRef: nonEmptyStringSchema.optional(),
    ringComplete: z.boolean().optional(),
    /** Best-effort semantic snapshot path; absence degrades to scrollback replay. */
    screenSnapshotRef: nonEmptyStringSchema.optional(),
  })
  .strict();
export type PtyHandoffEntry = z.infer<typeof PtyHandoffEntrySchema>;

/** ptyId to entry; every independent PTY and bridge identity is unique within one manifest. */
export const PtyHandoffManifestSchema = z
  .record(nonEmptyStringSchema, PtyHandoffEntrySchema)
  .superRefine((manifest, context) => {
    const targets = new Set<string>();
    const ptyInstances = new Set<string>();
    const controlSockets = new Set<string>();
    const bridgePids = new Set<number>();
    for (const [ptyId, entry] of Object.entries(manifest)) {
      if (targets.has(entry.identity.terminalTargetId)) {
        context.addIssue({
          code: "custom",
          path: [ptyId, "identity", "terminalTargetId"],
          message: "A handoff manifest cannot contain duplicate terminal targets.",
        });
      }
      targets.add(entry.identity.terminalTargetId);
      if (ptyInstances.has(entry.ptyInstanceId)) {
        context.addIssue({
          code: "custom",
          path: [ptyId, "ptyInstanceId"],
          message: "A handoff manifest cannot contain duplicate PTY instance ids.",
        });
      }
      ptyInstances.add(entry.ptyInstanceId);
      if (controlSockets.has(entry.controlSocket)) {
        context.addIssue({
          code: "custom",
          path: [ptyId, "controlSocket"],
          message: "A handoff manifest cannot contain duplicate bridge control sockets.",
        });
      }
      controlSockets.add(entry.controlSocket);
      if (bridgePids.has(entry.bridgePid)) {
        context.addIssue({
          code: "custom",
          path: [ptyId, "bridgePid"],
          message: "A handoff manifest cannot contain duplicate bridge process ids.",
        });
      }
      bridgePids.add(entry.bridgePid);
    }
  });
export type PtyHandoffManifest = z.infer<typeof PtyHandoffManifestSchema>;

/** Serialized semantic restore sequences captured at handoff time. */
export const PtyScreenSnapshotSchema = z
  .object({
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    sequences: z.array(z.string()).min(1),
  })
  .strict();
export type PtyScreenSnapshot = z.infer<typeof PtyScreenSnapshotSchema>;

/**
 * Durable park state written atomically by an orphaned bridge; a fresh host
 * reads it to distinguish live parked bridges from stale files on startup.
 */
export const PtyBridgeParkStateSchema = z
  .object({
    v: z.literal(2),
    bridgePid: z.number().int().positive(),
    pid: z.number().int().positive(),
    controlSocket: nonEmptyStringSchema,
    command: nonEmptyStringSchema,
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    /** Immutable PTY-lifetime identity echoed by the parked bridge. */
    ptyInstanceId: PtyInstanceIdSchema,
    identity: PtyHandoffIdentitySchema,
    orphanedAtMs: z.number().int().nonnegative(),
    ttlMs: z.number().int().positive(),
    heartbeatAtMs: z.number().int().nonnegative(),
    exited: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.number().int().optional(),
  })
  .strict();
export type PtyBridgeParkState = z.infer<typeof PtyBridgeParkStateSchema>;

/** Strict ownership request accepted by a parked PTY bridge. */
export const PtyBridgeAdoptCommandSchema = z
  .object({
    type: z.literal("adopt"),
    ptyInstanceId: PtyInstanceIdSchema,
  })
  .strict();
/** Read-only parked-bridge liveness and identity probe. */
export const PtyBridgeStatusCommandSchema = z.object({ type: z.literal("exit-status") }).strict();
/** Strict bridge control status; ownership changes only after its PTY instance is verified. */
export const PtyBridgeStatusSchema = z
  .object({
    type: z.literal("status"),
    bridgeProtocol: PtyBridgeProtocolVersionSchema,
    ptyInstanceId: PtyInstanceIdSchema,
    pid: z.number().int().positive(),
    bridgePid: z.number().int().positive(),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    adopted: z.boolean(),
    exited: z.boolean(),
    parkedEvicted: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.number().int().optional(),
  })
  .strict();
export type PtyBridgeStatus = z.infer<typeof PtyBridgeStatusSchema>;

/** Strict successful ownership acknowledgement; parked probe statuses remain valid separately. */
export const PtyBridgeAdoptionAckSchema = PtyBridgeStatusSchema.extend({
  adopted: z.literal(true),
}).strict();
export type PtyBridgeAdoptionAck = z.infer<typeof PtyBridgeAdoptionAckSchema>;

export const PtyScrollbackDataEventSchema = z
  .object({ type: z.literal("data"), data: z.string() })
  .strict();
export const PtyScrollbackResizeEventSchema = z
  .object({
    type: z.literal("resize"),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  })
  .strict();
export const PtyScrollbackEventSchema = z.discriminatedUnion("type", [
  PtyScrollbackDataEventSchema,
  PtyScrollbackResizeEventSchema,
]);
/** A host's scrollback ring snapshot persisted beside the parked bridge. */
export const PtyScrollbackExportSchema = z
  .object({
    initialCols: z.number().int().positive(),
    initialRows: z.number().int().positive(),
    complete: z.boolean(),
    events: z.array(PtyScrollbackEventSchema),
  })
  .strict();
export type PtyScrollbackExport = z.infer<typeof PtyScrollbackExportSchema>;
