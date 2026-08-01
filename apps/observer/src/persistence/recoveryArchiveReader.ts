import type { SessionRecoveryHandle } from "@station/contracts";
import { openSqlDatabase } from "../sqlite/driver.js";
import { listSessionRecoveryHandles } from "./sessionRecoveryHandles.js";

/**
 * ADAPTER
 *
 * Reads typed recovery identities from an offline Observer backup while keeping
 * SQLite rows and queries inside the persistence adapter boundary.
 */
export function readSessionRecoveryHandlesFromBackup(
  databasePath: string,
): SessionRecoveryHandle[] {
  const database = openSqlDatabase(databasePath);
  try {
    return listSessionRecoveryHandles(database);
  } finally {
    database.close();
  }
}
