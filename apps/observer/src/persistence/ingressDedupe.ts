import type { DatabaseSync } from "node:sqlite";
import type { IngressDedupeKey } from "./types.js";

export function claimIngressDedupeKey(
  database: DatabaseSync,
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
