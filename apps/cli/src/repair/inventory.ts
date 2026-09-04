import { createHash } from "node:crypto";
import type {
  ObserverRecoveryAssessment,
  RepairInventory,
  SafeError,
  UpdateReapRecoveryPreflight,
} from "@station/contracts";
import { RepairInventorySchema } from "@station/contracts";
import { recoveryInventoryPublicDigest } from "@station/observer/internal";
import { publicSafeErrorFromUnknown } from "@station/runtime";

export const repairInventoryPrivateEvidence = Symbol("station.repair.inventory.private-evidence");
export type RepairInventoryPrivateEvidence = Readonly<{
  runtime?: UpdateReapRecoveryPreflight;
}>;

export type RepairInventoryDeps = {
  configuredStateScopeDigest: string;
  inspectRuntime(): Promise<UpdateReapRecoveryPreflight>;
  inspectRecovery(): Promise<ObserverRecoveryAssessment>;
};

/** USE CASE: settles independent read-only runtime and recovery inventory sections. */
export async function inspectRepairInventory(deps: RepairInventoryDeps): Promise<RepairInventory> {
  const [runtimeResult, recoveryResult] = await Promise.allSettled([
    deps.inspectRuntime(),
    deps.inspectRecovery(),
  ]);
  const runtime =
    runtimeResult.status === "fulfilled"
      ? ({ status: "available", preflight: runtimeResult.value } as const)
      : ({
          status: "unavailable",
          error: inventoryError(runtimeResult.reason, "runtime"),
        } as const);
  const recovery =
    recoveryResult.status === "fulfilled"
      ? ({
          status: "available",
          assessment: recoveryResult.value,
          recoveryInventoryDigest: recoveryInventoryPublicDigest(recoveryResult.value.inventory),
        } as const)
      : ({
          status: "unavailable",
          error: inventoryError(recoveryResult.reason, "recovery"),
        } as const);
  const semantic = {
    schemaVersion: 1 as const,
    configuredStateScopeDigest: deps.configuredStateScopeDigest,
    runtime,
    recovery,
  };
  const inventory = RepairInventorySchema.parse({
    ...semantic,
    repairInventoryDigest: digest("station-repair-inventory-v1", semantic),
  });
  Object.defineProperty(inventory, repairInventoryPrivateEvidence, {
    value: {
      ...(runtimeResult.status === "fulfilled" ? { runtime: runtimeResult.value } : {}),
    } satisfies RepairInventoryPrivateEvidence,
    enumerable: false,
  });
  return inventory;
}

export function repairInventoryEvidence(
  inventory: RepairInventory,
): RepairInventoryPrivateEvidence {
  return (
    (
      inventory as RepairInventory & {
        [repairInventoryPrivateEvidence]?: RepairInventoryPrivateEvidence;
      }
    )[repairInventoryPrivateEvidence] ?? {}
  );
}

export function configuredRepairStateScopeDigest(input: {
  stateDir: string;
  socketPath: string;
  databasePath: string;
  configPath?: string;
}): string {
  return digest("station-repair-configured-state-scope-v1", input);
}

export function repairDigest(domain: string, value: unknown): string {
  return digest(domain, value);
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0`)
    .update(JSON.stringify(canonicalDigestValue(value)))
    .digest("hex");
}

const excludedDigestKeys = new Set([
  "capturedAt",
  "detail",
  "diagnosticId",
  "hint",
  "lastCheckedAt",
  "message",
  "recoveryCommands",
  "traceId",
]);

function canonicalDigestValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalDigestValue);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (excludedDigestKeys.has(key)) continue;
    const member = (value as Record<string, unknown>)[key];
    if (member !== undefined) result[key] = canonicalDigestValue(member);
  }
  return result;
}

function inventoryError(error: unknown, section: "runtime" | "recovery"): SafeError {
  return publicSafeErrorFromUnknown(error, {
    tag: "RepairInventoryError",
    code: `REPAIR_${section.toUpperCase()}_INVENTORY_UNAVAILABLE`,
    message: `${section === "runtime" ? "Runtime" : "Recovery"} repair inventory is unavailable.`,
  });
}
