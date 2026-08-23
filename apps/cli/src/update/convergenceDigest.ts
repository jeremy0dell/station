import { createHash } from "node:crypto";
import {
  type UpdateConvergenceDigest,
  type UpdateConvergencePlan,
  UpdateConvergencePlanSchema,
  type UpdateReapRecoveryPreflight,
} from "@station/contracts";
import type { UpdateConvergencePlanDraft } from "./convergencePlan.js";
import type { UpdateConvergencePrivateEvidence } from "./recoveryPreflight.js";

type CanonicalValue = string | number | boolean | null | CanonicalValue[] | CanonicalRecord;
type CanonicalRecord = { readonly [key: string]: CanonicalValue };

/**
 * POLICY
 *
 * Binds a public convergence plan to its redaction-safe aggregate and private ownership sidecar.
 * SHA-256 collision resistance is assumed; the digest reveals no private value and grants no
 * authority. #641 must independently authorize exact Station-owned process-group targets.
 */
export function attachUpdateConvergenceDigest(input: {
  draft: UpdateConvergencePlanDraft;
  preflight: UpdateReapRecoveryPreflight;
  privateEvidence: UpdateConvergencePrivateEvidence;
}): UpdateConvergencePlan {
  const digest = updateConvergenceDigest(input);
  return UpdateConvergencePlanSchema.parse({ ...input.draft, digest });
}

export function updateConvergenceDigest(input: {
  draft: UpdateConvergencePlanDraft;
  preflight: UpdateReapRecoveryPreflight;
  privateEvidence: UpdateConvergencePrivateEvidence;
}): UpdateConvergenceDigest {
  const canonical = canonicalDigestFacts(input);
  const value = createHash("sha256").update(encodeCanonical(canonical), "utf8").digest("hex");
  return { algorithm: "sha256", canonicalizationVersion: 1, value };
}

function canonicalDigestFacts(input: {
  draft: UpdateConvergencePlanDraft;
  preflight: UpdateReapRecoveryPreflight;
  privateEvidence: UpdateConvergencePrivateEvidence;
}): CanonicalValue {
  const { preflight, privateEvidence } = input;
  return {
    namespace: "station.update-convergence",
    canonicalizationVersion: 1,
    plan: canonicalPlan(input.draft),
    aggregate: {
      schemaVersion: preflight.schemaVersion,
      installed: canonicalArtifact(preflight.installed),
      target: canonicalArtifact(preflight.target),
      observer: canonicalObserver(preflight.observer),
      host: canonicalHost(preflight.host),
      hookProviderIds: preflight.hookProviderIds,
      hooks: preflight.hooks.map(canonicalHook),
      terminalDispositions: preflight.terminalDispositions.map((terminal) => ({
        terminalTargetId: terminal.terminalTargetId,
        ptyId: terminal.ptyId,
        ptyInstanceId: terminal.ptyInstanceId,
        sessionId: terminal.sessionId,
        handoff: terminal.handoff,
        reapRecovery: terminal.reapRecovery,
        reasons: terminal.reasons,
      })),
    },
    privateOwnership:
      privateEvidence.observer === undefined
        ? { status: "absent" }
        : { status: "exact", ...privateEvidence.observer },
    selectedStationRecoveryHandles: [...privateEvidence.selectedRecoveryHandles]
      .sort((left, right) => compareTuple(left, right))
      .map((handle) => ({
        sessionId: handle.sessionId,
        selectedHandleId: handle.selectedHandleId,
      })),
  };
}

function canonicalPlan(plan: UpdateConvergencePlanDraft): CanonicalValue {
  return {
    schemaVersion: plan.schemaVersion,
    selectedTarget: {
      artifact: canonicalArtifact(plan.selectedTarget.artifact),
      buildIdentity:
        plan.selectedTarget.buildIdentity.status === "known"
          ? {
              status: "known",
              value: plan.selectedTarget.buildIdentity.value,
            }
          : { status: "not-yet-provable" },
    },
    status: plan.status,
    components: plan.components as unknown as CanonicalRecord,
    phases: plan.phases as unknown as CanonicalValue[],
  };
}

