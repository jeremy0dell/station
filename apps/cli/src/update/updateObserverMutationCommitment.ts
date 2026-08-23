import { closeSync, readSync } from "node:fs";
import {
  compareCodeUnitStrings,
  ObserverProcessTokenSchema,
  parseStationObserverBuildIdentity,
  SessionIdSchema,
  UpdateArtifactSchema,
} from "@station/contracts";
import { z } from "zod";
import type { UpdateConvergencePrivateEvidence } from "./recoveryPreflight.js";

export const UPDATE_OBSERVER_MUTATION_FD = 3;
export const UPDATE_OBSERVER_MUTATION_MAX_BYTES = 32 * 1024;

const observerOwnerSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }).strict(),
  z
    .object({
      status: z.literal("incumbent"),
      pid: z.number().int().positive(),
      osStartTime: z.string().min(1),
      processToken: ObserverProcessTokenSchema,
      buildSelector: z.string().min(1),
      socketPath: z.string().min(1),
    })
    .strict(),
]);

const selectedRecoveryHandleSchema = z
  .object({
    sessionId: SessionIdSchema,
    selectedHandleId: z.string().min(1),
  })
  .strict();

export const UpdateObserverMutationCommitmentSchema = z
  .object({
    kind: z.literal("station-update-observer-mutation"),
    action: z.enum(["start", "restart"]),
    target: UpdateArtifactSchema,
    targetBuildSelector: z.string().min(1),
    socketPath: z.string().min(1),
    owner: observerOwnerSchema,
    selectedRecoveryHandles: z.array(selectedRecoveryHandleSchema),
    planDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    nonce: z.string().uuid(),
  })
  .strict()
  .superRefine((commitment, context) => {
    const selectedBuild = parseStationObserverBuildIdentity(commitment.targetBuildSelector);
    if (
      selectedBuild.version !== commitment.target.version ||
      selectedBuild.buildIdentity === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["targetBuildSelector"],
        message: "Observer mutation requires the selected target's exact immutable build selector.",
      });
    }
    if (
      commitment.owner.status === "incumbent" &&
      commitment.owner.socketPath !== commitment.socketPath
    ) {
      context.addIssue({
        code: "custom",
        path: ["owner", "socketPath"],
        message: "Observer owner and mutation socket commitments must match exactly.",
      });
    }
    const selectedHandleIds = new Set<string>();
    commitment.selectedRecoveryHandles.forEach((handle, index) => {
      const previous = commitment.selectedRecoveryHandles[index - 1];
      if (
        previous !== undefined &&
        compareCodeUnitStrings(previous.sessionId, handle.sessionId) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["selectedRecoveryHandles", index],
          message: "Selected Observer recovery handles must be unique and canonically ordered.",
        });
      }
      if (selectedHandleIds.has(handle.selectedHandleId)) {
        context.addIssue({
          code: "custom",
          path: ["selectedRecoveryHandles", index, "selectedHandleId"],
          message: "A selected Observer recovery handle may authorize only one session.",
        });
      }
      selectedHandleIds.add(handle.selectedHandleId);
    });
  });

export type UpdateObserverMutationCommitment = z.infer<
  typeof UpdateObserverMutationCommitmentSchema
>;

export type UpdateObserverMutationPlan = Omit<UpdateObserverMutationCommitment, "kind" | "nonce">;
export type UpdateObserverMutationRequest = Omit<
  UpdateObserverMutationPlan,
  "socketPath" | "targetBuildSelector"
>;

/** Encodes one strict private mutation commitment for its one-shot inherited descriptor. */
export function encodeUpdateObserverMutationCommitment(
  commitment: UpdateObserverMutationCommitment,
): string {
  return JSON.stringify(UpdateObserverMutationCommitmentSchema.parse(commitment));
}

/** Reads exactly one bounded strict commitment and closes the inherited descriptor before mutation. */
export function readUpdateObserverMutationCommitment(
  fd = UPDATE_OBSERVER_MUTATION_FD,
): UpdateObserverMutationCommitment {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = Buffer.allocUnsafe(
        Math.min(4096, UPDATE_OBSERVER_MUTATION_MAX_BYTES + 1 - bytes),
      );
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > UPDATE_OBSERVER_MUTATION_MAX_BYTES) {
        throw new Error("Observer mutation commitment exceeded its byte bound.");
      }
      chunks.push(chunk.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  const serialized = Buffer.concat(chunks).toString("utf8");
  const parsed = UpdateObserverMutationCommitmentSchema.parse(JSON.parse(serialized));
  if (JSON.stringify(parsed) !== serialized) {
    throw new Error("Observer mutation commitment contained extra or non-canonical bytes.");
  }
  return parsed;
}

export function observerMutationPrivateEvidenceMatches(
  commitment: Pick<UpdateObserverMutationCommitment, "owner" | "selectedRecoveryHandles">,
  publicObserverStatus: "absent" | "exact" | "unknown",
  actual: UpdateConvergencePrivateEvidence,
): boolean {
  if (commitment.owner.status === "absent") {
    if (publicObserverStatus !== "absent" || actual.observer !== undefined) return false;
  } else {
    const owner = actual.observer;
    if (
      (publicObserverStatus !== "exact" && publicObserverStatus !== "unknown") ||
      owner === undefined ||
      commitment.owner.pid !== owner.pid ||
      commitment.owner.osStartTime !== owner.osStartTime ||
      commitment.owner.processToken !== owner.processToken ||
      commitment.owner.buildSelector !== owner.buildSelector ||
      commitment.owner.socketPath !== owner.socketPath
    ) {
      return false;
    }
  }
  return (
    commitment.selectedRecoveryHandles.length === actual.selectedRecoveryHandles.length &&
    commitment.selectedRecoveryHandles.every((handle, index) => {
      const candidate = actual.selectedRecoveryHandles[index];
      return (
        candidate !== undefined &&
        candidate.sessionId === handle.sessionId &&
        candidate.selectedHandleId === handle.selectedHandleId
      );
    })
  );
}
