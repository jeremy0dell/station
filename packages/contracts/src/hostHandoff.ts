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

export const PtyBridgeProtocolVersion = 1;
export const PtyBridgeProtocolVersionSchema = z.literal(PtyBridgeProtocolVersion);

export const PtyHandoffKindSchema = z.enum(["agent", "aux"]);
export type PtyHandoffKind = z.infer<typeof PtyHandoffKindSchema>;

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
    identity: PtyHandoffIdentitySchema,
    scrollbackRef: nonEmptyStringSchema.optional(),
    ringComplete: z.boolean().optional(),
    /** Best-effort semantic snapshot path; absence degrades to scrollback replay. */
    screenSnapshotRef: nonEmptyStringSchema.optional(),
  })
  .strict();
export type PtyHandoffEntry = z.infer<typeof PtyHandoffEntrySchema>;

/** ptyId → entry; every field an adopter needs to rebind a parked bridge. */
export const PtyHandoffManifestSchema = z.record(nonEmptyStringSchema, PtyHandoffEntrySchema);
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
    v: z.literal(1),
    bridgePid: z.number().int().positive(),
    pid: z.number().int().positive(),
    controlSocket: nonEmptyStringSchema,
    command: nonEmptyStringSchema,
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
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
export type PtyScrollbackEvent = z.infer<typeof PtyScrollbackEventSchema>;

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
