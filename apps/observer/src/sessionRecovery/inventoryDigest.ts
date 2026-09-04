import { createHash } from "node:crypto";
import type { ObserverRecoveryInventory } from "@station/contracts";
import type { ObserverRecoveryInventoryPersistenceSnapshot } from "../persistence/types.js";
import { observerRecoveryInventoryFromPersistence } from "./inventory.js";

/** POLICY: derives the public recovery-inventory digest from one coherent private snapshot. */
export function recoveryInventoryDigest(
  snapshot: ObserverRecoveryInventoryPersistenceSnapshot,
): string {
  const inventory = observerRecoveryInventoryFromPersistence(snapshot);
  return recoveryInventoryPublicDigest(inventory);
}

export function recoveryInventoryPublicDigest(inventory: ObserverRecoveryInventory): string {
  return createHash("sha256")
    .update("station-recovery-inventory-v1\0")
    .update(JSON.stringify(inventory))
    .digest("hex");
}