function canonicalArtifact(artifact: { version: string; revision?: string }): CanonicalValue {
  return {
    version: artifact.version,
    revision: artifact.revision ?? null,
  };
}

function canonicalObserver(observer: UpdateReapRecoveryPreflight["observer"]): CanonicalValue {
  if (observer.status === "absent") return { status: "absent" };
  if (observer.status === "unknown") {
    return { status: "unknown", reason: observer.reason, errorCode: observer.error.code };
  }
  return {
    status: "exact",
    buildVersion: observer.buildVersion,
    relation: observer.relation,
    health: observer.health,
    recovery:
      observer.recovery.status === "unknown"
        ? {
            status: "unknown",
            reason: observer.recovery.reason,
            errorCode: observer.recovery.error.code,
          }
        : {
            status: "assessed",
            resumeEnabled: observer.recovery.assessment.resumeEnabled,
            providerCapabilities: observer.recovery.assessment.providerCapabilities,
            sessions: observer.recovery.assessment.sessions,
          },
  } as unknown as CanonicalValue;
}

function canonicalHost(host: UpdateReapRecoveryPreflight["host"]): CanonicalValue {
  if (host.status === "absent") return { status: "absent" };
  if (host.status === "unknown") {
    return { status: "unknown", reason: host.reason, errorCode: host.error.code };
  }
  return {
    status: "inspected",
    buildVersion: host.buildVersion ?? null,
    buildIdentity: host.buildIdentity ?? null,
    protocolVersion: host.protocolVersion,
    relation: host.relation,
    compatibility: host.compatibility,
    terminals: host.terminals,
  } as unknown as CanonicalValue;
}

function canonicalHook(hook: UpdateReapRecoveryPreflight["hooks"][number]): CanonicalValue {
  switch (hook.status) {
    case "configured-disabled":
      return { provider: hook.provider, status: hook.status, followUp: hook.followUp.action };
    case "unsupported":
    case "healthy":
      return { provider: hook.provider, status: hook.status };
    case "needs-repair":
      return { provider: hook.provider, status: hook.status, reason: hook.reason };
    case "ownership-conflict":
      return {
        provider: hook.provider,
        status: hook.status,
        ownership: hook.ownership,
        followUp: hook.followUp.action,
      };
    case "inspection-failed":
      return {
        provider: hook.provider,
        status: hook.status,
        errorCode: hook.error.code,
        followUp: hook.followUp.action,
      };
  }
}

// Length-prefixed scalar encoding plus code-unit-sorted keys prevents delimiter and key-order
// ambiguity. Well-formed Unicode keeps the UTF-16 domain injective when Node hashes UTF-8. This is
// intentionally versioned; never replace it with ambient JSON serialization.
function encodeCanonical(value: CanonicalValue): string {
  if (value === null) return "n";
  if (typeof value === "string") return encodeCanonicalString(value);
  if (typeof value === "number") return `d${String(value).length}:${String(value)}`;
  if (typeof value === "boolean") return value ? "b1" : "b0";
  if (Array.isArray(value)) return `a${value.length}:${value.map(encodeCanonical).join("")}`;
  const entries = Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right));
  return `o${entries.length}:${entries
    .map(([key, entry]) => `${encodeCanonical(key)}${encodeCanonical(entry)}`)
    .join("")}`;
}

function encodeCanonicalString(value: string): string {
  const utf8 = Buffer.from(value, "utf8");
  if (utf8.toString("utf8") !== value) {
    throw new TypeError("Update convergence digest facts must use well-formed Unicode.");
  }
  return `s${value.length}:${value}`;
}

function compareTuple(
  left: { sessionId: string; selectedHandleId: string },
  right: { sessionId: string; selectedHandleId: string },
): number {
  return (
    compareCodeUnits(left.sessionId, right.sessionId) ||
    compareCodeUnits(left.selectedHandleId, right.selectedHandleId)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
