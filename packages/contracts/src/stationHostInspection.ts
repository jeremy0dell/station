import { z } from "zod";
import { SafeErrorSchema } from "./errors.js";
import { PtyHandoffKindSchema, PtyInstanceIdSchema } from "./hostHandoff.js";
import {
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TerminalTargetIdSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { compareCodeUnitStrings, nonEmptyStringSchema } from "./shared.js";
import { StationBuildIdentitySchema } from "./stationBuildIdentity.js";
/** Sole current Station Host protocol discriminator; raw health alone may parse another integer. */
export const HOST_PROTOCOL_VERSION = 8;
export const StationHostProtocolVersionSchema = z.literal(HOST_PROTOCOL_VERSION);
/** Configured Unix-socket path and its physical lifetime identity. */
export const StationHostEndpointSchema = z
  .object({
    socketPath: nonEmptyStringSchema,
    ino: z.bigint().positive(),
    birthtimeNs: z.bigint().nonnegative(),
  })
  .strict();
/** Strict current health retained around the single recovery-inventory read. */
export const StationHostInspectedHealthSchema = z
  .object({
    ok: z.literal(true),
    protocolVersion: StationHostProtocolVersionSchema,
    buildVersion: nonEmptyStringSchema,
  })
  .strict();
export type StationHostInspectedHealth = z.infer<typeof StationHostInspectedHealthSchema>;
export const StationHostHandoffSupportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bridge-releasable") }).strict(),
  z
    .object({
      kind: z.literal("non-releasable"),
      reason: z.enum(["no-bridge-transport", "orphan-mode-disabled", "release-unsupported"]),
    })
    .strict(),
]);
/** Complete immutable/current facts for one Host PTY lifetime. */
export const StationHostTerminalLifetimeSchema = z
  .object({
    kind: PtyHandoffKindSchema,
    terminalTargetId: TerminalTargetIdSchema,
    ptyId: nonEmptyStringSchema,
    ptyInstanceId: PtyInstanceIdSchema,
    worktreeId: WorktreeIdSchema,
    projectId: ProjectIdSchema,
    sessionId: SessionIdSchema,
    worktreePath: nonEmptyStringSchema,
    harnessProvider: ProviderIdSchema,
    pid: z.number().int().positive(),
    alive: z.boolean(),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    handoffSupport: StationHostHandoffSupportSchema,
  })
  .strict();
export type StationHostTerminalLifetime = z.infer<typeof StationHostTerminalLifetimeSchema>;
type StationHostTerminalLifetimeIdentity = Pick<
  StationHostTerminalLifetime,
  "terminalTargetId" | "ptyId" | "ptyInstanceId"
>;
/** Orders only the three fields that identify one physical Host terminal lifetime. */
export function compareStationHostTerminalLifetimeIdentity(
  left: StationHostTerminalLifetimeIdentity,
  right: StationHostTerminalLifetimeIdentity,
): number {
  return (
    compareCodeUnitStrings(left.terminalTargetId, right.terminalTargetId) ||
    compareCodeUnitStrings(left.ptyId, right.ptyId) ||
    compareCodeUnitStrings(left.ptyInstanceId, right.ptyInstanceId)
  );
}
/** Requires independent lifetime identifiers plus deterministic tuple order. */
export function stationHostTerminalLifetimeIdentitiesAreCanonical(
  terminals: readonly StationHostTerminalLifetimeIdentity[],
): boolean {
  const keys = ["terminalTargetId", "ptyId", "ptyInstanceId"] as const;
  return (
    keys.every(
      (key) => new Set(terminals.map((terminal) => terminal[key])).size === terminals.length,
    ) &&
    terminals.every((terminal, index) => {
      const previous = terminals[index - 1];
      return (
        previous === undefined || compareStationHostTerminalLifetimeIdentity(previous, terminal) < 0
      );
    })
  );
}
export const StationHostTerminalLifetimesSchema = z
  .array(StationHostTerminalLifetimeSchema)
  .superRefine((terminals, context) => {
    if (!stationHostTerminalLifetimeIdentitiesAreCanonical(terminals)) {
      context.addIssue({
        code: "custom",
        message: "Host terminal lifetime identities must be unique and canonical.",
      });
    }
  });
/** Correlated current Host evidence; it is read-only and grants no lifecycle authority. */
export const StationHostExactEvidenceSchema = z
  .object({
    endpoint: StationHostEndpointSchema,
    health: StationHostInspectedHealthSchema,
    buildIdentity: StationBuildIdentitySchema,
    terminals: StationHostTerminalLifetimesSchema,
  })
  .strict();
/** Unversioned current-only Host inspection outcome. */
export const StationHostInspectionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }).strict(),
  z.object({ status: z.literal("stale"), endpoint: StationHostEndpointSchema }).strict(),
  z.object({ status: z.literal("inaccessible"), error: SafeErrorSchema }).strict(),
  z
    .object({
      status: z.literal("unknown"),
      reason: z.enum(["endpoint-drift", "health-failed", "health-drift", "inventory-failed"]),
      error: SafeErrorSchema,
    })
    .strict(),
  z.object({ status: z.literal("exact"), evidence: StationHostExactEvidenceSchema }).strict(),
]);
export type StationHostInspectionResult = z.infer<typeof StationHostInspectionResultSchema>;
