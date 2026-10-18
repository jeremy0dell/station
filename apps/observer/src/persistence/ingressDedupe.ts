import type { SqlDatabase } from "../sqlite/driver.js";
import type { IngressDedupeKey } from "./types.js";

export function claimIngressDedupeKey(
  database: SqlDatabase,
  input: IngressDedupeKey & {
    eventId: string;
    createdAt: string;
  },
): boolean {
  const result = database
    .prepare(
      `
        INSERT OR IGNORE INTO hook_ingress_dedupe (kind, dedupe_id, event_id, created_at)
        VALUES (?, ?, ?, ?)
      `,
    )
    .run(input.kind, input.id, input.eventId, input.createdAt);
  return Number(result.changes) > 0;
}

export function pruneIngressDedupeKeysCreatedBefore(
  database: SqlDatabase,
  createdBefore: string,
  limit: number,
): number {
  const result = database
    .prepare(
      `
        DELETE FROM hook_ingress_dedupe
        WHERE rowid IN (SELECT rowid FROM hook_ingress_dedupe WHERE created_at < ? LIMIT ?)
      `,
    )
    .run(createdBefore, limit);
  return Number(result.changes);
}
