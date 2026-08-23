import { z } from "zod";
import {
  ProjectIdSchema,
  SessionIdSchema,
  TerminalTargetIdSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { compareCodeUnitStrings, nonEmptyStringSchema } from "./shared.js";

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

/** Canonical session-bound identity for one PTY lifetime across Host ownership changes. */
export const PtyLifetimeIdentitySchema = z
  .object({
    terminalTargetId: TerminalTargetIdSchema,
    ptyId: nonEmptyStringSchema,
    ptyInstanceId: PtyInstanceIdSchema,
    sessionId: SessionIdSchema,
  })
  .strict();
export type PtyLifetimeIdentity = z.infer<typeof PtyLifetimeIdentitySchema>;

export function comparePtyLifetimeIdentities(
  left: PtyLifetimeIdentity,
  right: PtyLifetimeIdentity,
): number {
  return (
    compareCodeUnitStrings(left.terminalTargetId, right.terminalTargetId) ||
    compareCodeUnitStrings(left.ptyId, right.ptyId) ||
    compareCodeUnitStrings(left.ptyInstanceId, right.ptyInstanceId) ||
    compareCodeUnitStrings(left.sessionId, right.sessionId)
  );
}

export function ptyLifetimeIdentitySetsMatch(
  left: readonly PtyLifetimeIdentity[],
  right: readonly PtyLifetimeIdentity[],
): boolean {
  return (
    left.length === right.length &&
    left.every((identity, index) => {
      const other = right[index];
      return other !== undefined && comparePtyLifetimeIdentities(identity, other) === 0;
    })
  );
}

export function ptyLifetimeIdentitiesStrictlySorted(
  identities: readonly PtyLifetimeIdentity[],
): boolean {
  return identities.every((identity, index) => {
    const previous = identities[index - 1];
    return previous === undefined || comparePtyLifetimeIdentities(previous, identity) < 0;
  });
}

/** Exact, deterministic ownership acknowledgement for one completed live handoff. */
export const PtyHandoffReceiptSchema = z
  .object({ terminals: z.array(PtyLifetimeIdentitySchema).min(1) })
  .strict()
  .superRefine((receipt, context) => {
    if (!ptyLifetimeIdentitiesStrictlySorted(receipt.terminals)) {
      context.addIssue({
        code: "custom",
        path: ["terminals"],
        message:
          "Handoff receipt terminals must be unique and sorted by session-bound immutable identity.",
      });
    }
  });
export type PtyHandoffReceipt = z.infer<typeof PtyHandoffReceiptSchema>;

/** Strict machine boundary returned by `stn host handoff --json`. */
export const HostHandoffCommandResultSchema = z
  .object({
    action: z.literal("handoff"),
    dryRun: z.boolean(),
    fidelity: HostHandoffFidelitySchema,
    socketPath: nonEmptyStringSchema,
    status: z.enum(["planned", "completed", "refused", "unavailable"]),
    message: nonEmptyStringSchema,
    livePtyCount: z.number().int().nonnegative().optional(),
    receipt: PtyHandoffReceiptSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.receipt !== undefined) {
      if (
        result.status !== "completed" ||
        result.dryRun ||
        result.livePtyCount !== result.receipt.terminals.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["receipt"],
          message: "A handoff receipt requires a completed mutation and its exact terminal count.",
        });
      }
    }
  });
export type HostHandoffCommandResult = z.infer<typeof HostHandoffCommandResultSchema>;

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

/** ptyId to entry; every field an adopter needs to rebind a parked bridge. */
export const PtyHandoffManifestSchema = z
  .record(nonEmptyStringSchema, PtyHandoffEntrySchema)
  .superRefine((manifest, context) => {
    const targets = new Set<string>();
    for (const [ptyId, entry] of Object.entries(manifest)) {
      if (targets.has(entry.identity.terminalTargetId)) {
        context.addIssue({
          code: "custom",
          path: [ptyId, "identity", "terminalTargetId"],
          message: "A handoff manifest cannot contain duplicate terminal targets.",
        });
      }
      targets.add(entry.identity.terminalTargetId);
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
export type PtyBridgeAdoptCommand = z.infer<typeof PtyBridgeAdoptCommandSchema>;

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
